# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Execution record for a Wework-managed project task run.

The queue is a derived view over this table: any non-terminal row is part of
the queue. The task row keeps the assignment chain; this table records each
run's lifecycle (approval, queuing, capacity-gated claiming, lease, retries).
"""

import json
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Column,
    DateTime,
    Index,
    Integer,
    String,
    Text,
    event,
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
        nullable=False,
        default=0,
        server_default="0",
        comment="Executing Wegent Team id; 0 means none",
    )
    backend_task_id = Column(
        big_integer_id_type(),
        nullable=False,
        default=0,
        server_default="0",
        comment="Managed backend task id; 0 means none",
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
    # Stores the immutable, non-secret RuntimeTaskCreateRequest V2 intent plus
    # queue selection metadata. Provider credentials are materialized only by
    # the Local or Cloud compiler and are never persisted here.
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
            "executor_owner_user_id",
            "execution_device_id",
            "execution_environment",
            "status",
            "priority_weight",
            "queued_at",
            "id",
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

        configured = self.runtime_selection.get("executor_kind")
        if configured in {"generic_robot", "automation_manager"}:
            return str(configured)
        if self.agent_id:
            return "project_robot"
        return "wegent_team" if self.team_id else "automation_manager"

    @property
    def runtime_selection(self) -> dict:
        """Return the non-secret Runtime selection intent."""

        value = self.execution_intent
        selection = value.get("runtime_selection")
        if isinstance(selection, dict):
            return selection
        # V1 rows stored the selection dictionary directly.
        return value

    @property
    def runtime_request(self) -> dict:
        """Return the immutable producer request stored for this execution."""

        request = self.execution_intent.get("runtime_request")
        return request if isinstance(request, dict) else {}

    @property
    def runtime_origin_context(self) -> dict:
        """Return the enqueue-time origin context used to build the request."""

        context = self.execution_intent.get("origin_context")
        return context if isinstance(context, dict) else {}

    @property
    def execution_intent(self) -> dict:
        """Decode the persisted non-secret execution intent envelope."""

        if not self.execution_payload:
            return {}
        try:
            value = json.loads(self.execution_payload)
        except (TypeError, ValueError):
            return {}
        return value if isinstance(value, dict) else {}

    @property
    def optional_team_id(self) -> int | None:
        """Expose the nullable domain value for the persisted team sentinel."""

        return self.team_id or None

    @property
    def optional_backend_task_id(self) -> int | None:
        """Expose the nullable domain value for the persisted task sentinel."""

        return self.backend_task_id or None


@event.listens_for(LoopItemExecution, "before_insert")
@event.listens_for(LoopItemExecution, "before_update")
def _adapt_optional_execution_ids(
    _mapper: object, _connection: object, target: LoopItemExecution
) -> None:
    """Persist optional execution identifiers with the table's zero sentinel."""

    if target.team_id is None:
        target.team_id = 0
    if target.backend_task_id is None:
        target.backend_task_id = 0
