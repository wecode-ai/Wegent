# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Task member model for group chat functionality.
Stores members who can participate in a task (group chat).
"""

from datetime import datetime
from enum import Enum as PyEnum

from sqlalchemy import Column, DateTime, Integer, String, UniqueConstraint
from sqlalchemy.sql import func

from app.db.base import Base


class MemberStatus(str, PyEnum):
    """Status of a task member"""

    ACTIVE = "ACTIVE"  # Active member
    REMOVED = "REMOVED"  # Removed from group


class TaskMember(Base):
    """
    Task member model for group chat.
    Represents a user's membership in a task (group chat).
    """

    __tablename__ = "task_members"

    id = Column(Integer, primary_key=True, index=True)
    task_id = Column(
        Integer, nullable=False, default=0, index=True
    )  # Related Task Kind.id
    user_id = Column(Integer, nullable=False, default=0, index=True)  # Member user ID
    invited_by = Column(Integer, nullable=False, default=0)  # Inviter user ID
    status = Column(
        String(20), nullable=False, default=MemberStatus.ACTIVE.value
    )  # VARCHAR instead of ENUM
    joined_at = Column(DateTime, nullable=False, default=func.now())
    removed_at = Column(
        DateTime, nullable=False, default=datetime(1970, 1, 1)
    )  # Default epoch time for not removed
    created_at = Column(DateTime, nullable=False, default=func.now())
    updated_at = Column(
        DateTime, nullable=False, default=func.now(), onupdate=func.now()
    )

    # Unique constraint: one user can only be a member once per task
    __table_args__ = (
        UniqueConstraint(
            "task_id", "user_id", name="uniq_task_member"
        ),  # Changed prefix to uniq_
        {
            "sqlite_autoincrement": True,
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )
