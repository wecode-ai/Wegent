# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
CompletionCondition model for tracking async completion conditions like CI pipelines
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
    Model for tracking completion conditions for async team mode.
    Used to monitor external events like CI pipelines and trigger
    automatic repair when needed.
    """
    __tablename__ = "completion_conditions"

    id = Column(Integer, primary_key=True, index=True)
    subtask_id = Column(Integer, nullable=False, index=True)
    task_id = Column(Integer, nullable=False, index=True)
    user_id = Column(Integer, nullable=False, index=True)

    # Condition type and status
    condition_type = Column(
        SQLEnum(ConditionType),
        nullable=False,
        default=ConditionType.CI_PIPELINE
    )
    status = Column(
        SQLEnum(ConditionStatus),
        nullable=False,
        default=ConditionStatus.PENDING
    )

    # Trigger information
    trigger_type = Column(String(50), nullable=True)  # git_push, pr_created

    # External resource information
    external_id = Column(String(255), nullable=True)  # PR number, Pipeline ID
    external_url = Column(String(1024), nullable=True)  # Link to external resource

    # Git information
    git_platform = Column(SQLEnum(GitPlatform), nullable=True)
    git_domain = Column(String(255), nullable=True)
    repo_full_name = Column(String(512), nullable=True)  # owner/repo format
    branch_name = Column(String(255), nullable=True)

    # Retry information
    retry_count = Column(Integer, nullable=False, default=0)
    max_retries = Column(Integer, nullable=False, default=5)
    last_failure_log = Column(Text, nullable=True)

    # Session information for resuming agent
    session_id = Column(String(255), nullable=True)
    executor_namespace = Column(String(100), nullable=True)
    executor_name = Column(String(100), nullable=True)

    # Extended metadata
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
