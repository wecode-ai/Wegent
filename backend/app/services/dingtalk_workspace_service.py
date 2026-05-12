# SPDX-FileCopyrightText: 2025 ZINFOID_00AQ, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""DingTalk knowledge base (workspace) sync service.

Syncs DingTalk workspace nodes from the user's workspace MCP server into the
local database with source='workspace'.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

from app.models.dingtalk_doc import DingtalkSyncedNode
from app.models.user import User
from app.services.dingtalk_doc_service import DingTalkDocService
from app.services.user_mcp_service import UserMCPService

logger = logging.getLogger(__name__)

# Source identifier for workspace nodes
WORKSPACE_SOURCE = "workspace"


class DingTalkWorkspaceService:
    """Service for syncing and querying DingTalk knowledge base (workspace) nodes."""

    @staticmethod
    def get_user_workspace_mcp_url(user: User, db: Session) -> str | None:
        """Read and decrypt the user's DingTalk Workspace MCP URL from preferences."""
        config = UserMCPService.get_provider_service_config(
            user.preferences,
            provider_id="dingtalk",
            service_id="workspace",
        )
        if not config.get("enabled"):
            return None
        url = (config.get("url") or "").strip()
        return url if url else None

    @staticmethod
    def is_configured(user: User, db: Session) -> bool:
        """Check if the user has DingTalk Workspace MCP configured and enabled."""
        return DingTalkWorkspaceService.get_user_workspace_mcp_url(user, db) is not None

    @staticmethod
    async def sync_workspace_nodes(user: User, db: Session) -> dict[str, Any]:
        """Sync DingTalk workspace nodes from the user's workspace MCP server.

        Returns a dict with sync statistics: added, updated, deleted, total.
        """
        mcp_url = DingTalkWorkspaceService.get_user_workspace_mcp_url(user, db)
        if not mcp_url:
            raise ValueError(
                "DingTalk Workspace MCP URL is not configured or not enabled"
            )

        all_nodes = await DingTalkWorkspaceService._fetch_all_workspace_nodes(mcp_url)

        if len(all_nodes) > 5000:
            logger.warning(
                "User %s has %d DingTalk workspace nodes, truncating to 5000",
                user.id,
                len(all_nodes),
            )
            all_nodes = all_nodes[:5000]

        now = datetime.now()
        stats = DingTalkDocService._sync_nodes_to_db(
            user.id, all_nodes, now, db, source=WORKSPACE_SOURCE
        )
        return stats

    @staticmethod
    async def _fetch_all_workspace_nodes(mcp_url: str) -> list[dict[str, Any]]:
        """Fetch all workspace nodes from the DingTalk Workspace MCP server.

        The workspace MCP's list_nodes without params returns knowledge bases
        as top-level nodes. We then recursively fetch their content.
        """
        try:
            from mcp import ClientSession
            from mcp.client.streamable_http import streamablehttp_client
        except ImportError:
            logger.error("mcp package not available for DingTalk workspace sync")
            raise

        all_nodes: list[dict[str, Any]] = []

        async with streamablehttp_client(url=mcp_url) as (
            read_stream,
            write_stream,
            _,
        ):
            async with ClientSession(read_stream, write_stream) as session:
                await session.initialize()
                await DingTalkDocService._list_nodes_recursive(
                    session,
                    folder_id=None,
                    workspace_id=None,
                    all_nodes=all_nodes,
                    depth=0,
                )

        return all_nodes

    @staticmethod
    def get_workspace_nodes(user_id: int, db: Session) -> list[DingtalkSyncedNode]:
        """Get all active DingTalk workspace nodes for a user."""
        return (
            db.query(DingtalkSyncedNode)
            .filter(
                DingtalkSyncedNode.user_id == user_id,
                DingtalkSyncedNode.source == WORKSPACE_SOURCE,
                DingtalkSyncedNode.is_active == True,  # noqa: E712
            )
            .order_by(DingtalkSyncedNode.node_type, DingtalkSyncedNode.name)
            .all()
        )

    @staticmethod
    def get_sync_status(user: User, db: Session) -> dict[str, Any]:
        """Get sync status for a user's DingTalk workspace nodes."""
        is_configured = DingTalkWorkspaceService.is_configured(user, db)

        last_synced = (
            db.query(DingtalkSyncedNode.last_synced_at)
            .filter(
                DingtalkSyncedNode.user_id == user.id,
                DingtalkSyncedNode.source == WORKSPACE_SOURCE,
                DingtalkSyncedNode.is_active == True,  # noqa: E712
            )
            .order_by(DingtalkSyncedNode.last_synced_at.desc())
            .first()
        )

        total = (
            db.query(DingtalkSyncedNode)
            .filter(
                DingtalkSyncedNode.user_id == user.id,
                DingtalkSyncedNode.source == WORKSPACE_SOURCE,
                DingtalkSyncedNode.is_active == True,  # noqa: E712
            )
            .count()
        )

        return {
            "last_synced_at": last_synced[0] if last_synced else None,
            "total_nodes": total,
            "is_configured": is_configured,
        }


dingtalk_workspace_service = DingTalkWorkspaceService()
