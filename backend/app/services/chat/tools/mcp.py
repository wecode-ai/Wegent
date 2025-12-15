# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
MCP (Model Context Protocol) tools for Chat Shell.

This module manages MCP client connections and provides tools from external MCP servers.
Sessions are managed per-task and cleaned up when tasks end.
"""

import asyncio
import json
import logging
from dataclasses import dataclass, field
from typing import Any

from mcp import ClientSession
from mcp.client.sse import sse_client
from mcp.client.stdio import StdioServerParameters, stdio_client
from mcp.client.streamable_http import streamablehttp_client

from app.services.chat.tools.base import Tool

logger = logging.getLogger(__name__)


@dataclass
class MCPServerConfig:
    """Configuration for an MCP Server."""

    name: str
    type: str  # "stdio", "sse", "streamable-http"
    command: str | None = None
    args: list[str] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)
    url: str | None = None
    headers: dict[str, str] = field(default_factory=dict)
    timeout: int = 300


class MCPSession:
    """
    MCP session for a single task.

    Manages connections to MCP servers and provides tools.
    """

    def __init__(self, task_id: int, configs: dict[str, MCPServerConfig]):
        self.task_id = task_id
        self._configs = configs
        self._sessions: dict[str, ClientSession] = {}
        self._tools: list[Tool] = []
        self._context_managers: list[Any] = []
        self._initialized = False

    async def initialize(self) -> None:
        """Initialize connections to all configured MCP servers."""
        if self._initialized:
            return

        for name, config in self._configs.items():
            try:
                await self._connect(name, config)
            except Exception:
                logger.exception("Failed to connect to MCP server %s", name)

        self._initialized = True
        logger.info(
            "MCP session initialized for task %d: %d tools from %d servers",
            self.task_id,
            len(self._tools),
            len(self._sessions),
        )

    async def _connect(self, name: str, config: MCPServerConfig) -> None:
        """Connect to an MCP server and register its tools."""
        # Create client based on type
        if config.type == "stdio":
            if not config.command:
                return
            client_cm = stdio_client(
                StdioServerParameters(
                    command=config.command,
                    args=config.args,
                    env=config.env or None,
                )
            )
            read, write = await client_cm.__aenter__()
        elif config.type == "sse":
            if not config.url:
                return
            client_cm = sse_client(config.url, headers=config.headers)
            read, write = await client_cm.__aenter__()
        elif config.type in ("streamable-http", "streamable_http"):
            if not config.url:
                return
            client_cm = streamablehttp_client(config.url, headers=config.headers)
            read, write, _ = await client_cm.__aenter__()
        else:
            logger.warning("Unsupported MCP server type: %s", config.type)
            return

        self._context_managers.append(client_cm)

        # Create session
        session_cm = ClientSession(read, write)
        session = await session_cm.__aenter__()
        self._context_managers.append(session_cm)

        await session.initialize()
        self._sessions[name] = session

        # Register tools
        result = await session.list_tools()
        for tool in result.tools:
            tool_name = f"{name}__{tool.name}"
            self._tools.append(
                Tool(
                    name=tool_name,
                    description=tool.description or "",
                    parameters=getattr(tool, "inputSchema", {}),
                    fn=self._make_call_fn(name, tool.name),
                )
            )

        logger.info("Connected to MCP server %s: %d tools", name, len(result.tools))

    def _make_call_fn(self, server: str, tool: str):
        """Create a callable for an MCP tool."""

        async def call_fn(**kwargs: Any) -> str:
            session = self._sessions.get(server)
            if not session:
                return f"MCP server not connected: {server}"
            try:
                result = await session.call_tool(tool, kwargs)
                if hasattr(result, "content"):
                    parts = []
                    for c in result.content:
                        if hasattr(c, "text"):
                            parts.append(c.text)
                        elif hasattr(c, "data"):
                            parts.append(f"[Binary: {c.mimeType}]")
                    return "\n".join(parts) or "Success"
                return str(result)
            except Exception as e:
                logger.exception("MCP tool call failed: %s__%s", server, tool)
                return f"Error: {e}"

        return call_fn

    def get_tools(self) -> list[Tool]:
        """Get all tools from this session."""
        return self._tools

    @property
    def has_tools(self) -> bool:
        """Check if any tools are available."""
        return bool(self._tools)

    async def cleanup(self) -> None:
        """Clean up all connections."""
        for cm in reversed(self._context_managers):
            try:
                await cm.__aexit__(None, None, None)
            except Exception:
                pass
        self._context_managers.clear()
        self._sessions.clear()
        self._tools.clear()
        self._initialized = False
        logger.info("MCP session cleaned up for task %d", self.task_id)


class _MCPManager:
    """Global MCP session manager (singleton)."""

    def __init__(self):
        self._configs: dict[str, MCPServerConfig] | None = None
        self._sessions: dict[int, MCPSession] = {}
        self._lock = asyncio.Lock()

    def _load_configs(self) -> dict[str, MCPServerConfig]:
        """Load MCP server configurations from settings."""
        from app.core.config import settings

        config_str = getattr(settings, "CHAT_MCP_SERVERS", "")
        if not config_str:
            return {}

        try:
            data = json.loads(config_str)
        except json.JSONDecodeError:
            logger.exception("Invalid CHAT_MCP_SERVERS JSON")
            return {}

        servers = data.get("mcpServers", data)
        if not isinstance(servers, dict):
            return {}

        return {
            name: MCPServerConfig(
                name=name,
                type=cfg.get("type", "stdio"),
                command=cfg.get("command"),
                args=cfg.get("args", []),
                env=cfg.get("env", {}),
                url=cfg.get("url"),
                headers=cfg.get("headers", {}),
                timeout=cfg.get("timeout", 300),
            )
            for name, cfg in servers.items()
            if isinstance(cfg, dict)
        }

    @property
    def configs(self) -> dict[str, MCPServerConfig]:
        """Get or load configurations."""
        if self._configs is None:
            self._configs = self._load_configs()
        return self._configs

    @property
    def has_config(self) -> bool:
        """Check if MCP is configured."""
        return bool(self.configs)

    async def get_session(self, task_id: int) -> MCPSession | None:
        """Get or create an MCP session for a task."""
        if not self.configs:
            return None

        async with self._lock:
            if task_id in self._sessions:
                return self._sessions[task_id]

            session = MCPSession(task_id, self.configs)
            await session.initialize()

            if session.has_tools:
                self._sessions[task_id] = session
                return session

            await session.cleanup()
            return None

    async def cleanup_session(self, task_id: int) -> None:
        """Clean up a task's MCP session."""
        async with self._lock:
            session = self._sessions.pop(task_id, None)
            if session:
                await session.cleanup()


# Singleton instance
_manager = _MCPManager()


def is_mcp_enabled() -> bool:
    """Check if MCP tools are enabled and configured."""
    from app.core.config import settings

    if not getattr(settings, "CHAT_MCP_ENABLED", False):
        return False
    return _manager.has_config


async def get_mcp_session(task_id: int) -> MCPSession | None:
    """
    Get MCP session for a task.

    Returns None if MCP is disabled or not configured.
    """
    from app.core.config import settings

    if not getattr(settings, "CHAT_MCP_ENABLED", False):
        return None
    return await _manager.get_session(task_id)


async def cleanup_mcp_session(task_id: int) -> None:
    """Clean up MCP session for a task."""
    await _manager.cleanup_session(task_id)
