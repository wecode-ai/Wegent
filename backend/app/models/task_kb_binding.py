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
    BigInteger,
    Column,
    DateTime,
    ForeignKey,
    Index,
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

    id = Column(BigInteger, primary_key=True, autoincrement=True, comment="Primary key")
    task_id = Column(
        BigInteger,
        ForeignKey("tasks.id", ondelete="CASCADE"),
        nullable=False,
        comment="Task ID, references tasks.id",
    )
    knowledge_base_id = Column(
        BigInteger,
        ForeignKey("kinds.id", ondelete="CASCADE"),
        nullable=False,
        comment="Knowledge base ID, references kinds.id",
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
        # Index for querying by task_id (get all KBs for a task)
        Index("idx_tkb_task_id", "task_id"),
        # Index for querying by knowledge_base_id (check if KB is bound to any task)
        Index("idx_tkb_kb_id", "knowledge_base_id"),
        # Unique constraint to prevent duplicate bindings
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
