# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""DingTalk synced document node model for storing synced DingTalk docs."""

from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, Index, Integer, String
from sqlalchemy.sql import func

from app.db.base import Base


class DingtalkSyncedNode(Base):
    """
    DingTalk synced document node model.

    Stores DingTalk document/folder nodes synced from the DingTalk Docs MCP server.
    Each node represents a document, folder, or file visible to the user.
    content_updated_at stores the updateTime returned by the list_nodes MCP tool.
    """

    __tablename__ = "dingtalk_synced_nodes"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, nullable=False, index=True)
    # DingTalk node ID (dentryUuid, 32-char alphanumeric string)
    dingtalk_node_id = Column(String(64), nullable=False)
    # Document or folder name
    name = Column(String(500), nullable=False)
    # Full DingTalk document URL
    doc_url = Column(String(1024), nullable=False)
    # Parent folder's dingtalk_node_id (empty string for root-level nodes)
    parent_node_id = Column(String(64), nullable=False, default="")
    # Node type: folder, doc, file
    node_type = Column(String(32), nullable=False)
    # DingTalk workspace (knowledge base) ID
    workspace_id = Column(String(64), nullable=False, default="")
    # Content type (e.g., ALIDOC)
    content_type = Column(String(32), nullable=False, default="")
    # Document content last updated time from list_nodes updateTime field
    content_updated_at = Column(DateTime, nullable=False, default=func.now())
    is_active = Column(Boolean, nullable=False, default=True)
    last_synced_at = Column(DateTime, nullable=False, default=func.now())
    created_at = Column(DateTime, nullable=False, default=func.now())
    updated_at = Column(
        DateTime, nullable=False, default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        # Unique constraint: one node per user per DingTalk node
        Index(
            "ix_dingtalk_nodes_user_node",
            "user_id",
            "dingtalk_node_id",
            unique=True,
        ),
        # Index for querying children of a parent folder
        Index(
            "ix_dingtalk_nodes_user_parent",
            "user_id",
            "parent_node_id",
        ),
        {
            "sqlite_autoincrement": True,
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
            "comment": "DingTalk synced document nodes",
        },
    )
