# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""DingTalk document sync service.

Syncs DingTalk document nodes from the user's MCP server into the local database.
Uses the MCP client protocol to connect to the user's DingTalk Docs MCP server URL.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from app.models.dingtalk_doc import DingtalkSyncedNode
from app.models.user import User
from app.services.user_mcp_service import UserMCPService

logger = logging.getLogger(__name__)

# MCP tool names for DingTalk Docs
MCP_TOOL_LIST_NODES = "list_nodes"
MCP_TOOL_SEARCH_DOCUMENTS = "search_documents"

# Maximum recursion depth for folder traversal
MAX_RECURSION_DEPTH = 10

# Maximum nodes to sync per user (safety limit)
MAX_NODES_PER_SYNC = 5000


class DingTalkDocService:
    """Service for syncing and querying DingTalk document nodes."""

    @staticmethod
    def get_user_dingtalk_mcp_url(user: User, db: Session) -> str | None:
        """Read and decrypt the user's DingTalk Docs MCP URL from preferences.

        Returns the decrypted URL if configured and enabled, None otherwise.
        """
        config = UserMCPService.get_provider_service_config(
            user.preferences,
            provider_id="dingtalk",
            service_id="docs",
        )
        if not config.get("enabled"):
            return None
        url = (config.get("url") or "").strip()
        return url if url else None

    @staticmethod
    def is_configured(user: User, db: Session) -> bool:
        """Check if the user has DingTalk Docs MCP configured and enabled."""
        return DingTalkDocService.get_user_dingtalk_mcp_url(user, db) is not None

    @staticmethod
    async def sync_dingtalk_docs(user: User, db: Session) -> dict[str, Any]:
        """Sync DingTalk document nodes from the user's MCP server.

        Connects to the user's DingTalk Docs MCP server, recursively lists all
        document nodes, and updates the local database.

        Returns a dict with sync statistics: added, updated, deleted, total.
        """
        mcp_url = DingTalkDocService.get_user_dingtalk_mcp_url(user, db)
        if not mcp_url:
            raise ValueError("DingTalk Docs MCP URL is not configured or not enabled")

        # Fetch all nodes from MCP server
        all_nodes = await DingTalkDocService._fetch_all_nodes(mcp_url)

        if len(all_nodes) > MAX_NODES_PER_SYNC:
            logger.warning(
                "User %s has %d DingTalk nodes, truncating to %d",
                user.id,
                len(all_nodes),
                MAX_NODES_PER_SYNC,
            )
            all_nodes = all_nodes[:MAX_NODES_PER_SYNC]

        # Sync to database
        now = datetime.now(timezone.utc)
        stats = DingTalkDocService._sync_nodes_to_db(user.id, all_nodes, now, db)

        return stats

    @staticmethod
    async def _fetch_all_nodes(mcp_url: str) -> list[dict[str, Any]]:
        """Fetch all document nodes from the DingTalk MCP server.

        Uses the MCP client protocol to connect and call list_nodes recursively.
        """
        try:
            from mcp import ClientSession
            from mcp.client.streamable_http import streamablehttp_client
        except ImportError:
            logger.error("mcp package not available for DingTalk doc sync")
            raise

        all_nodes: list[dict[str, Any]] = []

        async with streamablehttp_client(url=mcp_url) as (
            read_stream,
            write_stream,
            _,
        ):
            async with ClientSession(read_stream, write_stream) as session:
                await session.initialize()

                # Start from root (no folderId, no workspaceId)
                await DingTalkDocService._list_nodes_recursive(
                    session,
                    folder_id=None,
                    workspace_id=None,
                    all_nodes=all_nodes,
                    depth=0,
                )

        return all_nodes

    @staticmethod
    async def _list_nodes_recursive(
        session: Any,
        folder_id: str | None,
        workspace_id: str | None,
        all_nodes: list[dict[str, Any]],
        depth: int,
    ) -> None:
        """Recursively list nodes from the MCP server.

        Traverses folders by calling list_nodes for each folder found.
        """
        if depth > MAX_RECURSION_DEPTH:
            logger.warning(
                "Max recursion depth %d reached at folder %s",
                depth,
                folder_id,
            )
            return

        page_token = None
        while True:
            # Build arguments for list_nodes tool
            args: dict[str, Any] = {"pageSize": 50}
            if folder_id:
                args["folderId"] = folder_id
            if workspace_id:
                args["workspaceId"] = workspace_id
            if page_token:
                args["pageToken"] = page_token

            result = await session.call_tool(MCP_TOOL_LIST_NODES, args)

            # Parse the result - MCP returns content items
            nodes_data = DingTalkDocService._parse_list_nodes_result(result)
            all_nodes.extend(nodes_data)

            # Recursively traverse folders
            for node in nodes_data:
                if node.get("nodeType") == "folder" and node.get("hasChildren"):
                    node_id = node.get("nodeId", "")
                    ws_id = node.get("workspaceId") or workspace_id
                    await DingTalkDocService._list_nodes_recursive(
                        session,
                        folder_id=node_id,
                        workspace_id=ws_id,
                        all_nodes=all_nodes,
                        depth=depth + 1,
                    )

            # Check for more pages
            page_token = None
            # The pagination info may be in the result metadata
            if hasattr(result, "meta") and result.meta:
                page_token = result.meta.get("nextPageToken")
            if not page_token:
                break

    @staticmethod
    def _parse_list_nodes_result(result: Any) -> list[dict[str, Any]]:
        """Parse the result from MCP list_nodes tool call.

        The MCP tool returns content items that contain the node list data.
        """
        nodes: list[dict[str, Any]] = []

        if not hasattr(result, "content") or not result.content:
            return nodes

        for content_item in result.content:
            # Text content contains JSON data
            if hasattr(content_item, "type") and content_item.type == "text":
                import json

                try:
                    data = json.loads(content_item.text)
                    if isinstance(data, list):
                        nodes.extend(data)
                    elif isinstance(data, dict):
                        # Could be wrapped in a response object
                        items = data.get("items") or data.get("nodes") or []
                        if isinstance(items, list):
                            nodes.extend(items)
                        # Also check for pagination token
                        if "nextPageToken" in data:
                            # Store for parent to handle
                            pass
                except (json.JSONDecodeError, TypeError):
                    logger.warning("Failed to parse list_nodes result content")

        return nodes

    @staticmethod
    def _sync_nodes_to_db(
        user_id: int,
        nodes: list[dict[str, Any]],
        sync_time: datetime,
        db: Session,
    ) -> dict[str, Any]:
        """Sync fetched nodes to the database.

        Compares with existing records and performs add/update/delete operations.
        """
        added = 0
        updated = 0
        deleted = 0

        # Build a map of current DingTalk node IDs
        dingtalk_node_ids = set()
        for node_data in nodes:
            node_id = node_data.get("nodeId", "")
            if not node_id:
                continue
            dingtalk_node_ids.add(node_id)

        # Mark nodes no longer in DingTalk as inactive
        existing_active = (
            db.query(DingtalkSyncedNode)
            .filter(
                DingtalkSyncedNode.user_id == user_id,
                DingtalkSyncedNode.is_active == True,  # noqa: E712
            )
            .all()
        )

        for existing in existing_active:
            if existing.dingtalk_node_id not in dingtalk_node_ids:
                existing.is_active = False
                existing.updated_at = sync_time
                deleted += 1

        # Upsert nodes from DingTalk
        for node_data in nodes:
            node_id = node_data.get("nodeId", "")
            if not node_id:
                continue

            name = node_data.get("name", node_data.get("title", "Untitled"))
            node_type_raw = node_data.get("nodeType", "doc")

            # Map node type
            if node_type_raw == "folder":
                node_type = "folder"
            elif node_type_raw == "file":
                node_type = "file"
            else:
                node_type = "doc"

            # Build document URL
            doc_url = node_data.get("url", "")
            if not doc_url:
                doc_url = f"https://alidocs.dingtalk.com/i/nodes/{node_id}"

            parent_node_id = node_data.get("parentId") or node_data.get(
                "parentDentryUuid"
            )
            workspace_id = node_data.get("workspaceId")
            content_type = node_data.get("contentType")
            extension = node_data.get("extension")

            # Check if node already exists
            existing = (
                db.query(DingtalkSyncedNode)
                .filter(
                    DingtalkSyncedNode.user_id == user_id,
                    DingtalkSyncedNode.dingtalk_node_id == node_id,
                )
                .first()
            )

            if existing:
                # Update existing node
                changed = False
                if existing.name != name:
                    existing.name = name
                    changed = True
                if existing.doc_url != doc_url:
                    existing.doc_url = doc_url
                    changed = True
                if existing.parent_node_id != parent_node_id:
                    existing.parent_node_id = parent_node_id
                    changed = True
                if existing.node_type != node_type:
                    existing.node_type = node_type
                    changed = True
                if existing.workspace_id != workspace_id:
                    existing.workspace_id = workspace_id
                    changed = True
                if existing.content_type != content_type:
                    existing.content_type = content_type
                    changed = True
                if existing.extension != extension:
                    existing.extension = extension
                    changed = True
                if not existing.is_active:
                    existing.is_active = True
                    changed = True

                if changed:
                    existing.last_synced_at = sync_time
                    existing.updated_at = sync_time
                    updated += 1
                else:
                    existing.last_synced_at = sync_time
            else:
                # Create new node
                new_node = DingtalkSyncedNode(
                    user_id=user_id,
                    dingtalk_node_id=node_id,
                    name=name,
                    doc_url=doc_url,
                    parent_node_id=parent_node_id,
                    node_type=node_type,
                    workspace_id=workspace_id,
                    content_type=content_type,
                    extension=extension,
                    is_active=True,
                    last_synced_at=sync_time,
                )
                db.add(new_node)
                added += 1

        db.commit()

        total = (
            db.query(DingtalkSyncedNode)
            .filter(
                DingtalkSyncedNode.user_id == user_id,
                DingtalkSyncedNode.is_active == True,  # noqa: E712
            )
            .count()
        )

        return {
            "added": added,
            "updated": updated,
            "deleted": deleted,
            "total": total,
            "sync_time": sync_time,
        }

    @staticmethod
    def get_dingtalk_docs(user_id: int, db: Session) -> list[DingtalkSyncedNode]:
        """Get all active DingTalk document nodes for a user."""
        return (
            db.query(DingtalkSyncedNode)
            .filter(
                DingtalkSyncedNode.user_id == user_id,
                DingtalkSyncedNode.is_active == True,  # noqa: E712
            )
            .order_by(DingtalkSyncedNode.node_type, DingtalkSyncedNode.name)
            .all()
        )

    @staticmethod
    def get_sync_status(user: User, db: Session) -> dict[str, Any]:
        """Get sync status for a user's DingTalk documents."""
        is_configured = DingTalkDocService.is_configured(user, db)

        last_synced = (
            db.query(DingtalkSyncedNode.last_synced_at)
            .filter(
                DingtalkSyncedNode.user_id == user.id,
                DingtalkSyncedNode.is_active == True,  # noqa: E712
            )
            .order_by(DingtalkSyncedNode.last_synced_at.desc())
            .first()
        )

        total = (
            db.query(DingtalkSyncedNode)
            .filter(
                DingtalkSyncedNode.user_id == user.id,
                DingtalkSyncedNode.is_active == True,  # noqa: E712
            )
            .count()
        )

        return {
            "last_synced_at": last_synced[0] if last_synced else None,
            "total_nodes": total,
            "is_configured": is_configured,
        }

    @staticmethod
    def delete_synced_node(node_id: int, user_id: int, db: Session) -> bool:
        """Delete a synced document node (local cache only)."""
        node = (
            db.query(DingtalkSyncedNode)
            .filter(
                DingtalkSyncedNode.id == node_id,
                DingtalkSyncedNode.user_id == user_id,
            )
            .first()
        )
        if not node:
            return False

        db.delete(node)
        db.commit()
        return True


dingtalk_doc_service = DingTalkDocService()
