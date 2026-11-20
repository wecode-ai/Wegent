# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""MCP (Model Context Protocol) client using langchain-mcp-adapters SDK.

This module provides a thin wrapper around the official langchain-mcp-adapters
MultiServerMCPClient with async context manager support and protection mechanisms
for backend stability.

Protection mechanisms:
- Connection timeout: 30s default timeout for server connections
- Tool wrapping: All MCP tools are wrapped with timeout and exception handling
- Graceful degradation: Failed tools return error messages instead of crashing

Variable substitution:
- Supports ${{path}} placeholders in MCP server configurations
- Use task_data dict to provide replacement values (e.g., user.name, user.id)
- Example: "headers": {"X-User": "${{user.name}}"} -> {"X-User": "john"}
"""

import asyncio
import concurrent.futures
import inspect
import logging
import threading
from typing import Any, Optional

from langchain_core.tools.base import BaseTool
from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_mcp_adapters.sessions import (
    SSEConnection,
    StdioConnection,
    StreamableHttpConnection,
)

from shared.models.execution import ExecutionRequest
from shared.telemetry.decorators import add_span_event, trace_async
from shared.utils.mcp_utils import (
    filter_backend_dependent_mcp_servers,
    replace_mcp_server_variables,
)

logger = logging.getLogger(__name__)

# Type alias for connection types
Connection = SSEConnection | StdioConnection | StreamableHttpConnection

# Default timeout for MCP tool execution (180 seconds)
DEFAULT_TOOL_TIMEOUT = 180.0
DEFAULT_STARTUP_TIMEOUT = 30.0


def wrap_tool_with_protection(
    tool: BaseTool,
    timeout: float = DEFAULT_TOOL_TIMEOUT,
    unavailable: threading.Event | None = None,
) -> BaseTool:
    """Wrap an MCP tool with timeout and exception protection.

    This ensures that:
    - Tool execution has a timeout limit
    - Exceptions don't crash the chat service
    - Failed tools return error messages instead of raising exceptions

    Args:
        tool: Original MCP tool
        timeout: Timeout in seconds for tool execution

    Returns:
        Protected tool instance
    """
    original_run = tool._run if hasattr(tool, "_run") else None
    original_arun = tool._arun if hasattr(tool, "_arun") else None
    unavailable = unavailable if unavailable is not None else threading.Event()

    # Check tool signatures to see if they accept 'config'
    run_accepts_config = False
    if original_run:
        try:
            sig = inspect.signature(original_run)
            run_accepts_config = "config" in sig.parameters or any(
                p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values()
            )
        except (TypeError, ValueError):
            run_accepts_config = False

    arun_accepts_config = False
    if original_arun:
        try:
            sig = inspect.signature(original_arun)
            arun_accepts_config = "config" in sig.parameters or any(
                p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values()
            )
        except (TypeError, ValueError):
            arun_accepts_config = False

    # Check response format to ensure we return the correct type on error
    response_format = getattr(tool, "response_format", "content")

    def _format_error(msg: str) -> Any:
        """Format error message based on tool response format."""
        if response_format == "content_and_artifact":
            return msg, None
        return msg

    def protected_run(*args, **kwargs):
        """Synchronous tool execution with protection."""
        if unavailable.is_set():
            return _format_error(
                f"MCP tool '{tool.name}' is unavailable. Continue with other tools."
            )
        try:
            if original_run:
                if run_accepts_config and "config" not in kwargs:
                    kwargs["config"] = None

                executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
                try:
                    future = executor.submit(original_run, *args, **kwargs)
                    try:
                        return future.result(timeout=timeout)
                    except concurrent.futures.TimeoutError:
                        unavailable.set()
                        error_msg = f"MCP tool '{tool.name}' timed out after {timeout}s"
                        logger.warning("[MCP] %s", error_msg)
                        return _format_error(error_msg + " Continue with other tools.")
                finally:
                    executor.shutdown(wait=False, cancel_futures=True)

            return _format_error(
                f"Error: Tool {tool.name} has no synchronous implementation"
            )
        except (Exception, asyncio.CancelledError) as e:
            unavailable.set()
            logger.warning(
                "[MCP] Tool unavailable: tool=%s error_type=%s",
                tool.name,
                type(e).__name__,
            )
            return _format_error(
                f"MCP tool '{tool.name}' is unavailable. Continue with other tools."
            )

    async def protected_arun(*args, **kwargs):
        """Asynchronous tool execution with timeout and exception protection."""
        if unavailable.is_set():
            return _format_error(
                f"MCP tool '{tool.name}' is unavailable. Continue with other tools."
            )
        try:
            if original_arun:
                if arun_accepts_config and "config" not in kwargs:
                    kwargs["config"] = None

                return await asyncio.wait_for(
                    original_arun(*args, **kwargs), timeout=timeout
                )
            return _format_error(f"Error: Tool {tool.name} has no async implementation")
        except asyncio.TimeoutError:
            unavailable.set()
            error_msg = f"MCP tool '{tool.name}' timed out after {timeout}s"
            logger.warning("[MCP] %s", error_msg)
            return _format_error(error_msg + " Continue with other tools.")
        except (Exception, asyncio.CancelledError) as e:
            if isinstance(e, asyncio.CancelledError):
                task = asyncio.current_task()
                if task is not None and task.cancelling():
                    raise
            unavailable.set()
            logger.warning(
                "[MCP] Tool unavailable: tool=%s error_type=%s",
                tool.name,
                type(e).__name__,
            )
            return _format_error(
                f"MCP tool '{tool.name}' is unavailable. Continue with other tools."
            )

    if original_run:
        tool._run = protected_run
    if original_arun:
        tool._arun = protected_arun
    setattr(tool, "_wegent_tool_protocol", "mcp_call")
    setattr(tool, "_wegent_mcp_unavailable", unavailable)

    return tool


def build_connections(
    config: dict[str, dict[str, Any]], task_data: Optional[ExecutionRequest] = None
) -> dict[str, Connection]:
    """Build connection configs from server configuration dict.

    This function supports variable substitution using ${{path}} placeholders.
    Variables are replaced with values from task_data using dot notation paths.

    Args:
        config: MCP servers configuration dict
        task_data: Optional ExecutionRequest for variable substitution

    Returns:
        Dict of server_name to Connection config
    """
    connections = {}
    for name, cfg in config.items():
        try:
            available = filter_backend_dependent_mcp_servers({name: cfg}, task_data)
            if not available:
                continue
            cfg = replace_mcp_server_variables(available, task_data)[name]
            connections[name] = _build_connection(cfg)
        except Exception as error:
            logger.warning(
                "[MCP] Configuration unavailable: server=%s error_type=%s",
                name,
                type(error).__name__,
            )
    return connections


def _build_connection(cfg: dict[str, Any]) -> Connection:
    server_type = cfg.get("type", "streamable-http")
    headers = cfg.get("headers") or None
    if server_type == "sse":
        return SSEConnection(
            transport="sse",
            url=cfg["url"],
            headers=headers,
            timeout=cfg.get("timeout", 30.0),
        )
    if server_type == "stdio":
        return StdioConnection(
            transport="stdio",
            command=cfg["command"],
            args=cfg.get("args", []),
            env=cfg.get("env"),
        )
    if server_type in ("http", "streamable-http", "streamable_http"):
        return StreamableHttpConnection(
            transport="streamable_http", url=cfg["url"], headers=headers
        )
    raise ValueError("Unknown MCP transport")


class MCPClient:
    """MCP client with async context manager support.

    Wraps langchain-mcp-adapters MultiServerMCPClient for simplified usage.

    Usage:
        task_data = {"user": {"name": "john", "id": 123}}
        client = MCPClient(config, task_data=task_data)
        await client.connect()
        tools = client.get_tools()
        await client.disconnect()

    Or with async context manager:
        async with MCPClient(config, task_data=task_data) as client:
            tools = client.get_tools()
    """

    def __init__(
        self,
        config: dict[str, dict[str, Any]],
        task_data: Optional[ExecutionRequest] = None,
    ):
        """Initialize MCP client.

        Args:
            config: MCP servers configuration dict. Supports ${{path}} placeholders.
            task_data: Optional ExecutionRequest for variable substitution.
        """
        self.config = config
        self.task_data = task_data
        self.connections = build_connections(config, task_data) if config else {}
        self._clients: dict[str, MultiServerMCPClient] = {}
        self._tools: dict[str, list[BaseTool]] = {}

    async def __aenter__(self) -> "MCPClient":
        """Async context manager entry - connect to servers."""
        await self.connect()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
        """Async context manager exit - disconnect from servers."""
        await self.disconnect()

    @trace_async(
        span_name="mcp_client.connect",
        tracer_name="chat_shell.tools.mcp",
        extract_attributes=lambda self, *args, **kwargs: {
            "mcp.servers_count": len(self.connections),
            "mcp.server_names": list(self.connections.keys()),
        },
    )
    async def connect(self) -> None:
        """Connect to all configured MCP servers and load tools.

        All loaded tools are automatically wrapped with protection mechanisms:
        - Timeout protection (60s default per tool call)
        - Exception isolation (errors return error messages instead of raising)

        Note: This method is fault-tolerant - if some servers fail to connect,
        tools from successfully connected servers will still be available.
        """
        if not self.connections:
            add_span_event("no_connections_skipped")
            return

        self._tools = {}
        self._clients = {}

        # Load tools from each server individually to handle failures gracefully
        # This avoids the issue where one failing server causes all tools to fail
        add_span_event("loading_tools_started")
        failed_servers: list[str] = []
        successful_servers: list[str] = []
        total_tools = 0

        async def load_server_tools(
            server_name: str,
        ) -> tuple[str, list[BaseTool], str | None]:
            """Load tools from a single server, returning (name, tools, error)."""
            try:
                client = MultiServerMCPClient(
                    connections={server_name: self.connections[server_name]},
                    tool_name_prefix=True,
                )
                tools = await asyncio.wait_for(
                    client.get_tools(server_name=server_name),
                    timeout=DEFAULT_STARTUP_TIMEOUT,
                )
                from chat_shell.services.answer_evidence import wrap_native_search

                connection = self.connections[server_name]
                tools = [
                    wrap_native_search(
                        tool,
                        connection.get("url", ""),
                        self.task_data.backend_url if self.task_data else "",
                        server_name=server_name,
                    )
                    for tool in tools
                ]
                unavailable = threading.Event()
                protected_tools = [
                    wrap_tool_with_protection(tool, unavailable=unavailable)
                    for tool in tools
                ]
                for tool in protected_tools:
                    setattr(tool, "_wegent_mcp_server_label", server_name)
                self._clients[server_name] = client
                return (server_name, protected_tools, None)
            except Exception as e:
                return (server_name, [], type(e).__name__)

        # Load tools from all servers in parallel with fault tolerance
        results = await asyncio.gather(
            *[load_server_tools(name) for name in self.connections.keys()],
            return_exceptions=True,
        )

        for result in results:
            if isinstance(result, BaseException):
                # This shouldn't happen since we catch exceptions in load_server_tools
                logger.warning(
                    "[MCP] Unexpected tool loading error: error_type=%s",
                    type(result).__name__,
                )
                continue
            server_name, tools, error = result
            if error:
                failed_servers.append(server_name)
                logger.warning(
                    "[MCP] Failed to load tools from server '%s': %s",
                    server_name,
                    error,
                )
            else:
                successful_servers.append(server_name)
                self._tools[server_name] = tools
                total_tools += len(tools)

        add_span_event(
            "loading_tools_completed",
            {
                "total_tools_count": total_tools,
                "successful_servers": successful_servers,
                "failed_servers": failed_servers,
            },
        )

        if failed_servers:
            logger.warning(
                "[MCP] %d/%d servers failed to connect: %s",
                len(failed_servers),
                len(self.connections),
                ", ".join(failed_servers),
            )

        # Log all loaded tools
        for server_name, tools in self._tools.items():
            for tool in tools:
                logger.debug(
                    "[MCP] Registered tool (protected): server='%s', name='%s', description='%s', type='%s'",
                    server_name,
                    getattr(tool, "name", "UNKNOWN"),
                    getattr(tool, "description", "NO_DESCRIPTION"),
                    type(tool).__name__,
                )

        logger.debug(
            "Connected to MCP servers: %s, loaded %d protected tools",
            ", ".join(self.list_servers()),
            total_tools,
        )

    async def disconnect(self) -> None:
        """Disconnect from all MCP servers."""
        self._clients = {}
        self._tools = {}
        logger.debug("Disconnected from MCP servers")

    def get_tools(self, server_names: list[str] | None = None) -> list[BaseTool]:
        """Get LangChain-compatible tools from connected servers.

        Args:
            server_names: Optional list of server names to filter tools.
                         If None, returns all tools from all servers.

        Returns:
            List of LangChain BaseTool instances
        """
        if not self._tools:
            return []

        if server_names is None:
            # Return all tools from all servers
            all_tools = []
            for tools in self._tools.values():
                all_tools.extend(tools)
            return all_tools

        # Filter tools by server names
        filtered_tools = []
        for server_name in server_names:
            if server_name in self._tools:
                filtered_tools.extend(self._tools[server_name])
        return filtered_tools

    def list_servers(self) -> list[str]:
        """List configured server names."""
        return list(self.connections.keys())

    def get_tools_with_server(self) -> dict[str, list[BaseTool]]:
        """Get tools organized by server name.

        Returns:
            Dict mapping server_name to list of tools
        """
        return dict(self._tools)

    def get_tools_count_with_server(self) -> dict[str, int]:
        """Get tool counts per server.

        Returns:
            Dict mapping server_name to tool count
        """
        return {server_name: len(tools) for server_name, tools in self._tools.items()}

    @property
    def unavailable_servers(self) -> list[str]:
        """Configured capabilities omitted during this initialization."""
        return [name for name in self.config if name not in self._tools]

    @property
    def is_connected(self) -> bool:
        """Check if client has loaded tools from any server."""
        return len(self._tools) > 0
