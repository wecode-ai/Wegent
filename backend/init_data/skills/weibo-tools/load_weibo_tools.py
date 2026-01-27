# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Load Weibo MCP tools dynamically.

This module provides the LoadWeiboToolsTool class that enables on-demand
loading of Weibo MCP (Model Context Protocol) tools from configured servers.

The key design principle is "lazy loading" - Weibo MCP tools are only connected
and loaded when the LLM determines they are needed (e.g., when user asks about
Weibo content, hot search, user info, comments, etc.), avoiding the overhead
of sending all tool schemas to the LLM upfront.

Supported Weibo MCP Services:
- Weibo Status: Query weibo content by ID or user
- Weibo User: Get user profile information
- Weibo Comments: Query comments data
- Weibo Search: Get hot search list and topics
- Wegent Fetch: Fetch weibo content by URL

Architecture:
1. load_weibo_tools: Connects to Weibo MCP servers and loads available tools
2. invoke_weibo_tool: Proxy tool to call loaded Weibo tools by name
3. PromptModifierTool: Injects loaded tool descriptions into system prompt
"""

import asyncio
import json
import logging
from typing import Any, Optional

from langchain_core.callbacks import CallbackManagerForToolRun
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field, PrivateAttr

from chat_shell.core.config import settings

logger = logging.getLogger(__name__)


class LoadWeiboToolsInput(BaseModel):
    """Input schema for load_weibo_tools tool."""

    server_names: Optional[list[str]] = Field(
        default=None,
        description="可选的微博服务列表。不提供则加载所有已配置的微博服务。"
        "可用服务包括: weibo-status, weibo-user, weibo-comments, weibo-search, wegent-fetch",
    )


class InvokeWeiboToolInput(BaseModel):
    """Input schema for invoke_weibo_tool tool."""

    tool_name: str = Field(description="要调用的微博工具名称")
    arguments: dict[str, Any] = Field(
        default_factory=dict,
        description="传递给微博工具的参数",
    )


class LoadWeiboToolsTool(BaseTool):
    """Tool to dynamically load Weibo MCP tools from configured servers.

    This tool implements on-demand Weibo MCP tool loading:
    1. Connects to Weibo MCP servers configured in CHAT_MCP_SERVERS
    2. Discovers available tools from each server
    3. Makes tools available for invocation via invoke_weibo_tool

    The tool also implements PromptModifierTool protocol to inject
    loaded tool descriptions into the system prompt, enabling the LLM
    to understand what tools are available after loading.

    Supported Weibo services:
    - Weibo Status: Query weibo content by ID or user
    - Weibo User: Get user profile information
    - Weibo Comments: Query comments data
    - Weibo Search: Get hot search list and topics
    - Wegent Fetch: Fetch weibo content by URL

    Session-level state:
    - Tools are loaded once per conversation turn
    - Subsequent calls return cached tool information
    - State is managed at the tool instance level
    """

    name: str = "load_weibo_tools"
    display_name: str = "加载微博工具"
    description: str = (
        "加载微博平台数据查询工具。当需要查询微博内容、用户信息、评论、热搜等数据时调用此工具。"
        "加载后，使用 invoke_weibo_tool 调用具体的微博工具。"
    )
    args_schema: type[BaseModel] = LoadWeiboToolsInput

    # Configuration
    task_id: int
    subtask_id: int
    user_id: int
    timeout: float = 60.0

    # Private state for loaded tools (session-level)
    _mcp_client: Any = PrivateAttr(default=None)
    _loaded_tools: dict[str, BaseTool] = PrivateAttr(default_factory=dict)
    _tool_descriptions: dict[str, str] = PrivateAttr(default_factory=dict)
    _is_loaded: bool = PrivateAttr(default=False)

    def __init__(self, **data):
        """Initialize with fresh state."""
        super().__init__(**data)
        self._mcp_client = None
        self._loaded_tools = {}
        self._tool_descriptions = {}
        self._is_loaded = False

    def _run(
        self,
        server_names: Optional[list[str]] = None,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Synchronous wrapper for async Weibo MCP loading."""
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                # We're already in an async context, create a new task
                import concurrent.futures

                with concurrent.futures.ThreadPoolExecutor() as executor:
                    future = executor.submit(
                        asyncio.run, self._async_load(server_names)
                    )
                    return future.result(timeout=self.timeout)
            else:
                return loop.run_until_complete(self._async_load(server_names))
        except Exception as e:
            logger.exception("[LoadWeiboToolsTool] Error loading Weibo tools")
            return f"加载微博工具时出错: {e}"

    async def _arun(
        self,
        server_names: Optional[list[str]] = None,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Load Weibo MCP tools asynchronously."""
        return await self._async_load(server_names)

    async def _async_load(self, server_names: Optional[list[str]] = None) -> str:
        """Core async logic for loading Weibo MCP tools."""
        # Check if already loaded
        if self._is_loaded and self._loaded_tools:
            tool_list = self._format_tool_list()
            return (
                f"微博工具已加载。可用工具:\n\n{tool_list}\n\n"
                "使用 invoke_weibo_tool 调用这些工具。"
            )

        # Parse MCP servers configuration
        mcp_servers_config = getattr(settings, "CHAT_MCP_SERVERS", "")
        if not mcp_servers_config:
            logger.warning("[LoadWeiboToolsTool] No CHAT_MCP_SERVERS configured")
            return (
                "未配置微博 MCP 服务。请确保 CHAT_MCP_SERVERS 环境变量已正确设置。"
            )

        try:
            config_data = json.loads(mcp_servers_config)
            servers = config_data.get("mcpServers", config_data)
        except json.JSONDecodeError as e:
            logger.error(
                "[LoadWeiboToolsTool] Failed to parse CHAT_MCP_SERVERS: %s", e
            )
            return f"解析微博服务配置时出错: {e}"

        if not servers:
            return "配置中未找到微博 MCP 服务。"

        # Filter servers if specific names requested
        if server_names:
            servers = {k: v for k, v in servers.items() if k in server_names}
            if not servers:
                available = list(config_data.get("mcpServers", config_data).keys())
                return (
                    f"请求的服务 ({server_names}) 未配置。"
                    f"可用服务: {available}"
                )

        logger.info(
            "[LoadWeiboToolsTool] Loading Weibo tools from servers: %s",
            list(servers.keys()),
        )

        try:
            # Import MCPClient
            from chat_shell.tools.mcp import MCPClient

            # Create and connect MCP client
            self._mcp_client = MCPClient(servers)
            await asyncio.wait_for(self._mcp_client.connect(), timeout=self.timeout)

            # Get loaded tools
            tools = self._mcp_client.get_tools()

            if not tools:
                return (
                    "已连接到微博服务但未发现可用工具。"
                    "服务可能未正确配置或暂时不可用。"
                )

            # Store tools for later invocation
            for tool in tools:
                tool_name = getattr(tool, "name", "unknown")
                self._loaded_tools[tool_name] = tool
                self._tool_descriptions[tool_name] = getattr(
                    tool, "description", "无描述"
                )

            self._is_loaded = True

            tool_list = self._format_tool_list()

            logger.info(
                "[LoadWeiboToolsTool] Successfully loaded %d Weibo tools: %s",
                len(self._loaded_tools),
                list(self._loaded_tools.keys()),
            )

            return (
                f"成功加载 {len(self._loaded_tools)} 个微博工具:\n\n"
                f"{tool_list}\n\n"
                "使用 invoke_weibo_tool 并传入工具名称和参数来调用这些工具。"
            )

        except asyncio.TimeoutError:
            logger.error(
                "[LoadWeiboToolsTool] Timeout connecting to Weibo MCP servers "
                "(timeout=%s)",
                self.timeout,
            )
            return (
                f"连接微博服务超时（{self.timeout}秒）。请检查服务可用性。"
            )
        except Exception as e:
            logger.exception("[LoadWeiboToolsTool] Error connecting to Weibo MCP servers")
            return f"连接微博服务时出错: {e}"

    def _format_tool_list(self) -> str:
        """Format loaded tools as a readable list."""
        lines = []
        for name, desc in self._tool_descriptions.items():
            # Truncate long descriptions
            if len(desc) > 200:
                desc = desc[:197] + "..."
            lines.append(f"- **{name}**: {desc}")
        return "\n".join(lines)

    def get_prompt_modification(self) -> str:
        """Get prompt modification content for system prompt injection.

        This method implements the PromptModifierTool protocol, allowing
        the agent builder to automatically detect and inject loaded tool
        information into the system prompt.

        Returns:
            String content describing available Weibo tools, or empty string if none loaded
        """
        if not self._is_loaded or not self._loaded_tools:
            return ""

        tool_list = self._format_tool_list()

        return f"""

# 已加载的微博工具

以下微博工具已加载，可供使用:

{tool_list}

## 使用方法

调用 `invoke_weibo_tool` 并传入工具名称和参数来使用这些工具。

示例:
```json
{{
  "name": "invoke_weibo_tool",
  "arguments": {{
    "tool_name": "工具名称",
    "arguments": {{
      "参数名": "参数值"
    }}
  }}
}}
```
"""

    async def invoke_tool(self, tool_name: str, arguments: dict[str, Any]) -> str:
        """Invoke a loaded Weibo MCP tool.

        Args:
            tool_name: Name of the tool to invoke
            arguments: Arguments to pass to the tool

        Returns:
            Tool execution result as string
        """
        if not self._is_loaded:
            return "错误: 微博工具未加载。请先调用 load_weibo_tools。"

        tool = self._loaded_tools.get(tool_name)
        if not tool:
            available = list(self._loaded_tools.keys())
            return (
                f"错误: 工具 '{tool_name}' 未找到。"
                f"可用工具: {available}"
            )

        try:
            # Check if tool supports async
            if hasattr(tool, "_arun"):
                result = await tool._arun(**arguments)
            elif hasattr(tool, "ainvoke"):
                result = await tool.ainvoke(arguments)
            else:
                result = tool._run(**arguments)

            return str(result)

        except Exception as e:
            logger.exception(
                "[LoadWeiboToolsTool] Error invoking Weibo tool '%s'", tool_name
            )
            return f"调用工具 '{tool_name}' 时出错: {e}"

    def get_tool_schema(self, tool_name: str) -> Optional[dict[str, Any]]:
        """Get the schema for a specific loaded tool.

        Args:
            tool_name: Name of the tool

        Returns:
            Tool schema dict or None if not found
        """
        tool = self._loaded_tools.get(tool_name)
        if not tool:
            return None

        # Extract schema from tool
        if hasattr(tool, "args_schema") and tool.args_schema:
            return tool.args_schema.model_json_schema()
        return None


class InvokeWeiboToolTool(BaseTool):
    """Proxy tool to invoke loaded Weibo MCP tools.

    This tool acts as a gateway to call any Weibo MCP tool that was previously
    loaded via load_weibo_tools. It enables the LLM to use Weibo tools without
    requiring them to be pre-registered in the agent's tool list.
    """

    name: str = "invoke_weibo_tool"
    display_name: str = "调用微博工具"
    description: str = (
        "调用已加载的微博工具。必须先调用 load_weibo_tools 加载可用工具。"
        "传入工具名称和参数来执行微博数据查询操作。"
    )
    args_schema: type[BaseModel] = InvokeWeiboToolInput

    # Reference to the load_weibo_tools instance
    load_weibo_tools_ref: LoadWeiboToolsTool

    def _run(
        self,
        tool_name: str,
        arguments: dict[str, Any] | None = None,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Synchronous wrapper for async tool invocation."""
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                import concurrent.futures

                with concurrent.futures.ThreadPoolExecutor() as executor:
                    future = executor.submit(
                        asyncio.run,
                        self.load_weibo_tools_ref.invoke_tool(
                            tool_name, arguments or {}
                        ),
                    )
                    return future.result(timeout=60.0)
            else:
                return loop.run_until_complete(
                    self.load_weibo_tools_ref.invoke_tool(tool_name, arguments or {})
                )
        except Exception as e:
            logger.exception(
                "[InvokeWeiboToolTool] Error invoking tool '%s'", tool_name
            )
            return f"调用工具时出错: {e}"

    async def _arun(
        self,
        tool_name: str,
        arguments: dict[str, Any] | None = None,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Invoke Weibo MCP tool asynchronously."""
        return await self.load_weibo_tools_ref.invoke_tool(tool_name, arguments or {})
