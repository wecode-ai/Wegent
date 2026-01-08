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

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from chat_shell.core.config import settings

logger = logging.getLogger(__name__)


async def load_mcp_tools(
    task_id: int,
    bot_name: str = "",
    bot_namespace: str = "default",
    task_data: dict[str, Any] | None = None,
    db: AsyncSession | None = None,
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
        task_data: Task data containing MCP configuration
        db: Async database session

    Returns:
        MCPClient instance or None if no MCP servers configured
    """
    try:
        from chat_shell.tools.mcp import MCPClient

        # Step 1: Load backend MCP configuration from CHAT_MCP_SERVERS
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
        if bot_name and bot_namespace and db:
            try:
                bot_servers = await asyncio.wait_for(
                    _get_bot_mcp_servers(bot_name, bot_namespace, db), timeout=5.0
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

        # Step 3: Merge configurations
        # Priority: bot_servers > backend_servers
        merged_servers = {**backend_servers, **bot_servers}

        if not merged_servers:
            return None

        logger.info(
            "[MCP] Merged MCP configuration: %d servers for task %d",
            len(merged_servers),
            task_id,
        )

        # Step 4: Create MCP client with merged configuration
        client = MCPClient(merged_servers, task_data=task_data)
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


async def _get_bot_mcp_servers(
    bot_name: str, bot_namespace: str, db: AsyncSession
) -> dict[str, Any]:
    """Query bot's Ghost CRD to get MCP server configuration."""
    from chat_shell.db_models.kind import Kind
    from chat_shell.schemas.kind import Ghost

    try:
        # Query bot Kind
        result = await db.execute(
            select(Kind).filter(
                Kind.kind == "Bot",
                Kind.name == bot_name,
                Kind.namespace == bot_namespace,
                Kind.is_active == True,  # noqa: E712
            )
        )
        bot_kind = result.scalars().first()

        if not bot_kind or not bot_kind.json:
            return {}

        # Parse Bot CRD to get ghostRef
        bot_data = bot_kind.json
        ghost_ref = bot_data.get("spec", {}).get("ghostRef", {})
        if not ghost_ref:
            return {}

        ghost_name = ghost_ref.get("name")
        ghost_namespace = ghost_ref.get("namespace", "default")

        if not ghost_name:
            return {}

        # Query Ghost Kind
        result = await db.execute(
            select(Kind).filter(
                Kind.kind == "Ghost",
                Kind.name == ghost_name,
                Kind.namespace == ghost_namespace,
                Kind.is_active == True,  # noqa: E712
            )
        )
        ghost_kind = result.scalars().first()

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
