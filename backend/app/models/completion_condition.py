# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Completion Condition model for tracking external async conditions
"""
from datetime import datetime
from enum import Enum as PyEnum

from sqlalchemy import JSON, Column, DateTime, Integer, String, Text
from sqlalchemy import Enum as SQLEnum
from sqlalchemy.sql import func

from app.db.base import Base


class ConditionType(str, PyEnum):
    """Type of completion condition"""

    CI_PIPELINE = "CI_PIPELINE"
    EXTERNAL_TASK = "EXTERNAL_TASK"
    APPROVAL = "APPROVAL"
    MANUAL_CONFIRM = "MANUAL_CONFIRM"


class ConditionStatus(str, PyEnum):
    """Status of completion condition"""

    PENDING = "PENDING"
    IN_PROGRESS = "IN_PROGRESS"
    SATISFIED = "SATISFIED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"


class GitPlatform(str, PyEnum):
    """Git platform type"""

    GITHUB = "GITHUB"
    GITLAB = "GITLAB"


class CompletionCondition(Base):
    """
    Completion condition model for tracking async external conditions.
    Used to track CI pipelines, external approvals, and other conditions
    that must be satisfied before a task is considered truly complete.
    """

    __tablename__ = "completion_conditions"

    id = Column(Integer, primary_key=True, index=True)
    subtask_id = Column(Integer, nullable=False, index=True)
    task_id = Column(Integer, nullable=False, index=True)
    user_id = Column(Integer, nullable=False, index=True)

    # Condition type and status
    condition_type = Column(
        SQLEnum(ConditionType), nullable=False, default=ConditionType.CI_PIPELINE
    )
    status = Column(
        SQLEnum(ConditionStatus), nullable=False, default=ConditionStatus.PENDING
    )

    # External resource identification
    external_id = Column(String(256), nullable=True)  # PR number, Pipeline ID, etc.
    external_url = Column(String(1024), nullable=True)  # Link to external resource

    # Git platform information
    git_platform = Column(SQLEnum(GitPlatform), nullable=True)
    git_domain = Column(String(256), nullable=True)
    repo_full_name = Column(String(512), nullable=True)  # owner/repo format
    branch_name = Column(String(256), nullable=True, index=True)

    # Auto-fix retry tracking
    retry_count = Column(Integer, nullable=False, default=0)
    max_retries = Column(Integer, nullable=False, default=5)
    last_failure_log = Column(Text, nullable=True)

    # Additional metadata (extensible)
    metadata = Column(JSON, nullable=True)

    # Timestamps
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())
    satisfied_at = Column(DateTime, nullable=True)

    __table_args__ = (
        {
            "sqlite_autoincrement": True,
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )
