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

Prometheus metrics:
- mcp_connections_total: Counter for connection attempts by server and status
- mcp_disconnections_total: Counter for disconnections by server
- mcp_tool_discovery_duration_seconds: Histogram for tool discovery latency
- mcp_requests_total: Counter for tool requests by server, tool, and status
- mcp_request_duration_seconds: Histogram for tool request latency
"""

import asyncio
import concurrent.futures
import inspect
import logging
import time
from typing import Any

from langchain_core.tools.base import BaseTool
from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_mcp_adapters.sessions import (
    SSEConnection,
    StdioConnection,
    StreamableHttpConnection,
)

from chat_shell.core.config import settings
from shared.telemetry.decorators import add_span_event, trace_async
from shared.utils.mcp_utils import replace_mcp_server_variables
from shared.utils.sensitive_data_masker import mask_sensitive_data

logger = logging.getLogger(__name__)

# Type alias for connection types
Connection = SSEConnection | StdioConnection | StreamableHttpConnection

# Default timeout for MCP tool execution (60 seconds)
DEFAULT_TOOL_TIMEOUT = 60.0


def wrap_tool_with_protection(
    tool: BaseTool,
    timeout: float = DEFAULT_TOOL_TIMEOUT,
    server_name: str = "unknown",
) -> BaseTool:
    """Wrap an MCP tool with timeout and exception protection.

    This ensures that:
    - Tool execution has a timeout limit
    - Exceptions don't crash the chat service
    - Failed tools return error messages instead of raising exceptions
    - Prometheus metrics are recorded for each tool call

    Args:
        tool: Original MCP tool
        timeout: Timeout in seconds for tool execution
        server_name: MCP server name for metrics labeling

    Returns:
        Protected tool instance
    """
    original_run = tool._run if hasattr(tool, "_run") else None
    original_arun = tool._arun if hasattr(tool, "_arun") else None

    # Check tool signatures to see if they accept 'config'
    run_accepts_config = False
    if original_run:
        try:
            sig = inspect.signature(original_run)
            run_accepts_config = "config" in sig.parameters or any(
                p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values()
            )
        except ValueError:
            run_accepts_config = False

    arun_accepts_config = False
    if original_arun:
        try:
            sig = inspect.signature(original_arun)
            arun_accepts_config = "config" in sig.parameters or any(
                p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values()
            )
        except ValueError:
            arun_accepts_config = False

    # Check response format to ensure we return the correct type on error
    response_format = getattr(tool, "response_format", "content")

    def _format_error(msg: str) -> Any:
        """Format error message based on tool response format."""
        if response_format == "content_and_artifact":
            return msg, None
        return msg

    def _record_mcp_metrics(tool_name: str, status: str, duration: float) -> None:
        """Record Prometheus metrics for MCP tool call."""
        if settings.PROMETHEUS_ENABLED:
            try:
                from shared.prometheus.metrics.llm import get_mcp_metrics

                metrics = get_mcp_metrics()
                metrics.observe_request(
                    server=server_name,
                    tool=tool_name,
                    status=status,
                    duration_seconds=duration,
                )
                logger.info(
                    "[MCP] Recorded metrics: server=%s, tool=%s, status=%s, duration=%.3fs",
                    server_name,
                    tool_name,
                    status,
                    duration,
                )
            except Exception as e:
                logger.warning("[MCP] Failed to record metrics: %s", e)
        else:
            logger.debug(
                "[MCP] Prometheus disabled, skipping metrics for tool %s", tool_name
            )

    def protected_run(*args, **kwargs):
        """Synchronous tool execution with protection."""
        start_time = time.time()
        status = "success"
        try:
            if original_run:
                if run_accepts_config and "config" not in kwargs:
                    kwargs["config"] = None

                with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                    future = executor.submit(original_run, *args, **kwargs)
                    try:
                        return future.result(timeout=timeout)
                    except concurrent.futures.TimeoutError:
                        status = "timeout"
                        error_msg = f"MCP tool '{tool.name}' timed out after {timeout}s"
                        logger.error("[MCP] %s", error_msg)
                        return _format_error(error_msg)

            status = "error"
            return _format_error(
                f"Error: Tool {tool.name} has no synchronous implementation"
            )
        except Exception as e:
            status = "error"
            logger.exception("[MCP] MCP tool '%s' failed: %s", tool.name, e)
            return _format_error(f"MCP tool '{tool.name}' failed: {e!s}")
        finally:
            duration = time.time() - start_time
            _record_mcp_metrics(tool.name, status, duration)

    async def protected_arun(*args, **kwargs):
        """Asynchronous tool execution with timeout and exception protection."""
        start_time = time.time()
        status = "success"
        try:
            if original_arun:
                if arun_accepts_config and "config" not in kwargs:
                    kwargs["config"] = None

                result = await asyncio.wait_for(
                    original_arun(*args, **kwargs), timeout=timeout
                )
                return result
            status = "error"
            return _format_error(f"Error: Tool {tool.name} has no async implementation")
        except asyncio.TimeoutError:
            status = "timeout"
            error_msg = f"MCP tool '{tool.name}' timed out after {timeout}s"
            logger.error("[MCP] %s", error_msg)
            return _format_error(error_msg)
        except Exception as e:
            status = "error"
            logger.exception("[MCP] MCP tool '%s' failed: %s", tool.name, e)
            return _format_error(f"MCP tool '{tool.name}' failed: {e!s}")
        finally:
            duration = time.time() - start_time
            _record_mcp_metrics(tool.name, status, duration)

    if original_run:
        tool._run = protected_run
    if original_arun:
        tool._arun = protected_arun

    return tool


def build_connections(
    config: dict[str, dict[str, Any]], task_data: dict[str, Any] | None = None
) -> dict[str, Connection]:
    """Build connection configs from server configuration dict.

    This function supports variable substitution using ${{path}} placeholders.
    Variables are replaced with values from task_data using dot notation paths.

    Args:
        config: MCP servers configuration dict
        task_data: Optional dict for variable substitution

    Returns:
        Dict of server_name to Connection config
    """
    # Apply variable substitution to the entire config
    if task_data:
        config = replace_mcp_server_variables(config, task_data)
        logger.debug(
            "[MCP] Applied variable substitution to MCP config with task_data keys: %s",
            task_data,
        )

    connections = {}
    for name, cfg in config.items():
        server_type = cfg.get("type", "streamable-http")
        headers = cfg.get("headers") or None

        if server_type == "sse":
            connections[name] = SSEConnection(
                transport="sse",
                url=cfg["url"],
                headers=headers,
                timeout=cfg.get("timeout", 30.0),
            )
            if headers:
                masked_headers = mask_sensitive_data(headers)
                logger.debug(
                    "[MCP] Built SSE connection '%s' with headers: %s",
                    name,
                    masked_headers,
                )
        elif server_type == "stdio":
            connections[name] = StdioConnection(
                transport="stdio",
                command=cfg["command"],
                args=cfg.get("args", []),
                env=cfg.get("env"),
            )
        elif server_type == "streamable-http":
            connections[name] = StreamableHttpConnection(
                transport="streamable_http",
                url=cfg["url"],
                headers=headers,
            )
            if headers:
                masked_headers = mask_sensitive_data(headers)
                logger.debug(
                    "[MCP] Built streamable-http connection '%s' with headers: %s",
                    name,
                    masked_headers,
                )
        else:
            raise ValueError(f"Unknown MCP server type: {server_type}")

    return connections


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
        self, config: dict[str, dict[str, Any]], task_data: dict[str, Any] | None = None
    ):
        """Initialize MCP client.

        Args:
            config: MCP servers configuration dict. Supports ${{path}} placeholders.
            task_data: Optional dict for variable substitution in config.
        """
        self.config = config
        self.task_data = task_data
        self.connections = build_connections(config, task_data) if config else {}
        self._client: MultiServerMCPClient | None = None
        self._tools: list[BaseTool] = []

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

        Prometheus metrics recorded:
        - mcp_connections_total: Connection attempts by server and status
        - mcp_tool_discovery_duration_seconds: Tool discovery latency by server
        """
        if not self.connections:
            add_span_event("no_connections_skipped")
            return

        add_span_event("creating_multi_server_client")
        self._client = MultiServerMCPClient(connections=self.connections)

        # Load tools from each server individually to handle failures gracefully
        # This avoids the issue where one failing server causes all tools to fail
        add_span_event("loading_tools_started")
        failed_servers: list[str] = []
        successful_servers: list[str] = []

        async def load_server_tools(
            server_name: str,
        ) -> tuple[str, list[BaseTool], str | None, float]:
            """Load tools from a single server, returning (name, tools, error, duration)."""
            start_time = time.time()
            try:
                tools = await self._client.get_tools(server_name=server_name)
                duration = time.time() - start_time
                return (server_name, tools, None, duration)
            except Exception as e:
                duration = time.time() - start_time
                error_msg = str(e)
                # Extract nested exception message if available
                if hasattr(e, "exceptions"):
                    for exc in e.exceptions:
                        if hasattr(exc, "exceptions"):
                            for sub_exc in exc.exceptions:
                                error_msg = str(sub_exc)
                                break
                        else:
                            error_msg = str(exc)
                        break
                return (server_name, [], error_msg, duration)

        # Load tools from all servers in parallel with fault tolerance
        results = await asyncio.gather(
            *[load_server_tools(name) for name in self.connections.keys()],
            return_exceptions=True,
        )

        for result in results:
            if isinstance(result, Exception):
                # This shouldn't happen since we catch exceptions in load_server_tools
                logger.error("[MCP] Unexpected error loading tools: %s", result)
                continue
            server_name, tools, error, duration = result
            if error:
                failed_servers.append(server_name)
                logger.warning(
                    "[MCP] Failed to load tools from server '%s': %s",
                    server_name,
                    error,
                )
                # Record metrics for failed connection and tool discovery
                self._record_connection_metrics(server_name, "error")
                self._record_tool_discovery_metrics(server_name, "error", duration)
            else:
                successful_servers.append(server_name)
                # Record metrics for successful connection and tool discovery
                self._record_connection_metrics(server_name, "success")
                self._record_tool_discovery_metrics(server_name, "success", duration)
                # Wrap each tool with protection, including server_name for metrics
                for tool in tools:
                    wrapped_tool = wrap_tool_with_protection(
                        tool, server_name=server_name
                    )
                    self._tools.append(wrapped_tool)

        add_span_event(
            "loading_tools_completed",
            {
                "raw_tools_count": len(self._tools),
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

        add_span_event(
            "wrapping_tools_completed", {"protected_tools_count": len(self._tools)}
        )

        for tool in self._tools:
            logger.debug(
                "[MCP] Registered tool (protected): name='%s', description='%s', type='%s'",
                getattr(tool, "name", "UNKNOWN"),
                getattr(tool, "description", "NO_DESCRIPTION"),
                type(tool).__name__,
            )

        logger.debug(
            "Connected to MCP servers: %s, loaded %d protected tools",
            ", ".join(self.list_servers()),
            len(self._tools),
        )

    async def disconnect(self) -> None:
        """Disconnect from all MCP servers.

        Prometheus metrics recorded:
        - mcp_disconnections_total: Disconnection count by server
        """
        if self._client:
            # Record disconnection metrics for all connected servers
            for server_name in self.connections.keys():
                self._record_disconnection_metrics(server_name)
            self._client = None
            self._tools = []
            logger.debug("Disconnected from MCP servers")

    def _record_connection_metrics(self, server: str, status: str) -> None:
        """Record Prometheus metrics for MCP connection attempt.

        Args:
            server: MCP server name
            status: Connection status ("success", "error", or "timeout")
        """
        if settings.PROMETHEUS_ENABLED:
            try:
                from shared.prometheus.metrics.llm import get_mcp_metrics

                metrics = get_mcp_metrics()
                metrics.observe_connection(server=server, status=status)
                logger.info(
                    "[MCP] Recorded connection metrics: server=%s, status=%s",
                    server,
                    status,
                )
            except Exception as e:
                logger.warning("[MCP] Failed to record connection metrics: %s", e)
        else:
            logger.debug(
                "[MCP] Prometheus disabled, skipping connection metrics for server %s",
                server,
            )

    def _record_disconnection_metrics(self, server: str) -> None:
        """Record Prometheus metrics for MCP disconnection.

        Args:
            server: MCP server name
        """
        if settings.PROMETHEUS_ENABLED:
            try:
                from shared.prometheus.metrics.llm import get_mcp_metrics

                metrics = get_mcp_metrics()
                metrics.observe_disconnection(server=server)
                logger.info(
                    "[MCP] Recorded disconnection metrics: server=%s",
                    server,
                )
            except Exception as e:
                logger.warning("[MCP] Failed to record disconnection metrics: %s", e)
        else:
            logger.debug(
                "[MCP] Prometheus disabled, skipping disconnection metrics for server %s",
                server,
            )

    def _record_tool_discovery_metrics(
        self, server: str, status: str, duration: float
    ) -> None:
        """Record Prometheus metrics for MCP tool discovery.

        Args:
            server: MCP server name
            status: Discovery status ("success" or "error")
            duration: Discovery duration in seconds
        """
        if settings.PROMETHEUS_ENABLED:
            try:
                from shared.prometheus.metrics.llm import get_mcp_metrics

                metrics = get_mcp_metrics()
                metrics.observe_tool_discovery(
                    server=server, status=status, duration_seconds=duration
                )
                logger.info(
                    "[MCP] Recorded tool discovery metrics: server=%s, status=%s, duration=%.3fs",
                    server,
                    status,
                    duration,
                )
            except Exception as e:
                logger.warning("[MCP] Failed to record tool discovery metrics: %s", e)
        else:
            logger.debug(
                "[MCP] Prometheus disabled, skipping tool discovery metrics for server %s",
                server,
            )

    def get_tools(self, server_names: list[str] | None = None) -> list[BaseTool]:
        """Get LangChain-compatible tools from connected servers.

        Args:
            server_names: Optional list of server names to filter tools.

        Returns:
            List of LangChain BaseTool instances
        """
        if not self._tools:
            return []

        if server_names is None:
            return list(self._tools)

        filtered_tools = []
        for tool in self._tools:
            for server_name in server_names:
                if tool.name.startswith(f"{server_name}_") or server_name in getattr(
                    tool, "server_name", ""
                ):
                    filtered_tools.append(tool)
                    break
        return filtered_tools

    def list_servers(self) -> list[str]:
        """List configured server names."""
        return list(self.connections.keys())

    @property
    def is_connected(self) -> bool:
        """Check if client has loaded tools."""
        return len(self._tools) > 0
