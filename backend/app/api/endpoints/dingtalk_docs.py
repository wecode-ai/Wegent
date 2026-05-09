# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""DingTalk synced document API endpoints."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_current_user
from app.models.user import User
from app.schemas.dingtalk_doc import (
    DingtalkDocNode,
    DingtalkDocNodeWithChildren,
    DingtalkDocTreeResponse,
    DingtalkSyncResult,
    DingtalkSyncStatus,
)
from app.services.dingtalk_doc_service import DingTalkDocService

router = APIRouter()

logger = logging.getLogger(__name__)


def _build_tree(nodes: list[DingtalkDocNode]) -> list[DingtalkDocNodeWithChildren]:
    """Build a tree structure from flat node list using parent_node_id.

    Only includes active nodes. Root nodes have parent_node_id = None.
    """
    node_map: dict[str | None, DingtalkDocNodeWithChildren] = {}

    # First pass: create tree nodes for all items
    for node in nodes:
        node_map[node.dingtalk_node_id] = DingtalkDocNodeWithChildren(
            **node.model_dump(),
            children=[],
        )

    # Second pass: build parent-child relationships
    roots: list[DingtalkDocNodeWithChildren] = []
    for node in nodes:
        tree_node = node_map[node.dingtalk_node_id]
        parent = node_map.get(node.parent_node_id)
        if parent:
            parent.children.append(tree_node)
        else:
            roots.append(tree_node)

    # Sort: folders first, then by name
    def sort_key(n: DingtalkDocNodeWithChildren) -> tuple[int, str]:
        type_order = {"folder": 0, "doc": 1, "file": 2}
        return (type_order.get(n.node_type, 3), n.name.lower())

    def sort_tree(tree: list[DingtalkDocNodeWithChildren]) -> None:
        tree.sort(key=sort_key)
        for node in tree:
            if node.children:
                sort_tree(node.children)

    sort_tree(roots)
    return roots


@router.get("", response_model=DingtalkDocTreeResponse)
def get_dingtalk_docs(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> DingtalkDocTreeResponse:
    """Get all synced DingTalk document nodes for the current user as a tree."""
    nodes = DingTalkDocService.get_dingtalk_docs(current_user.id, db)
    node_schemas = [DingtalkDocNode.model_validate(node) for node in nodes]
    tree = _build_tree(node_schemas)

    return DingtalkDocTreeResponse(
        nodes=tree,
        total_count=len(node_schemas),
    )


@router.post("/sync", response_model=DingtalkSyncResult)
async def sync_dingtalk_docs(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> DingtalkSyncResult:
    """Trigger sync of DingTalk documents from the user's MCP server.

    Requires the user to have DingTalk Docs MCP URL configured and enabled
    in their integration settings.
    """
    if not DingTalkDocService.is_configured(current_user, db):
        raise HTTPException(
            status_code=400,
            detail="DingTalk Docs MCP is not configured. "
            "Please enable it in Settings > Integrations first.",
        )

    try:
        result = await DingTalkDocService.sync_dingtalk_docs(current_user, db)
        return DingtalkSyncResult(**result)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("Failed to sync DingTalk documents: %s", e)
        raise HTTPException(
            status_code=500,
            detail="Failed to sync DingTalk documents",
        )


@router.get("/sync-status", response_model=DingtalkSyncStatus)
def get_sync_status(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> DingtalkSyncStatus:
    """Get the sync status for the current user's DingTalk documents."""
    status = DingTalkDocService.get_sync_status(current_user, db)
    return DingtalkSyncStatus(**status)


@router.delete("/{node_id}")
def delete_synced_node(
    node_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, str]:
    """Delete a synced document node from local cache (does not delete from DingTalk)."""
    success = DingTalkDocService.delete_synced_node(node_id, current_user.id, db)
    if not success:
        raise HTTPException(status_code=404, detail="Node not found")
    return {"status": "ok"}
