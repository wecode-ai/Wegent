# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""MCP tool loader for Chat Service.

This module provides functions to load MCP tools from backend configuration
and bot's Ghost CRD (via backend API).
"""

import asyncio
import json
import logging
from typing import Any

import httpx

from chat_shell.core.config import settings

logger = logging.getLogger(__name__)


async def load_mcp_tools(
    task_id: int,
    bot_name: str = "",
    bot_namespace: str = "default",
    task_data: dict[str, Any] | None = None,
) -> Any:
    """Load MCP tools for a task.

    This function:
    1. Loads backend MCP configuration from CHAT_MCP_SERVERS setting
    2. Loads bot's MCP configuration from backend API (not direct DB access)
    3. Merges configurations (bot config takes precedence)
    4. Creates and connects MCP client

    Args:
        task_id: Task ID for logging
        bot_name: Bot name for Ghost CRD lookup
        bot_namespace: Bot namespace
        task_data: Task data containing MCP configuration

    Returns:
        MCPClient instance or None if no MCP servers configured
    """
    logger.info(
        "[MCP] Loading MCP tools for task %d, bot=%s/%s",
        task_id,
        bot_namespace,
        bot_name or "(none)",
    )

    try:
        from chat_shell.tools.mcp import MCPClient

        # Step 1: Load backend MCP configuration from CHAT_MCP_SERVERS
        backend_servers = {}
        mcp_servers_config = getattr(settings, "CHAT_MCP_SERVERS", "")
        if mcp_servers_config:
            try:
                config_data = json.loads(mcp_servers_config)
                backend_servers = config_data.get("mcpServers", config_data)
                logger.info(
                    "[MCP] Loaded %d backend MCP servers from CHAT_MCP_SERVERS: %s",
                    len(backend_servers),
                    list(backend_servers.keys()),
                )
            except json.JSONDecodeError as e:
                logger.warning("[MCP] Failed to parse CHAT_MCP_SERVERS: %s", str(e))
        else:
            logger.debug("[MCP] No CHAT_MCP_SERVERS configured")

        # Step 2: Load bot's MCP configuration via backend API
        bot_servers = {}
        if bot_name and bot_namespace:
            logger.info(
                "[MCP] Fetching bot MCP servers from backend API for %s/%s",
                bot_namespace,
                bot_name,
            )
            try:
                bot_servers = await asyncio.wait_for(
                    _get_bot_mcp_servers(bot_name, bot_namespace), timeout=5.0
                )
                if bot_servers:
                    logger.info(
                        "[MCP] Retrieved %d bot MCP servers from API: %s",
                        len(bot_servers),
                        list(bot_servers.keys()),
                    )
                else:
                    logger.info(
                        "[MCP] No bot MCP servers configured for %s/%s",
                        bot_namespace,
                        bot_name,
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
        else:
            logger.debug("[MCP] No bot name provided, skipping bot MCP lookup")

        # Step 3: Merge configurations
        # Priority: bot_servers > backend_servers
        merged_servers = {**backend_servers, **bot_servers}

        if not merged_servers:
            logger.info("[MCP] No MCP servers configured for task %d", task_id)
            return None

        logger.info(
            "[MCP] Merged MCP configuration for task %d: %d servers (%s)",
            task_id,
            len(merged_servers),
            list(merged_servers.keys()),
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


async def _get_bot_mcp_servers(bot_name: str, bot_namespace: str) -> dict[str, Any]:
    """Query bot's MCP server configuration via backend API.

    Args:
        bot_name: Name of the bot
        bot_namespace: Namespace of the bot

    Returns:
        MCP servers configuration dict
    """
    base_url = settings.REMOTE_STORAGE_URL.rstrip("/")
    auth_token = settings.REMOTE_STORAGE_TOKEN

    # Build headers
    headers = {
        "X-Service-Name": "chat-shell",
        "Content-Type": "application/json",
    }
    if auth_token:
        headers["Authorization"] = f"Bearer {auth_token}"

    # Build URL: /internal/bots/{bot_name}/mcp?namespace={bot_namespace}
    url = f"{base_url}/bots/{bot_name}/mcp"
    params = {"namespace": bot_namespace}

    logger.debug(
        "[MCP] Calling backend API: GET %s?namespace=%s",
        url,
        bot_namespace,
    )

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(url, headers=headers, params=params)

            logger.debug(
                "[MCP] Backend API response: status=%d, content_length=%s",
                response.status_code,
                response.headers.get("content-length", "unknown"),
            )

            if response.status_code == 200:
                data = response.json()
                mcp_servers = data.get("mcp_servers", {})
                logger.info(
                    "[MCP] Backend API returned %d MCP servers for bot %s/%s",
                    len(mcp_servers),
                    bot_namespace,
                    bot_name,
                )
                return mcp_servers
            else:
                logger.warning(
                    "[MCP] Backend API returned status %d for bot %s/%s: %s",
                    response.status_code,
                    bot_namespace,
                    bot_name,
                    response.text[:200] if response.text else "empty response",
                )
                return {}

    except httpx.TimeoutException:
        logger.warning(
            "[MCP] Timeout calling backend API for bot %s/%s",
            bot_namespace,
            bot_name,
        )
        return {}
    except httpx.RequestError as e:
        logger.warning(
            "[MCP] Request error calling backend API for bot %s/%s: %s",
            bot_namespace,
            bot_name,
            str(e),
        )
        return {}
    except Exception:
        logger.exception(
            "[MCP] Failed to query bot MCP servers for %s/%s via API",
            bot_namespace,
            bot_name,
        )
        return {}
