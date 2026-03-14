# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Task-KnowledgeBase binding model for optimized KB access queries.

This table stores the relationship between Tasks and KnowledgeBases,
enabling efficient indexed queries instead of JSON parsing.
"""

from datetime import datetime

from sqlalchemy import (
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
)

from app.db.base import Base


class TaskKnowledgeBaseBinding(Base):
    """
    TaskKnowledgeBaseBinding model for Task-KB relationships.

    This table mirrors the knowledgeBaseRefs stored in task.json.spec,
    but provides indexed access for efficient queries.

    The data is kept in sync with JSON through dual-write operations
    in the service layer.
    """

    __tablename__ = "task_knowledge_base_bindings"

    id = Column(Integer, primary_key=True, autoincrement=True, comment="Primary key")
    task_id = Column(
        Integer,
        ForeignKey("tasks.id", ondelete="CASCADE"),
        nullable=False,
        comment="Task ID, references tasks.id",
    )
    knowledge_base_id = Column(
        Integer,
        ForeignKey("kinds.id", ondelete="CASCADE"),
        nullable=False,
        comment="Knowledge base ID, references kinds.id",
    )
    linked_group_id = Column(
        Integer,
        nullable=False,
        default=0,
        server_default="0",
        comment="Linked namespace ID for group chats (0 = not linked)",
    )
    bound_by = Column(
        String(255),
        nullable=False,
        comment="Username who bound the KB",
    )
    bound_at = Column(
        DateTime,
        nullable=False,
        comment="When the KB was bound",
    )
    created_at = Column(
        DateTime,
        nullable=False,
        default=datetime.utcnow,
        comment="Record creation time",
    )

    __table_args__ = (
        # Note: idx_tkb_task_id and idx_tkb_kb_id are covered by the UNIQUE constraint uk_task_kb
        # which includes (task_id, knowledge_base_id), so separate indexes are not needed
        # Index("idx_tkb_task_id", "task_id"),
        # Index("idx_tkb_kb_id", "knowledge_base_id"),
        # Composite index for group member sync queries
        # Optimizes: SELECT task_id FROM task_knowledge_base_bindings WHERE linked_group_id = ?
        # Combined with JOIN on tasks table for efficient group chat member synchronization
        Index("idx_tkb_linked_group_task", "linked_group_id", "task_id"),
        # Unique constraint to prevent duplicate bindings (also serves as index for task_id and knowledge_base_id lookups)
        UniqueConstraint("task_id", "knowledge_base_id", name="uk_task_kb"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )

    def __repr__(self) -> str:
        return (
            f"<TaskKnowledgeBaseBinding(id={self.id}, task_id={self.task_id}, "
            f"knowledge_base_id={self.knowledge_base_id})>"
        )
