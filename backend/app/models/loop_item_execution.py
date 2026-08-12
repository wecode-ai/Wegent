# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Execution record for a project robot queue run.

The queue is a derived view over this table: any non-terminal row is part of
the queue. The task row keeps the assignment chain; this table records each
run's lifecycle (approval, queuing, capacity-gated claiming, lease, retries).
"""

from datetime import datetime

from sqlalchemy import (
    JSON,
    Column,
    DateTime,
    Index,
    Integer,
    String,
    Text,
    func,
)

from app.db.base import Base
from shared.models.db.types import big_integer_id_type

EPOCH_TIME = datetime(1970, 1, 1, 0, 0, 0)


class LoopItemExecution(Base):
    """A single robot run of a project task."""

    __tablename__ = "loop_item_executions"

    id = Column(big_integer_id_type(), primary_key=True, autoincrement=True)
    loop_item_id = Column(String(64), nullable=False, default="", server_default="")
    cloud_project_id = Column(String(64), nullable=False, default="", server_default="")
    agent_id = Column(String(64), nullable=False, default="", server_default="")
    actor_type = Column(String(16), nullable=False, default="", server_default="")
    actor_id = Column(String(64), nullable=False, default="", server_default="")
    actor_snapshot = Column(JSON, nullable=False, default=dict)
    execution_target_type = Column(
        String(24),
        nullable=False,
        default="registered_device",
        server_default="registered_device",
    )
    execution_target_id = Column(
        String(100), nullable=False, default="", server_default=""
    )
    # Where the robot actually executes. "local" runs on the creator's App,
    # "cloud" runs on the creator's bound cloud device; the backend never
    # claims local rows and the App never claims cloud rows.
    execution_environment = Column(
        String(16), nullable=False, default="", server_default=""
    )
    # The device bound to the robot at creation time (loop_items.device_id).
    execution_device_id = Column(
        String(100), nullable=False, default="", server_default=""
    )
    assigner_user_id = Column(Integer, nullable=False, default=0, server_default="0")
    # pending_approval / queued / running / completed / failed / cancelled
    status = Column(
        String(24), nullable=False, default="queued", server_default="queued"
    )
    # Derived from the task priority so higher-priority runs jump the queue.
    priority_weight = Column(Integer, nullable=False, default=0, server_default="0")
    queued_at = Column(
        DateTime,
        nullable=False,
        default=EPOCH_TIME,
        server_default="1970-01-01 00:00:00",
    )
    started_at = Column(
        DateTime,
        nullable=False,
        default=EPOCH_TIME,
        server_default="1970-01-01 00:00:00",
    )
    completed_at = Column(
        DateTime,
        nullable=False,
        default=EPOCH_TIME,
        server_default="1970-01-01 00:00:00",
    )
    # Lease protects multi-device/local and multi-worker/cloud claiming.
    lease_expires_at = Column(
        DateTime,
        nullable=False,
        default=EPOCH_TIME,
        server_default="1970-01-01 00:00:00",
    )
    heartbeat_at = Column(
        DateTime,
        nullable=False,
        default=EPOCH_TIME,
        server_default="1970-01-01 00:00:00",
    )
    retry_attempt = Column(Integer, nullable=False, default=0, server_default="0")
    max_retries = Column(Integer, nullable=False, default=1, server_default="1")
    error_message = Column(Text, nullable=False, default="")
    execution_note = Column(String(500), nullable=False, default="", server_default="")
    approval_status = Column(String(16), nullable=False, default="", server_default="")
    approved_by_user_id = Column(Integer, nullable=False, default=0, server_default="0")
    approved_at = Column(
        DateTime,
        nullable=False,
        default=EPOCH_TIME,
        server_default="1970-01-01 00:00:00",
    )
    rejected_reason = Column(String(500), nullable=False, default="", server_default="")
    runtime_device_id = Column(
        String(255), nullable=False, default="", server_default=""
    )
    runtime_task_id = Column(String(255), nullable=False, default="", server_default="")
    workflow_run_id = Column(String(64), nullable=False, default="", server_default="")
    stage_run_id = Column(String(64), nullable=False, default="", server_default="")
    attempt = Column(Integer, nullable=False, default=1, server_default="1")
    # Prebuilt runtime.tasks.create payload, so cloud dispatchers and local
    # pullers replay the exact task the App would have created (same pattern
    # as automations storing their task_payload).
    execution_payload = Column(Text, nullable=False, default="")
    version = Column(Integer, nullable=False, default=1, server_default="1")
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(
        DateTime, nullable=False, server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        # Capacity-gated claiming per bound device: status filter + priority
        # order + FIFO tie-break.
        Index(
            "idx_exec_device_status_order",
            "execution_device_id",
            "status",
            "priority_weight",
            "queued_at",
        ),
        Index("idx_exec_agent_status", "agent_id", "status"),
        Index("idx_exec_assigner_status", "assigner_user_id", "status"),
        Index("idx_exec_item_status", "loop_item_id", "status"),
        Index("idx_exec_workflow_stage", "workflow_run_id", "stage_run_id"),
        Index("idx_exec_status_device", "status", "execution_device_id"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )
