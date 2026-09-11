# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Non-exclusive Issue assignments."""

from datetime import datetime

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy.sql import func

from app.db.base import Base
from shared.models.db.types import big_integer_id_type


class IssueAssignment(Base):
    """One active or historical action request addressed to a Member."""

    __tablename__ = "issue_assignments"

    id = Column(big_integer_id_type(), primary_key=True, autoincrement=True)
    workspace_id = Column(
        big_integer_id_type(),
        ForeignKey("collaboration_workspaces.id", ondelete="CASCADE"),
        nullable=True,
    )
    cloud_project_id = Column(
        String(64),
        ForeignKey("loop_items.id", ondelete="CASCADE"),
        nullable=False,
    )
    loop_item_id = Column(
        String(64),
        ForeignKey("loop_items.id", ondelete="CASCADE"),
        nullable=False,
    )
    member_type = Column(String(16), nullable=False)
    member_id = Column(String(128), nullable=False)
    assigned_by_user_id = Column(Integer, nullable=False)
    workflow_step = Column(String(128), nullable=False, default="", server_default="")
    notify = Column(Boolean, nullable=False, default=True, server_default="1")
    comment_id = Column(String(64), nullable=True)
    trigger = Column(
        String(24), nullable=False, default="manual", server_default="manual"
    )
    active_marker = Column(
        String(16), nullable=True, default="active", server_default="active"
    )
    removed_by_user_id = Column(Integer, nullable=False, default=0, server_default="0")
    removed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(
        DateTime, nullable=False, server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        UniqueConstraint(
            "loop_item_id",
            "member_type",
            "member_id",
            "workflow_step",
            "active_marker",
            name="uniq_active_issue_assignment",
        ),
        Index(
            "idx_issue_assignments_project_active",
            "cloud_project_id",
            "active_marker",
        ),
        Index(
            "idx_issue_assignments_issue_active",
            "loop_item_id",
            "active_marker",
        ),
        Index(
            "idx_issue_assignments_member_active",
            "member_type",
            "member_id",
            "active_marker",
        ),
        Index("idx_issue_assignments_comment", "comment_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
        },
    )

    @property
    def is_active(self) -> bool:
        return self.active_marker == "active" and self.removed_at is None

    def remove(self, *, user_id: int, removed_at: datetime) -> None:
        self.active_marker = None
        self.removed_by_user_id = user_id
        self.removed_at = removed_at
