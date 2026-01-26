# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Load MCP tools dynamically.

This module provides the LoadMCPToolsTool class that enables on-demand
loading of MCP (Model Context Protocol) tools from configured servers.

The key design principle is "lazy loading" - MCP tools are only connected
and loaded when the LLM determines they are needed, avoiding the overhead
of sending all tool schemas to the LLM upfront.

Architecture:
1. load_mcp_tools: Connects to MCP servers and loads available tools
2. invoke_mcp_tool: Proxy tool to call loaded MCP tools by name
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


class LoadMCPToolsInput(BaseModel):
    """Input schema for load_mcp_tools tool."""

    server_names: Optional[list[str]] = Field(
        default=None,
        description="Optional list of specific MCP server names to load. "
        "If not provided, loads tools from all configured servers.",
    )


class InvokeMCPToolInput(BaseModel):
    """Input schema for invoke_mcp_tool tool."""

    tool_name: str = Field(description="The name of the MCP tool to invoke")
    arguments: dict[str, Any] = Field(
        default_factory=dict,
        description="Arguments to pass to the MCP tool",
    )


class LoadMCPToolsTool(BaseTool):
    """Tool to dynamically load MCP tools from configured servers.

    This tool implements on-demand MCP tool loading:
    1. Connects to MCP servers configured in CHAT_MCP_SERVERS
    2. Discovers available tools from each server
    3. Makes tools available for invocation via invoke_mcp_tool

    The tool also implements PromptModifierTool protocol to inject
    loaded tool descriptions into the system prompt, enabling the LLM
    to understand what tools are available after loading.

    Session-level state:
    - Tools are loaded once per conversation turn
    - Subsequent calls return cached tool information
    - State is managed at the tool instance level
    """

    name: str = "load_mcp_tools"
    display_name: str = "Load MCP Tools"
    description: str = (
        "Load external MCP tools from configured servers. "
        "Call this tool when you need specialized capabilities like web search, "
        "database access, or other external integrations. "
        "After loading, use invoke_mcp_tool to call the loaded tools."
    )
    args_schema: type[BaseModel] = LoadMCPToolsInput

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
        """Synchronous wrapper for async MCP loading."""
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
            logger.exception("[LoadMCPToolsTool] Error loading MCP tools")
            return f"Error loading MCP tools: {e}"

    async def _arun(
        self,
        server_names: Optional[list[str]] = None,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Load MCP tools asynchronously."""
        return await self._async_load(server_names)

    async def _async_load(self, server_names: Optional[list[str]] = None) -> str:
        """Core async logic for loading MCP tools."""
        # Check if already loaded
        if self._is_loaded and self._loaded_tools:
            tool_list = self._format_tool_list()
            return (
                f"MCP tools are already loaded. Available tools:\n\n{tool_list}\n\n"
                "Use invoke_mcp_tool to call these tools."
            )

        # Parse MCP servers configuration
        mcp_servers_config = getattr(settings, "CHAT_MCP_SERVERS", "")
        if not mcp_servers_config:
            logger.warning("[LoadMCPToolsTool] No CHAT_MCP_SERVERS configured")
            return (
                "No MCP servers are configured. Please ensure the CHAT_MCP_SERVERS "
                "environment variable is set with valid server configurations."
            )

        try:
            config_data = json.loads(mcp_servers_config)
            servers = config_data.get("mcpServers", config_data)
        except json.JSONDecodeError as e:
            logger.error("[LoadMCPToolsTool] Failed to parse CHAT_MCP_SERVERS: %s", e)
            return f"Error parsing MCP server configuration: {e}"

        if not servers:
            return "No MCP servers found in configuration."

        # Filter servers if specific names requested
        if server_names:
            servers = {k: v for k, v in servers.items() if k in server_names}
            if not servers:
                available = list(config_data.get("mcpServers", config_data).keys())
                return (
                    f"None of the requested servers ({server_names}) are configured. "
                    f"Available servers: {available}"
                )

        logger.info(
            "[LoadMCPToolsTool] Loading MCP tools from servers: %s",
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
                    "Connected to MCP servers but no tools were found. "
                    "The servers may not expose any tools."
                )

            # Store tools for later invocation
            for tool in tools:
                tool_name = getattr(tool, "name", "unknown")
                self._loaded_tools[tool_name] = tool
                self._tool_descriptions[tool_name] = getattr(
                    tool, "description", "No description available"
                )

            self._is_loaded = True

            tool_list = self._format_tool_list()

            logger.info(
                "[LoadMCPToolsTool] Successfully loaded %d MCP tools: %s",
                len(self._loaded_tools),
                list(self._loaded_tools.keys()),
            )

            return (
                f"Successfully loaded {len(self._loaded_tools)} MCP tools:\n\n"
                f"{tool_list}\n\n"
                "Use invoke_mcp_tool to call these tools with the appropriate arguments."
            )

        except asyncio.TimeoutError:
            logger.error(
                "[LoadMCPToolsTool] Timeout connecting to MCP servers (timeout=%s)",
                self.timeout,
            )
            return (
                f"Timeout connecting to MCP servers after {self.timeout} seconds. "
                "Please check server availability."
            )
        except Exception as e:
            logger.exception("[LoadMCPToolsTool] Error connecting to MCP servers")
            return f"Error connecting to MCP servers: {e}"

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
            String content describing available MCP tools, or empty string if none loaded
        """
        if not self._is_loaded or not self._loaded_tools:
            return ""

        tool_list = self._format_tool_list()

        return f"""

# Loaded MCP Tools

The following external tools have been loaded and are available for use:

{tool_list}

## How to Use

Call `invoke_mcp_tool` with the tool name and arguments to use these tools.

Example:
```json
{{
  "name": "invoke_mcp_tool",
  "arguments": {{
    "tool_name": "tool_name_here",
    "arguments": {{
      "param1": "value1"
    }}
  }}
}}
```
"""

    async def invoke_tool(self, tool_name: str, arguments: dict[str, Any]) -> str:
        """Invoke a loaded MCP tool.

        Args:
            tool_name: Name of the tool to invoke
            arguments: Arguments to pass to the tool

        Returns:
            Tool execution result as string
        """
        if not self._is_loaded:
            return "Error: MCP tools not loaded. Call load_mcp_tools first."

        tool = self._loaded_tools.get(tool_name)
        if not tool:
            available = list(self._loaded_tools.keys())
            return (
                f"Error: Tool '{tool_name}' not found. "
                f"Available tools: {available}"
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
                "[LoadMCPToolsTool] Error invoking MCP tool '%s'", tool_name
            )
            return f"Error invoking tool '{tool_name}': {e}"

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


class InvokeMCPToolTool(BaseTool):
    """Proxy tool to invoke loaded MCP tools.

    This tool acts as a gateway to call any MCP tool that was previously
    loaded via load_mcp_tools. It enables the LLM to use MCP tools without
    requiring them to be pre-registered in the agent's tool list.
    """

    name: str = "invoke_mcp_tool"
    display_name: str = "Invoke MCP Tool"
    description: str = (
        "Invoke a previously loaded MCP tool. "
        "You must call load_mcp_tools first to load available tools. "
        "Use this tool to call any of the loaded MCP tools by name with appropriate arguments."
    )
    args_schema: type[BaseModel] = InvokeMCPToolInput

    # Reference to the load_mcp_tools instance
    load_mcp_tools_ref: LoadMCPToolsTool

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
                        self.load_mcp_tools_ref.invoke_tool(tool_name, arguments or {}),
                    )
                    return future.result(timeout=60.0)
            else:
                return loop.run_until_complete(
                    self.load_mcp_tools_ref.invoke_tool(tool_name, arguments or {})
                )
        except Exception as e:
            logger.exception("[InvokeMCPToolTool] Error invoking tool '%s'", tool_name)
            return f"Error invoking tool: {e}"

    async def _arun(
        self,
        tool_name: str,
        arguments: dict[str, Any] | None = None,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Invoke MCP tool asynchronously."""
        return await self.load_mcp_tools_ref.invoke_tool(tool_name, arguments or {})
