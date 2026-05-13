# SPDX-FileCopyrightText: 2025 ZINFOID_00AQ, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""DingTalk knowledge base (workspace) sync service.

Syncs DingTalk workspace nodes from the user's workspace MCP server into the
local database with source='workspace'.

The 钉钉知识库 MCP (mcpId=9730) uses DIFFERENT tool names from the docs MCP:
  - list_wikiSpaces  → list accessible knowledge bases
  - get_wikiSpace    → get a single KB's metadata
  - search_wikiSpaces → search KBs by keyword

To list DOCUMENTS within a knowledge base we use the docs MCP tool:
  - list_nodes(workspaceId=<kb_id>) → list files/folders inside a KB

This service therefore performs a two-phase sync:
  Phase 1: workspace MCP  → list_wikiSpaces  → KB list
  Phase 2: docs MCP       → list_nodes(workspaceId=) → documents in each KB
           (falls back to workspace MCP URL if docs MCP is not configured)
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

from app.models.dingtalk_doc import DingtalkSyncedNode
from app.models.user import User
from app.services.dingtalk_doc_service import (
    MAX_RECURSION_DEPTH,
    MCP_TOOL_LIST_NODES,
    DingTalkDocService,
)
from app.services.user_mcp_service import UserMCPService

logger = logging.getLogger(__name__)

# Source identifier for workspace nodes
WORKSPACE_SOURCE = "workspace"

# Tool name on the 知识库 MCP for listing knowledge bases
MCP_TOOL_LIST_WIKI_SPACES = "list_wikiSpaces"

# wiki space type value for org-level KBs (as opposed to "myWikiSpace")
WIKI_SPACE_TYPE_ORG = "orgWikiSpace"


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

        Uses a two-phase approach:
          1. workspace MCP  → list_wikiSpaces → knowledge base IDs
          2. docs MCP       → list_nodes(workspaceId=) → documents in each KB

        Returns a dict with sync statistics: added, updated, deleted, total,
        mcp_nodes_fetched.
        """
        workspace_mcp_url = DingTalkWorkspaceService.get_user_workspace_mcp_url(
            user, db
        )
        if not workspace_mcp_url:
            raise ValueError(
                "DingTalk Workspace MCP URL is not configured or not enabled"
            )

        # Docs MCP URL is optional; falls back to workspace MCP URL if absent.
        docs_mcp_url = DingTalkDocService.get_user_dingtalk_mcp_url(user, db)

        all_nodes = await DingTalkWorkspaceService._fetch_all_workspace_nodes(
            workspace_mcp_url=workspace_mcp_url,
            docs_mcp_url=docs_mcp_url,
        )

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
        stats["mcp_nodes_fetched"] = len(all_nodes)
        return stats

    # ------------------------------------------------------------------
    # Phase 1 helpers: list knowledge bases via workspace MCP
    # ------------------------------------------------------------------

    @staticmethod
    async def _list_wiki_spaces(workspace_mcp_url: str) -> list[dict[str, Any]]:
        """Call list_wikiSpaces on the workspace MCP and return all KB entries.

        Paginates automatically. Logs available tools and raw responses to aid
        debugging in case the MCP server returns unexpected data.
        """
        try:
            from mcp import ClientSession
            from mcp.client.streamable_http import streamablehttp_client
        except ImportError:
            logger.error("mcp package not available for DingTalk workspace sync")
            raise

        kb_nodes: list[dict[str, Any]] = []

        async with streamablehttp_client(url=workspace_mcp_url) as (
            read_stream,
            write_stream,
            _,
        ):
            async with ClientSession(read_stream, write_stream) as session:
                await session.initialize()

                # Log all available tools so we know what this server exposes.
                try:
                    tools_result = await session.list_tools()
                    tool_names: list[str] = []
                    if hasattr(tools_result, "tools"):
                        tool_names = [
                            t.name
                            for t in tools_result.tools
                            if hasattr(t, "name")
                        ]
                    elif isinstance(tools_result, list):
                        tool_names = [
                            t.get("name", "")
                            for t in tools_result
                            if isinstance(t, dict)
                        ]
                    logger.info(
                        "DingTalk workspace MCP exposes %d tools: %s",
                        len(tool_names),
                        tool_names,
                    )
                except Exception as exc:
                    logger.warning(
                        "Could not list workspace MCP tools: %s",
                        exc,
                    )

                # Paginate through all org-level knowledge bases.
                page_token: str | None = None
                first_call = True
                while True:
                    args: dict[str, Any] = {
                        "wikiSpaceType": WIKI_SPACE_TYPE_ORG,
                        "pageSize": 50,
                    }
                    if page_token:
                        args["pageToken"] = page_token

                    result = await session.call_tool(MCP_TOOL_LIST_WIKI_SPACES, args)

                    # Log raw response on the first call to enable offline diagnosis.
                    if first_call:
                        first_call = False
                        try:
                            raw_repr = repr(result)
                            logger.info(
                                "list_wikiSpaces raw response "
                                "(first 2000 chars): %.2000s",
                                raw_repr,
                            )
                        except Exception:
                            pass

                    batch, page_token = DingTalkDocService._parse_list_nodes_result(
                        result
                    )
                    kb_nodes.extend(batch)
                    if not page_token:
                        break

        logger.info(
            "list_wikiSpaces returned %d knowledge bases",
            len(kb_nodes),
        )
        return kb_nodes

    # ------------------------------------------------------------------
    # Phase 2 helpers: list documents inside each KB via docs MCP
    # ------------------------------------------------------------------

    @staticmethod
    async def _list_nodes_in_workspace(
        docs_mcp_url: str,
        workspace_id: str,
        all_nodes: list[dict[str, Any]],
    ) -> None:
        """Open a docs MCP session and recursively list all nodes in the given KB.

        Uses list_nodes(workspaceId=workspace_id) which is the correct way to
        enumerate documents inside a 知识库 knowledge base.
        """
        try:
            from mcp import ClientSession
            from mcp.client.streamable_http import streamablehttp_client
        except ImportError:
            logger.error("mcp package not available for DingTalk workspace sync")
            raise

        async with streamablehttp_client(url=docs_mcp_url) as (
            read_stream,
            write_stream,
            _,
        ):
            async with ClientSession(read_stream, write_stream) as session:
                await session.initialize()

                # Log the first response for this KB for debugging.
                first_args: dict[str, Any] = {
                    "workspaceId": workspace_id,
                    "pageSize": 50,
                }
                first_result = await session.call_tool(MCP_TOOL_LIST_NODES, first_args)
                try:
                    logger.info(
                        "list_nodes(workspaceId=%s) first response "
                        "(first 1000 chars): %.1000s",
                        workspace_id,
                        repr(first_result),
                    )
                except Exception:
                    pass

                first_batch, first_token = DingTalkDocService._parse_list_nodes_result(
                    first_result
                )
                all_nodes.extend(first_batch)

                # Recurse into sub-folders found in the first batch.
                for node in first_batch:
                    if node.get("nodeType") == "folder":
                        ws_id = node.get("workspaceId") or workspace_id
                        node_id = node.get("nodeId", "")
                        await DingTalkDocService._list_nodes_recursive(
                            session,
                            folder_id=node_id,
                            workspace_id=ws_id,
                            all_nodes=all_nodes,
                            depth=1,
                        )

                # Continue paging the root level if there are more pages.
                page_token = first_token
                while page_token:
                    args: dict[str, Any] = {
                        "workspaceId": workspace_id,
                        "pageSize": 50,
                        "pageToken": page_token,
                    }
                    result = await session.call_tool(MCP_TOOL_LIST_NODES, args)
                    batch, page_token = DingTalkDocService._parse_list_nodes_result(
                        result
                    )
                    all_nodes.extend(batch)
                    for node in batch:
                        if node.get("nodeType") == "folder":
                            ws_id = node.get("workspaceId") or workspace_id
                            node_id = node.get("nodeId", "")
                            await DingTalkDocService._list_nodes_recursive(
                                session,
                                folder_id=node_id,
                                workspace_id=ws_id,
                                all_nodes=all_nodes,
                                depth=1,
                            )

    # ------------------------------------------------------------------
    # Main fetch orchestrator
    # ------------------------------------------------------------------

    @staticmethod
    async def _fetch_all_workspace_nodes(
        workspace_mcp_url: str,
        docs_mcp_url: str | None = None,
    ) -> list[dict[str, Any]]:
        """Two-phase fetch of all documents across all accessible knowledge bases.

        Phase 1 — workspace MCP (list_wikiSpaces):
            Connects to the 知识库 MCP server and calls list_wikiSpaces to get
            the list of knowledge bases the user can access.

        Phase 2 — docs MCP (list_nodes with workspaceId):
            For each KB found in Phase 1, connects to the docs MCP server and
            calls list_nodes(workspaceId=<kb_id>) to enumerate all documents
            and folders.  If the docs MCP URL is not configured the workspace
            MCP URL is used as a fallback (works if it's a combined server).
        """
        all_nodes: list[dict[str, Any]] = []

        # Phase 1: obtain knowledge-base list.
        kb_nodes = await DingTalkWorkspaceService._list_wiki_spaces(workspace_mcp_url)

        if not kb_nodes:
            logger.warning(
                "list_wikiSpaces returned 0 knowledge bases. "
                "Verify the workspace MCP URL and user permissions."
            )
            return all_nodes

        # The URL used for list_nodes (Phase 2).
        nodes_url = docs_mcp_url or workspace_mcp_url
        if not docs_mcp_url:
            logger.info(
                "Docs MCP not configured — using workspace MCP URL for list_nodes. "
                "Configure the DingTalk Docs MCP for best results."
            )

        # Phase 2: list documents for every knowledge base.
        for kb_node in kb_nodes:
            # The workspace MCP returns workspaceId as the KB identifier.
            kb_id = (
                kb_node.get("workspaceId")
                or kb_node.get("nodeId")
                or kb_node.get("id")
            )
            if not kb_id:
                logger.warning(
                    "Skipping KB node with no workspaceId/nodeId: %s",
                    kb_node,
                )
                continue

            kb_name = kb_node.get("name") or kb_node.get("title") or kb_id
            kb_url = kb_node.get("url") or (
                f"https://alidocs.dingtalk.com/i/spaces/{kb_id}/overview"
            )

            # Represent the KB root as a folder-like node so the UI can render
            # it as the top of the document tree.
            kb_as_folder: dict[str, Any] = {
                **kb_node,
                "nodeId": kb_id,
                "nodeType": "folder",
                "workspaceId": kb_id,
                "name": kb_name,
                "url": kb_url,
            }
            all_nodes.append(kb_as_folder)

            logger.info(
                "Fetching documents for knowledge base '%s' (workspaceId=%s)",
                kb_name,
                kb_id,
            )

            try:
                await DingTalkWorkspaceService._list_nodes_in_workspace(
                    docs_mcp_url=nodes_url,
                    workspace_id=kb_id,
                    all_nodes=all_nodes,
                )
            except Exception as exc:
                logger.error(
                    "Failed to list nodes in KB '%s' (id=%s): %s",
                    kb_name,
                    kb_id,
                    exc,
                )
                # Continue with remaining KBs even if one fails.

        logger.info(
            "Workspace sync fetched %d total nodes across %d knowledge bases",
            len(all_nodes),
            len(kb_nodes),
        )
        return all_nodes

    # ------------------------------------------------------------------
    # Read helpers
    # ------------------------------------------------------------------

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
