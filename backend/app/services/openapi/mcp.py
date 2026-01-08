# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
MCP (Model Context Protocol) tools loading for OpenAPI v1/responses endpoint.

This module provides separate functions for loading:
- Server-side MCP tools (from CHAT_MCP_SERVERS config)
- Bot MCP tools (from Bot/Ghost mcpServers config)
"""

import logging
from typing import Any, Dict

logger = logging.getLogger(__name__)


async def load_server_mcp_tools(task_id: int) -> Any:
    """
    Load server-side MCP tools from CHAT_MCP_SERVERS configuration.

    This function loads MCP tools configured at the server level via
    the CHAT_MCP_SERVERS environment variable.

    Args:
        task_id: Task ID for session management and logging

    Returns:
        MCPClient instance or None if no server MCP configured
    """
    import asyncio
    import json

    from app.core.config import settings

    try:
        from chat_shell.tools.mcp import MCPClient

        # Load backend MCP configuration
        backend_servers = {}
        mcp_servers_config = getattr(settings, "CHAT_MCP_SERVERS", "")
        if mcp_servers_config:
            try:
                config_data = json.loads(mcp_servers_config)
                backend_servers = config_data.get("mcpServers", config_data)
            except json.JSONDecodeError as e:
                logger.warning(f"[OPENAPI_MCP] Failed to parse CHAT_MCP_SERVERS: {e}")

        if not backend_servers:
            logger.debug(
                f"[OPENAPI_MCP] No server-side MCP servers configured for task {task_id}"
            )
            return None

        # Create MCP client with server configuration
        client = MCPClient(backend_servers)
        try:
            await asyncio.wait_for(client.connect(), timeout=30.0)
            logger.info(
                f"[OPENAPI_MCP] Loaded {len(client.get_tools())} server-side MCP tools "
                f"from {len(backend_servers)} servers for task {task_id}"
            )
            return client
        except asyncio.TimeoutError:
            logger.error(
                f"[OPENAPI_MCP] Timeout connecting to server MCP servers for task {task_id}"
            )
            return None
        except Exception as e:
            logger.error(
                f"[OPENAPI_MCP] Failed to connect to server MCP servers for task {task_id}: {e}"
            )
            return None

    except Exception:
        logger.exception(
            f"[OPENAPI_MCP] Unexpected error loading server MCP tools for task {task_id}"
        )
        return None


async def load_bot_mcp_tools(
    task_id: int, bot_name: str, bot_namespace: str = "default"
) -> Any:
    """
    Load bot-specific MCP tools from Bot/Ghost mcpServers configuration.

    This function loads MCP tools configured for a specific bot via
    its Ghost CRD's mcpServers field.

    Args:
        task_id: Task ID for session management and logging
        bot_name: Bot name to query Ghost MCP configuration
        bot_namespace: Bot namespace for Ghost query

    Returns:
        MCPClient instance or None if no bot MCP configured
    """
    import asyncio

    try:
        from chat_shell.tools.mcp import MCPClient

        if not bot_name:
            logger.debug(
                f"[OPENAPI_MCP] No bot name provided for task {task_id}, skipping bot MCP"
            )
            return None

        # Load bot's MCP configuration from Ghost CRD
        bot_servers = {}
        try:
            bot_servers = await asyncio.wait_for(
                _get_bot_mcp_servers(bot_name, bot_namespace), timeout=5.0
            )
        except asyncio.TimeoutError:
            logger.warning(
                f"[OPENAPI_MCP] Timeout querying bot MCP servers for {bot_namespace}/{bot_name}"
            )
        except Exception as e:
            logger.warning(
                f"[OPENAPI_MCP] Failed to load bot MCP servers for {bot_namespace}/{bot_name}: {e}"
            )

        if not bot_servers:
            logger.debug(
                f"[OPENAPI_MCP] No bot MCP servers configured for task {task_id} "
                f"(bot={bot_namespace}/{bot_name})"
            )
            return None

        # Create MCP client with bot configuration
        client = MCPClient(bot_servers)
        try:
            await asyncio.wait_for(client.connect(), timeout=30.0)
            logger.info(
                f"[OPENAPI_MCP] Loaded {len(client.get_tools())} bot MCP tools "
                f"from {len(bot_servers)} servers for task {task_id} (bot={bot_namespace}/{bot_name})"
            )
            return client
        except asyncio.TimeoutError:
            logger.error(
                f"[OPENAPI_MCP] Timeout connecting to bot MCP servers for task {task_id}"
            )
            return None
        except Exception as e:
            logger.error(
                f"[OPENAPI_MCP] Failed to connect to bot MCP servers for task {task_id}: {e}"
            )
            return None

    except Exception:
        logger.exception(
            f"[OPENAPI_MCP] Unexpected error loading bot MCP tools for task {task_id}"
        )
        return None


async def _get_bot_mcp_servers(bot_name: str, bot_namespace: str) -> Dict[str, Any]:
    """Query bot's Ghost CRD to get MCP server configuration."""
    import asyncio

    return await asyncio.to_thread(_get_bot_mcp_servers_sync, bot_name, bot_namespace)


def _get_bot_mcp_servers_sync(bot_name: str, bot_namespace: str) -> Dict[str, Any]:
    """Synchronous implementation of bot MCP servers query."""
    from app.db.session import SessionLocal
    from app.models.kind import Kind
    from app.schemas.kind import Bot, Ghost

    db = SessionLocal()
    try:
        # Query bot Kind
        bot_kind = (
            db.query(Kind)
            .filter(
                Kind.kind == "Bot",
                Kind.name == bot_name,
                Kind.namespace == bot_namespace,
                Kind.is_active,
            )
            .first()
        )

        if not bot_kind or not bot_kind.json:
            return {}

        # Parse Bot CRD to get ghostRef
        bot_crd = Bot.model_validate(bot_kind.json)
        if not bot_crd.spec or not bot_crd.spec.ghostRef:
            return {}

        ghost_name = bot_crd.spec.ghostRef.name
        ghost_namespace = bot_crd.spec.ghostRef.namespace

        # Query Ghost Kind
        ghost_kind = (
            db.query(Kind)
            .filter(
                Kind.kind == "Ghost",
                Kind.name == ghost_name,
                Kind.namespace == ghost_namespace,
                Kind.is_active,
            )
            .first()
        )

        if not ghost_kind or not ghost_kind.json:
            return {}

        # Parse Ghost CRD to get mcpServers
        ghost_crd = Ghost.model_validate(ghost_kind.json)
        if not ghost_crd.spec or not ghost_crd.spec.mcpServers:
            return {}

        return ghost_crd.spec.mcpServers

    except Exception:
        logger.exception(
            f"[OPENAPI_MCP] Failed to query bot MCP servers for {bot_namespace}/{bot_name}"
        )
        return {}
    finally:
        db.close()
