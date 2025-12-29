# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""MCP tool loader for Chat Service.

This module provides functions to load MCP tools from backend configuration
and bot's Ghost CRD.
"""

import asyncio
import json
import logging
from typing import Any

from app.core.config import settings

logger = logging.getLogger(__name__)


async def load_mcp_tools(
    task_id: int, bot_name: str = "", bot_namespace: str = "default"
) -> Any:
    """Load MCP tools for a task.

    This function:
    1. Loads backend MCP configuration from CHAT_MCP_SERVERS setting
    2. Loads bot's MCP configuration from Ghost CRD
    3. Merges configurations (bot config takes precedence)
    4. Creates and connects MCP client

    Args:
        task_id: Task ID for logging
        bot_name: Bot name for Ghost CRD lookup
        bot_namespace: Bot namespace

    Returns:
        MCPClient instance or None if no MCP servers configured
    """
    try:
        from app.chat_shell.tools.mcp import MCPClient

        # Step 1: Load backend MCP configuration
        backend_servers = {}
        mcp_servers_config = getattr(settings, "CHAT_MCP_SERVERS", "")
        if mcp_servers_config:
            try:
                config_data = json.loads(mcp_servers_config)
                backend_servers = config_data.get("mcpServers", config_data)
            except json.JSONDecodeError as e:
                logger.warning("[MCP] Failed to parse CHAT_MCP_SERVERS: %s", str(e))

        # Step 2: Load bot's MCP configuration from Ghost CRD
        bot_servers = {}
        if bot_name and bot_namespace:
            try:
                bot_servers = await asyncio.wait_for(
                    _get_bot_mcp_servers(bot_name, bot_namespace), timeout=5.0
                )
            except asyncio.TimeoutError:
                logger.warning(
                    "[MCP] Timeout querying bot MCP servers for %s/%s",
                    bot_namespace,
                    bot_name,
                )
            except Exception as e:
                logger.warning(
                    "[MCP] Failed to load bot MCP servers for %s/%s: %s",
                    bot_namespace,
                    bot_name,
                    str(e),
                )

        # Step 3: Merge configurations (bot config takes precedence)
        merged_servers = {**backend_servers, **bot_servers}

        if not merged_servers:
            return None

        logger.info(
            "[MCP] Merged MCP configuration: %d servers for task %d",
            len(merged_servers),
            task_id,
        )

        # Step 4: Create MCP client with merged configuration
        client = MCPClient(merged_servers)
        try:
            await asyncio.wait_for(client.connect(), timeout=30.0)
            logger.info(
                "[MCP] Loaded %d tools from %d MCP servers for task %d",
                len(client.get_tools()),
                len(merged_servers),
                task_id,
            )
            return client
        except asyncio.TimeoutError:
            logger.error("[MCP] Timeout connecting to MCP servers for task %d", task_id)
            return None
        except Exception as e:
            logger.error(
                "[MCP] Failed to connect to MCP servers for task %d: %s",
                task_id,
                str(e),
            )
            return None

    except Exception:
        logger.exception(
            "[MCP] Unexpected error loading MCP tools for task %d", task_id
        )
        return None


async def _get_bot_mcp_servers(bot_name: str, bot_namespace: str) -> dict[str, Any]:
    """Query bot's Ghost CRD to get MCP server configuration."""
    return await asyncio.to_thread(_get_bot_mcp_servers_sync, bot_name, bot_namespace)


def _get_bot_mcp_servers_sync(bot_name: str, bot_namespace: str) -> dict[str, Any]:
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
            "[MCP] Failed to query bot MCP servers for %s/%s",
            bot_namespace,
            bot_name,
        )
        return {}
    finally:
        db.close()
