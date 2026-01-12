# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Database model for AI Flow (智能流).
"""
from datetime import datetime

from sqlalchemy import (
    JSON,
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
)

from app.db.base import Base


class FlowResource(Base):
    """
    Flow resource table for storing AI Flow configurations.

    Similar to the Kind table pattern but optimized for Flow resources
    with additional scheduling-specific fields.
    """

    __tablename__ = "flows"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, nullable=False, index=True)

    # Resource identification (CRD-style)
    kind = Column(String(50), default="Flow", nullable=False)
    name = Column(String(255), nullable=False)
    namespace = Column(String(255), default="default", nullable=False)

    # Full CRD JSON storage
    json = Column(JSON, nullable=False)

    # Status flags
    is_active = Column(Boolean, default=True, nullable=False)

    # Scheduling fields (denormalized for efficient queries)
    enabled = Column(Boolean, default=True, nullable=False, index=True)
    trigger_type = Column(String(50), nullable=False, index=True)
    team_id = Column(Integer, nullable=True, index=True)
    workspace_id = Column(Integer, nullable=True)

    # Webhook support
    webhook_token = Column(String(255), nullable=True, unique=True)

    # Execution statistics
    last_execution_time = Column(DateTime, nullable=True)
    last_execution_status = Column(String(50), nullable=True)
    next_execution_time = Column(DateTime, nullable=True, index=True)
    execution_count = Column(Integer, default=0, nullable=False)
    success_count = Column(Integer, default=0, nullable=False)
    failure_count = Column(Integer, default=0, nullable=False)

    # Timestamps
    created_at = Column(DateTime, default=datetime.now, nullable=False)
    updated_at = Column(
        DateTime, default=datetime.now, onupdate=datetime.now, nullable=False
    )

    __table_args__ = (
        # Unique constraint: (user_id, kind, name, namespace) for CRD-style uniqueness
        Index(
            "ix_flows_user_kind_name_ns", "user_id", "kind", "name", "namespace", unique=True
        ),
        # Index for scheduler queries: find enabled flows that need execution
        Index("ix_flows_enabled_next_exec", "enabled", "next_execution_time"),
        # Index for user's flows listing
        Index("ix_flows_user_active", "user_id", "is_active"),
    )


class FlowExecution(Base):
    """
    Flow execution records table.

    Stores each execution instance of a Flow, linking to the actual Task
    that was created for the execution.
    """

    __tablename__ = "flow_executions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, nullable=False, index=True)

    # Flow reference
    flow_id = Column(
        Integer,
        ForeignKey("flows.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    # Task reference (the actual task created for this execution)
    task_id = Column(Integer, nullable=True, index=True)

    # Trigger information
    trigger_type = Column(String(50), nullable=False)  # cron, interval, webhook, etc.
    trigger_reason = Column(String(500), nullable=True)  # Human-readable reason

    # Resolved prompt (with variables substituted)
    prompt = Column(Text, nullable=False)

    # Execution status
    status = Column(String(50), default="PENDING", nullable=False, index=True)
    result_summary = Column(Text, nullable=True)
    error_message = Column(Text, nullable=True)

    # Retry tracking
    retry_attempt = Column(Integer, default=0, nullable=False)

    # Timing
    started_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.now, nullable=False, index=True)
    updated_at = Column(
        DateTime, default=datetime.now, onupdate=datetime.now, nullable=False
    )

    __table_args__ = (
        # Index for timeline queries (recent executions)
        Index("ix_flow_exec_user_created", "user_id", "created_at"),
        # Index for flow execution history
        Index("ix_flow_exec_flow_created", "flow_id", "created_at"),
        # Index for status filtering
        Index("ix_flow_exec_user_status", "user_id", "status"),
    )
