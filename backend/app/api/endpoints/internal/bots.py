# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Internal Bot API endpoints for chat_shell service.

Provides endpoints to query bot configurations for chat_shell HTTP mode.
These endpoints are intended for service-to-service communication.
"""

import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.models.kind import Kind
from app.schemas.kind import Bot, Ghost

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/bots", tags=["internal-bots"])


class MCPServersResponse(BaseModel):
    """Response for bot MCP servers configuration."""

    bot_name: str
    bot_namespace: str
    mcp_servers: dict[str, Any] = Field(
        default_factory=dict, description="MCP servers configuration from Ghost CRD"
    )


@router.get("/{bot_name}/mcp", response_model=MCPServersResponse)
async def get_bot_mcp_servers(
    bot_name: str,
    namespace: str = Query(default="default", description="Bot namespace"),
    db: Session = Depends(get_db),
):
    """
    Get MCP servers configuration for a bot.

    Queries the bot's Ghost CRD to retrieve mcpServers configuration.

    Args:
        bot_name: Name of the bot
        namespace: Bot namespace (default: "default")
        db: Database session

    Returns:
        MCPServersResponse with the mcp_servers dict from Ghost CRD
    """
    try:
        # Query bot Kind
        bot_kind = (
            db.query(Kind)
            .filter(
                Kind.kind == "Bot",
                Kind.name == bot_name,
                Kind.namespace == namespace,
                Kind.is_active == True,  # noqa: E712
            )
            .first()
        )

        if not bot_kind or not bot_kind.json:
            logger.debug(
                "[internal/bots] Bot not found: %s/%s",
                namespace,
                bot_name,
            )
            return MCPServersResponse(
                bot_name=bot_name,
                bot_namespace=namespace,
                mcp_servers={},
            )

        # Parse Bot CRD to get ghostRef
        try:
            bot_crd = Bot.model_validate(bot_kind.json)
        except Exception as e:
            logger.warning(
                "[internal/bots] Failed to parse Bot CRD for %s/%s: %s",
                namespace,
                bot_name,
                e,
            )
            return MCPServersResponse(
                bot_name=bot_name,
                bot_namespace=namespace,
                mcp_servers={},
            )

        if not bot_crd.spec or not bot_crd.spec.ghostRef:
            logger.debug(
                "[internal/bots] Bot %s/%s has no ghostRef",
                namespace,
                bot_name,
            )
            return MCPServersResponse(
                bot_name=bot_name,
                bot_namespace=namespace,
                mcp_servers={},
            )

        ghost_name = bot_crd.spec.ghostRef.name
        ghost_namespace = bot_crd.spec.ghostRef.namespace or "default"

        # Query Ghost Kind
        ghost_kind = (
            db.query(Kind)
            .filter(
                Kind.kind == "Ghost",
                Kind.name == ghost_name,
                Kind.namespace == ghost_namespace,
                Kind.is_active == True,  # noqa: E712
            )
            .first()
        )

        if not ghost_kind or not ghost_kind.json:
            logger.debug(
                "[internal/bots] Ghost not found for bot %s/%s: ghost=%s/%s",
                namespace,
                bot_name,
                ghost_namespace,
                ghost_name,
            )
            return MCPServersResponse(
                bot_name=bot_name,
                bot_namespace=namespace,
                mcp_servers={},
            )

        # Parse Ghost CRD to get mcpServers
        try:
            ghost_crd = Ghost.model_validate(ghost_kind.json)
        except Exception as e:
            logger.warning(
                "[internal/bots] Failed to parse Ghost CRD for %s/%s: %s",
                ghost_namespace,
                ghost_name,
                e,
            )
            return MCPServersResponse(
                bot_name=bot_name,
                bot_namespace=namespace,
                mcp_servers={},
            )

        mcp_servers = {}
        if ghost_crd.spec and ghost_crd.spec.mcpServers:
            mcp_servers = ghost_crd.spec.mcpServers

        logger.info(
            "[internal/bots] Retrieved MCP config for %s/%s: %d servers",
            namespace,
            bot_name,
            len(mcp_servers),
        )

        return MCPServersResponse(
            bot_name=bot_name,
            bot_namespace=namespace,
            mcp_servers=mcp_servers,
        )

    except Exception as e:
        logger.exception(
            "[internal/bots] Failed to get MCP servers for %s/%s",
            namespace,
            bot_name,
        )
        raise HTTPException(
            status_code=500,
            detail=f"Failed to query MCP servers: {str(e)}",
        )
