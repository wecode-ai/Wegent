# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Pydantic schemas for DingTalk synced document nodes."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel


class DingtalkDocNodeBase(BaseModel):
    """Base schema for a DingTalk document node."""

    dingtalk_node_id: str
    name: str
    doc_url: str
    parent_node_id: str = ""
    node_type: str  # folder, doc, file
    workspace_id: str = ""
    content_type: str = ""
    source: str = (
        "docs"  # Source: "docs" (personal documents) or "wikispace" (knowledge base)
    )
    content_updated_at: datetime


class DingtalkDocNode(DingtalkDocNodeBase):
    """Schema for a DingTalk document node with database fields."""

    id: int
    is_active: bool
    last_synced_at: datetime
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class DingtalkDocNodeWithChildren(DingtalkDocNode):
    """Schema for a DingTalk document node with children (for tree structure)."""

    children: list["DingtalkDocNodeWithChildren"] = []


class DingtalkDocTreeResponse(BaseModel):
    """Response schema for the DingTalk document tree."""

    nodes: list[DingtalkDocNodeWithChildren]
    total_count: int


class DingtalkSyncStatus(BaseModel):
    """Schema for DingTalk document sync status."""

    last_synced_at: Optional[datetime] = None
    total_nodes: int = 0
    is_configured: bool = False  # Whether MCP URL is configured


class DingtalkSyncResult(BaseModel):
    """Schema for DingTalk document sync result."""

    added: int = 0
    updated: int = 0
    deleted: int = 0
    total: int = 0
    sync_time: datetime
    # Number of nodes returned by the MCP server before DB filtering.
    # Useful for diagnosing issues where the MCP returns data but nothing is
    # written (e.g. all nodes lack a nodeId).
    mcp_nodes_fetched: int = 0


def build_dingtalk_tree(
    nodes: list[DingtalkDocNode],
) -> list[DingtalkDocNodeWithChildren]:
    """Build a tree structure from a flat DingTalk node list."""
    node_map: dict[str | None, DingtalkDocNodeWithChildren] = {}

    for node in nodes:
        node_map[node.dingtalk_node_id] = DingtalkDocNodeWithChildren(
            **node.model_dump(),
            children=[],
        )

    roots: list[DingtalkDocNodeWithChildren] = []
    for node in nodes:
        tree_node = node_map[node.dingtalk_node_id]
        parent = node_map.get(node.parent_node_id)
        if parent:
            parent.children.append(tree_node)
        else:
            roots.append(tree_node)

    def sort_key(node: DingtalkDocNodeWithChildren) -> tuple[int, str]:
        type_order = {"folder": 0, "doc": 1, "file": 2}
        return (type_order.get(node.node_type, 3), node.name.lower())

    def sort_tree(tree: list[DingtalkDocNodeWithChildren]) -> None:
        tree.sort(key=sort_key)
        for node in tree:
            if node.children:
                sort_tree(node.children)

    sort_tree(roots)
    return roots
