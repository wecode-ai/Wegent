# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Load Weibo MCP tools with three-phase lazy loading.

This module implements a token-efficient approach to loading Weibo MCP tools:

Phase 1 (MCP Discovery): list_weibo_mcps
    - Returns list of available Weibo MCP servers with brief descriptions
    - NO connection made, NO tools loaded
    - Minimal token usage (~200 tokens for 5 servers)

Phase 2 (Tool Discovery): load_weibo_mcp_tools
    - Connects to a SPECIFIC MCP server
    - Returns tools available from that server only
    - Moderate token usage (~50-100 tokens per server)

Phase 3 (Tool Invocation): invoke_weibo_tool
    - Calls a specific tool from a loaded MCP server
    - Returns tool execution result

This design ensures LLM only receives relevant tool information,
avoiding the overhead of loading all tools from all servers upfront.

Supported Weibo MCP Services:
- weibo-status: Query weibo content by ID or user
- weibo-user: Get user profile information
- weibo-comments: Query comments data
- weibo-search: Get hot search list and topics
- wegent-fetch: Fetch weibo content by URL
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


# =============================================================================
# Weibo MCP Server Catalog (Static, No Connection Required)
# =============================================================================

WEIBO_MCP_CATALOG: dict[str, dict[str, str]] = {
    "weibo-status": {
        "name": "weibo-status",
        "description": "微博内容查询服务。查询微博正文、转发、点赞数等信息。支持按微博ID查询单条微博，或按用户ID查询用户的微博列表。",
        "use_cases": "查看某条微博内容、获取用户发布的微博、分析微博互动数据",
    },
    "weibo-user": {
        "name": "weibo-user",
        "description": "微博用户信息服务。获取用户基本资料、粉丝数、关注数、认证信息等。",
        "use_cases": "查看用户主页信息、获取用户粉丝数据、验证用户身份",
    },
    "weibo-comments": {
        "name": "weibo-comments",
        "description": "微博评论查询服务。获取微博下的评论列表、评论详情、热门评论等。",
        "use_cases": "查看微博评论、分析评论情感、获取热门评论",
    },
    "weibo-search": {
        "name": "weibo-search",
        "description": "微博搜索和热搜服务。获取实时热搜榜、热门话题、搜索微博内容。",
        "use_cases": "查看热搜榜单、搜索特定话题、了解热门事件",
    },
    "wegent-fetch": {
        "name": "wegent-fetch",
        "description": "微博链接解析服务。通过微博URL直接获取微博内容，支持各种微博链接格式。",
        "use_cases": "解析微博链接、获取分享链接的内容、批量获取微博",
    },
}


# =============================================================================
# Input Schemas
# =============================================================================


class ListWeiboMCPsInput(BaseModel):
    """Input schema for list_weibo_mcps tool."""

    pass  # No input required


class LoadWeiboMCPToolsInput(BaseModel):
    """Input schema for load_weibo_mcp_tools tool."""

    server_name: str = Field(
        description="要加载的微博MCP服务名称。"
        "可用服务: weibo-status, weibo-user, weibo-comments, weibo-search, wegent-fetch"
    )


class InvokeWeiboToolInput(BaseModel):
    """Input schema for invoke_weibo_tool tool."""

    server_name: str = Field(description="MCP服务名称（从 load_weibo_mcp_tools 获取）")
    tool_name: str = Field(description="要调用的工具名称")
    arguments: dict[str, Any] = Field(
        default_factory=dict,
        description="传递给工具的参数",
    )


# =============================================================================
# Phase 1: List Available Weibo MCP Servers
# =============================================================================


class ListWeiboMCPsTool(BaseTool):
    """List available Weibo MCP servers without connecting.

    This is Phase 1 of the three-phase lazy loading approach.
    It returns a static catalog of available Weibo MCP servers,
    allowing the LLM to understand what services are available
    without any network connection or tool loading.

    Token Efficiency:
    - Returns ~200 tokens of server descriptions
    - No connection overhead
    - LLM can make informed decision about which server to load
    """

    name: str = "list_weibo_mcps"
    display_name: str = "列出微博MCP服务"
    description: str = (
        "列出可用的微博MCP服务列表。返回每个服务的名称、功能描述和使用场景。"
        "这是第一步，用于了解有哪些微博服务可用。"
        "确定需要的服务后，使用 load_weibo_mcp_tools 加载该服务的工具。"
    )
    args_schema: type[BaseModel] = ListWeiboMCPsInput

    # Configuration
    task_id: int
    subtask_id: int
    user_id: int

    def _run(
        self,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """List available Weibo MCP servers."""
        return self._list_mcps()

    async def _arun(
        self,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """List available Weibo MCP servers asynchronously."""
        return self._list_mcps()

    def _list_mcps(self) -> str:
        """Core logic to list available MCP servers."""
        # Get configured servers
        mcp_servers_config = getattr(settings, "CHAT_MCP_SERVERS", "")
        configured_servers: set[str] = set()

        if mcp_servers_config:
            try:
                config_data = json.loads(mcp_servers_config)
                servers = config_data.get("mcpServers", config_data)
                configured_servers = set(servers.keys())
            except json.JSONDecodeError:
                pass

        # Build response with catalog info
        lines = ["# 可用的微博MCP服务\n"]
        lines.append("以下是可用的微博数据查询服务：\n")

        available_count = 0
        for server_name, info in WEIBO_MCP_CATALOG.items():
            # Check if server is configured
            is_configured = server_name in configured_servers
            status = "✓" if is_configured else "✗ (未配置)"

            lines.append(f"## {info['name']} {status}")
            lines.append(f"**功能**: {info['description']}")
            lines.append(f"**适用场景**: {info['use_cases']}")
            lines.append("")

            if is_configured:
                available_count += 1

        lines.append("---")
        lines.append(f"共 {available_count} 个服务可用。")
        lines.append("")
        lines.append("**下一步**: 使用 `load_weibo_mcp_tools` 并传入服务名称来加载该服务的工具。")
        lines.append("例如: `load_weibo_mcp_tools(server_name='weibo-status')`")

        return "\n".join(lines)


# =============================================================================
# Phase 2: Load Tools from a Specific MCP Server
# =============================================================================


class LoadWeiboMCPToolsTool(BaseTool):
    """Load tools from a specific Weibo MCP server.

    This is Phase 2 of the three-phase lazy loading approach.
    It connects to ONE specific MCP server and returns the tools
    available from that server only.

    Token Efficiency:
    - Only loads tools from the requested server
    - Typical response: 50-100 tokens per server
    - Tools from other servers are NOT loaded
    """

    name: str = "load_weibo_mcp_tools"
    display_name: str = "加载微博MCP工具"
    description: str = (
        "加载指定微博MCP服务的工具列表。"
        "先使用 list_weibo_mcps 查看可用服务，然后用此工具加载所需服务的工具。"
        "加载后，使用 invoke_weibo_tool 调用具体工具。"
    )
    args_schema: type[BaseModel] = LoadWeiboMCPToolsInput

    # Configuration
    task_id: int
    subtask_id: int
    user_id: int
    timeout: float = 60.0

    # Shared state manager reference (set by provider)
    _state_manager: Any = PrivateAttr(default=None)

    def __init__(self, **data):
        """Initialize the tool."""
        super().__init__(**data)
        self._state_manager = None

    def set_state_manager(self, manager: "WeiboToolsStateManager") -> None:
        """Set the shared state manager."""
        self._state_manager = manager

    def _run(
        self,
        server_name: str,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Synchronous wrapper for async MCP tool loading."""
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                import concurrent.futures

                with concurrent.futures.ThreadPoolExecutor() as executor:
                    future = executor.submit(
                        asyncio.run, self._async_load(server_name)
                    )
                    return future.result(timeout=self.timeout)
            else:
                return loop.run_until_complete(self._async_load(server_name))
        except Exception as e:
            logger.exception(
                "[LoadWeiboMCPToolsTool] Error loading tools from %s", server_name
            )
            return f"加载 {server_name} 工具时出错: {e}"

    async def _arun(
        self,
        server_name: str,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Load MCP tools asynchronously."""
        return await self._async_load(server_name)

    async def _async_load(self, server_name: str) -> str:
        """Core async logic for loading tools from a specific MCP server."""
        if not self._state_manager:
            return "错误: 状态管理器未初始化。"

        # Validate server name
        if server_name not in WEIBO_MCP_CATALOG:
            available = list(WEIBO_MCP_CATALOG.keys())
            return (
                f"错误: 未知的服务 '{server_name}'。\n"
                f"可用服务: {', '.join(available)}"
            )

        # Check if already loaded
        if self._state_manager.is_server_loaded(server_name):
            tools = self._state_manager.get_server_tools(server_name)
            tool_list = self._format_tool_list(tools)
            return (
                f"服务 '{server_name}' 已加载。可用工具:\n\n{tool_list}\n\n"
                f"使用 invoke_weibo_tool 调用这些工具，需传入 server_name='{server_name}'。"
            )

        # Parse MCP servers configuration
        mcp_servers_config = getattr(settings, "CHAT_MCP_SERVERS", "")
        if not mcp_servers_config:
            return "错误: 未配置 CHAT_MCP_SERVERS 环境变量。"

        try:
            config_data = json.loads(mcp_servers_config)
            servers = config_data.get("mcpServers", config_data)
        except json.JSONDecodeError as e:
            return f"错误: 解析 MCP 配置失败: {e}"

        if server_name not in servers:
            return (
                f"错误: 服务 '{server_name}' 未在 CHAT_MCP_SERVERS 中配置。\n"
                f"已配置的服务: {', '.join(servers.keys())}"
            )

        # Connect to the specific server only
        server_config = {server_name: servers[server_name]}

        logger.info(
            "[LoadWeiboMCPToolsTool] Loading tools from server: %s", server_name
        )

        try:
            from chat_shell.tools.mcp import MCPClient

            # Create client for this specific server
            mcp_client = MCPClient(server_config)
            await asyncio.wait_for(mcp_client.connect(), timeout=self.timeout)

            # Get tools from this server
            tools = mcp_client.get_tools()

            if not tools:
                return (
                    f"已连接到 '{server_name}' 但未发现可用工具。\n"
                    "服务可能未正确配置或暂时不可用。"
                )

            # Store in state manager
            tool_info: dict[str, dict[str, Any]] = {}
            for tool in tools:
                tool_name = getattr(tool, "name", "unknown")
                tool_info[tool_name] = {
                    "tool": tool,
                    "description": getattr(tool, "description", "无描述"),
                }

            self._state_manager.register_server(server_name, mcp_client, tool_info)

            tool_list = self._format_tool_list(tool_info)

            logger.info(
                "[LoadWeiboMCPToolsTool] Loaded %d tools from %s: %s",
                len(tool_info),
                server_name,
                list(tool_info.keys()),
            )

            return (
                f"成功加载 '{server_name}' 的 {len(tool_info)} 个工具:\n\n"
                f"{tool_list}\n\n"
                f"使用 invoke_weibo_tool 调用这些工具，需传入:\n"
                f"- server_name: '{server_name}'\n"
                f"- tool_name: 工具名称\n"
                f"- arguments: 工具参数"
            )

        except asyncio.TimeoutError:
            logger.error(
                "[LoadWeiboMCPToolsTool] Timeout connecting to %s", server_name
            )
            return f"连接 '{server_name}' 超时（{self.timeout}秒）。请检查服务可用性。"
        except Exception as e:
            logger.exception(
                "[LoadWeiboMCPToolsTool] Error connecting to %s", server_name
            )
            return f"连接 '{server_name}' 时出错: {e}"

    def _format_tool_list(self, tools: dict[str, dict[str, Any]]) -> str:
        """Format tool list for display."""
        lines = []
        for name, info in tools.items():
            desc = info.get("description", "无描述")
            # Truncate long descriptions
            if len(desc) > 150:
                desc = desc[:147] + "..."
            lines.append(f"- **{name}**: {desc}")
        return "\n".join(lines)


# =============================================================================
# Phase 3: Invoke a Specific Tool
# =============================================================================


class InvokeWeiboToolTool(BaseTool):
    """Invoke a tool from a loaded Weibo MCP server.

    This is Phase 3 of the three-phase lazy loading approach.
    It calls a specific tool from a previously loaded MCP server.

    Prerequisites:
    1. list_weibo_mcps - to see available servers
    2. load_weibo_mcp_tools - to load tools from a server
    3. invoke_weibo_tool - to call a specific tool (this tool)
    """

    name: str = "invoke_weibo_tool"
    display_name: str = "调用微博工具"
    description: str = (
        "调用已加载的微博MCP工具。"
        "必须先使用 load_weibo_mcp_tools 加载对应服务的工具。"
        "需要传入 server_name（服务名）、tool_name（工具名）和 arguments（参数）。"
    )
    args_schema: type[BaseModel] = InvokeWeiboToolInput

    # Shared state manager reference
    _state_manager: Any = PrivateAttr(default=None)

    def __init__(self, **data):
        """Initialize the tool."""
        super().__init__(**data)
        self._state_manager = None

    def set_state_manager(self, manager: "WeiboToolsStateManager") -> None:
        """Set the shared state manager."""
        self._state_manager = manager

    def _run(
        self,
        server_name: str,
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
                        self._async_invoke(server_name, tool_name, arguments or {}),
                    )
                    return future.result(timeout=60.0)
            else:
                return loop.run_until_complete(
                    self._async_invoke(server_name, tool_name, arguments or {})
                )
        except Exception as e:
            logger.exception(
                "[InvokeWeiboToolTool] Error invoking %s.%s", server_name, tool_name
            )
            return f"调用工具时出错: {e}"

    async def _arun(
        self,
        server_name: str,
        tool_name: str,
        arguments: dict[str, Any] | None = None,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Invoke tool asynchronously."""
        return await self._async_invoke(server_name, tool_name, arguments or {})

    async def _async_invoke(
        self, server_name: str, tool_name: str, arguments: dict[str, Any]
    ) -> str:
        """Core async logic for tool invocation."""
        if not self._state_manager:
            return "错误: 状态管理器未初始化。"

        # Check if server is loaded
        if not self._state_manager.is_server_loaded(server_name):
            loaded = self._state_manager.get_loaded_servers()
            if loaded:
                return (
                    f"错误: 服务 '{server_name}' 未加载。\n"
                    f"已加载的服务: {', '.join(loaded)}\n"
                    f"请先使用 load_weibo_mcp_tools(server_name='{server_name}') 加载该服务。"
                )
            else:
                return (
                    f"错误: 服务 '{server_name}' 未加载。\n"
                    "请先使用 list_weibo_mcps 查看可用服务，"
                    f"然后使用 load_weibo_mcp_tools(server_name='{server_name}') 加载。"
                )

        # Get tool
        tool = self._state_manager.get_tool(server_name, tool_name)
        if not tool:
            available = self._state_manager.get_server_tool_names(server_name)
            return (
                f"错误: 工具 '{tool_name}' 在服务 '{server_name}' 中未找到。\n"
                f"该服务可用的工具: {', '.join(available)}"
            )

        # Invoke tool
        try:
            logger.info(
                "[InvokeWeiboToolTool] Invoking %s.%s with args: %s",
                server_name,
                tool_name,
                arguments,
            )

            if hasattr(tool, "_arun"):
                result = await tool._arun(**arguments)
            elif hasattr(tool, "ainvoke"):
                result = await tool.ainvoke(arguments)
            else:
                result = tool._run(**arguments)

            return str(result)

        except Exception as e:
            logger.exception(
                "[InvokeWeiboToolTool] Error invoking %s.%s", server_name, tool_name
            )
            return f"调用 '{server_name}.{tool_name}' 时出错: {e}"


# =============================================================================
# State Manager (Shared across tools)
# =============================================================================


class WeiboToolsStateManager:
    """Manages state for Weibo MCP tools across the session.

    This class maintains:
    - Connected MCP clients (per server)
    - Loaded tools (per server)
    - Tool metadata (descriptions, schemas)

    State is session-scoped and shared across all three tool phases.
    """

    def __init__(self):
        """Initialize empty state."""
        self._mcp_clients: dict[str, Any] = {}
        self._loaded_tools: dict[str, dict[str, dict[str, Any]]] = {}

    def register_server(
        self,
        server_name: str,
        mcp_client: Any,
        tools: dict[str, dict[str, Any]],
    ) -> None:
        """Register a loaded MCP server and its tools."""
        self._mcp_clients[server_name] = mcp_client
        self._loaded_tools[server_name] = tools

    def is_server_loaded(self, server_name: str) -> bool:
        """Check if a server has been loaded."""
        return server_name in self._loaded_tools

    def get_loaded_servers(self) -> list[str]:
        """Get list of loaded server names."""
        return list(self._loaded_tools.keys())

    def get_server_tools(self, server_name: str) -> dict[str, dict[str, Any]]:
        """Get tools from a specific server."""
        return self._loaded_tools.get(server_name, {})

    def get_server_tool_names(self, server_name: str) -> list[str]:
        """Get tool names from a specific server."""
        return list(self._loaded_tools.get(server_name, {}).keys())

    def get_tool(self, server_name: str, tool_name: str) -> Optional[Any]:
        """Get a specific tool instance."""
        server_tools = self._loaded_tools.get(server_name, {})
        tool_info = server_tools.get(tool_name, {})
        return tool_info.get("tool")

    def get_tool_description(self, server_name: str, tool_name: str) -> str:
        """Get description for a specific tool."""
        server_tools = self._loaded_tools.get(server_name, {})
        tool_info = server_tools.get(tool_name, {})
        return tool_info.get("description", "无描述")


# =============================================================================
# Legacy Compatibility (Keep old names as aliases)
# =============================================================================

# For backward compatibility with tests
LoadWeiboToolsInput = LoadWeiboMCPToolsInput


class LoadWeiboToolsTool(LoadWeiboMCPToolsTool):
    """Backward compatibility alias for LoadWeiboMCPToolsTool."""

    pass
