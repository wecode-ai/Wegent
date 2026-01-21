# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Database model for Subscription (订阅).

Subscription is a CRD resource stored in the kinds table.
BackgroundExecution stores execution records in the background_executions table.
"""
from datetime import datetime

from sqlalchemy import (
    Column,
    DateTime,
    Index,
    Integer,
    String,
    Text,
)

from app.db.base import Base


class BackgroundExecution(Base):
    """
    Background execution records table.

    Stores each execution instance of a Subscription, linking to the actual Task
    that was created for the execution.

    Note: Subscription resources are stored in the kinds table (kind='Subscription'),
    not in a separate table. This table only stores execution records.
    """

    __tablename__ = "background_executions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, nullable=False, index=True)

    # Subscription reference (the Kind record with kind='Subscription')
    subscription_id = Column(
        Integer,
        nullable=False,
        index=True,
    )

    # Task reference (the actual task created for this execution)
    task_id = Column(
        Integer, nullable=False, default=0, index=True
    )  # 0 means no task yet

    # Trigger information
    trigger_type = Column(String(50), nullable=False)  # cron, interval, webhook, etc.
    trigger_reason = Column(
        String(500), nullable=False, default=""
    )  # Human-readable reason

    # Resolved prompt (with variables substituted)
    prompt = Column(Text, nullable=False)

    # Execution status
    status = Column(String(50), default="PENDING", nullable=False, index=True)
    result_summary = Column(Text, nullable=False, default="")
    error_message = Column(Text, nullable=False, default="")

    # Retry tracking
    retry_attempt = Column(Integer, default=0, nullable=False)

    # Optimistic locking version (incremented on each update)
    version = Column(Integer, default=0, nullable=False)

    # Timing (stored in UTC)
    # started_at is set when execution starts (RUNNING state), default to created_at
    # completed_at is set when execution finishes (COMPLETED/FAILED/CANCELLED state), default to created_at
    started_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    completed_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    updated_at = Column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    __table_args__ = (
        # Index for timeline queries (recent executions)
        Index("ix_bg_exec_user_created", "user_id", "created_at"),
        # Index for subscription execution history
        Index("ix_bg_exec_subscription_created", "subscription_id", "created_at"),
        # Index for status filtering
        Index("ix_bg_exec_user_status", "user_id", "status"),
    )
