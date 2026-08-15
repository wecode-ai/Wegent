# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Execution record for a Wework-managed project task run.

The queue is a derived view over this table: any non-terminal row is part of
the queue. The task row keeps the assignment chain; this table records each
run's lifecycle (approval, queuing, capacity-gated claiming, lease, retries).
"""

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Column,
    DateTime,
    ForeignKey,
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
    """A single Wework executor run of a project task."""

    __tablename__ = "loop_item_executions"

    id = Column(big_integer_id_type(), primary_key=True, autoincrement=True)
    loop_item_id = Column(String(64), nullable=False, default="", server_default="")
    cloud_project_id = Column(String(64), nullable=False, default="", server_default="")
    executor_owner_user_id = Column(
        Integer, nullable=False, default=0, server_default="0"
    )
    agent_id = Column(String(64), nullable=False, default="", server_default="")
    team_id = Column(
        Integer,
        ForeignKey(
            "kinds.id",
            name="fk_loop_item_executions_team_id_kinds",
            ondelete="SET NULL",
        ),
        nullable=True,
    )
    backend_task_id = Column(
        big_integer_id_type(),
        ForeignKey(
            "tasks.id",
            name="fk_loop_item_executions_backend_task_id_tasks",
            ondelete="SET NULL",
        ),
        nullable=True,
    )
    automation_run_id = Column(
        String(64), nullable=False, default="", server_default=""
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
    # Capacity belongs to one Runtime installation, not to one transport route.
    runtime_instance_id = Column(
        String(100), nullable=False, default="", server_default=""
    )
    assigner_user_id = Column(Integer, nullable=False, default=0, server_default="0")
    # pending_approval / queued / claimed / running / cancel_requested /
    # completed / failed / cancelled. `running` is accepted only after Runtime
    # confirms the process; control-plane liveness is stored separately below.
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
    attempt_no = Column(Integer, nullable=False, default=1, server_default="1")
    previous_execution_id = Column(
        big_integer_id_type(), nullable=False, default=0, server_default="0"
    )
    execution_scope = Column(String(160), nullable=False, default="", server_default="")
    observed_state = Column(
        String(24), nullable=False, default="unconfirmed", server_default="unconfirmed"
    )
    sync_state = Column(
        String(16), nullable=False, default="pending", server_default="pending"
    )
    claimed_at = Column(
        DateTime,
        nullable=False,
        default=EPOCH_TIME,
        server_default="1970-01-01 00:00:00",
    )
    start_requested_at = Column(
        DateTime,
        nullable=False,
        default=EPOCH_TIME,
        server_default="1970-01-01 00:00:00",
    )
    observed_at = Column(
        DateTime,
        nullable=False,
        default=EPOCH_TIME,
        server_default="1970-01-01 00:00:00",
    )
    cancel_requested_at = Column(
        DateTime,
        nullable=False,
        default=EPOCH_TIME,
        server_default="1970-01-01 00:00:00",
    )
    last_event_seq = Column(BigInteger, nullable=False, default=0, server_default="0")
    termination_reason = Column(
        String(64), nullable=False, default="", server_default=""
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
    # Kept for schema compatibility with existing installations. New
    # executions compile requests from live configuration and never write a
    # request or model credentials to this column.
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
        Index("idx_exec_team_status", "team_id", "status"),
        Index("idx_exec_automation_run_id", "automation_run_id"),
        Index("idx_exec_assigner_status", "assigner_user_id", "status"),
        Index("idx_exec_item_status", "loop_item_id", "status"),
        Index("idx_exec_status_device", "status", "execution_device_id"),
        Index("idx_exec_scope_status", "execution_scope", "status"),
        Index(
            "idx_exec_runtime_capacity",
            "executor_owner_user_id",
            "runtime_instance_id",
            "status",
        ),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )

    @property
    def executor_type(self) -> str:
        """Return the transport role without persisting redundant state."""

        if self.agent_id:
            return "project_robot"
        return "wegent_team" if self.team_id else "automation_manager"
