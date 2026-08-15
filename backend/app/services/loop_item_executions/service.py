# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Wework project task execution records.

The queue is a derived view over `loop_item_executions`: any row in a
non-terminal state is part of the queue. This service owns the run lifecycle
(assignment -> approval -> queued -> capacity-gated claim -> running ->
terminal) plus lease-based recovery so multi-device local pullers and
multi-worker cloud dispatchers never double-claim a run.
"""

import json
import logging
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import HTTPException, status
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.models.delivery import (
    CloudProject,
    LoopItem,
    ProjectChatAgent,
    loop_datetime_is_unset,
    loop_datetime_value_is_unset,
)
from app.models.loop_item_execution import EPOCH_TIME, LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage, project_chat_message_key
from app.models.user import User
from app.services.loop_item_executions.profile import (
    WeworkExecutionProfile,
    validate_wework_execution_target,
)
from app.services.project_automation_domain import (
    TERMINAL_RUN_STATUSES,
    assignment_mode,
    manager_type,
)

logger = logging.getLogger(__name__)


@dataclass
class TaskContext:
    """Minimal live task data needed to run one execution."""

    id: str
    cloud_project_id: str
    title: str
    description: str
    status: str | None
    priority: str | None
    parent_id: str | None = None
    tags: list[str] = field(default_factory=list)
    assignee_user_id: int | None = None
    assignee_agent_id: str | None = None

    def to_context(self) -> dict[str, Any]:
        return asdict(self)


class WeworkRuntimeConfigurationError(RuntimeError):
    """The execution intent cannot be materialized on its selected target."""


STATUS_PENDING_APPROVAL = "pending_approval"
STATUS_QUEUED = "queued"
STATUS_CLAIMED = "claimed"
STATUS_RUNNING = "running"
STATUS_COMPLETED = "completed"
STATUS_FAILED = "failed"
STATUS_CANCELLED = "cancelled"

TERMINAL_STATUSES = {STATUS_COMPLETED, STATUS_FAILED, STATUS_CANCELLED}
ACTIVE_STATUSES = {
    STATUS_PENDING_APPROVAL,
    STATUS_QUEUED,
    STATUS_CLAIMED,
    STATUS_RUNNING,
}

# Canonical runtime task identity. The backend owns the name so every channel
# (cloud RPC, local App puller) reports the same task id and events always
# match the execution row before any output can arrive.
RUNTIME_TASK_ID_PREFIX = "codex-queue"


def runtime_task_id_for(execution_id: int) -> str:
    """Return the canonical runtime task id for one execution."""

    return f"{RUNTIME_TASK_ID_PREFIX}-{execution_id}"


PRIORITY_WEIGHTS = {
    "none": 0,
    "low": 10,
    "medium": 20,
    "high": 30,
    "urgent": 40,
}

DEFAULT_MAX_RETRIES = 1
DEFAULT_LEASE_SECONDS = 5 * 60
DEFAULT_STALL_TEXT_TIMEOUT_SECONDS = 20 * 60


def _optional_text(value: str) -> str | None:
    return value or None


def _optional_user_id(value: int) -> int | None:
    return value or None


def _optional_datetime(value: datetime) -> datetime | None:
    return None if loop_datetime_value_is_unset(value) else value


def priority_weight(priority: Optional[str]) -> int:
    """Map a task priority label to a queue order weight (higher jumps first)."""

    return PRIORITY_WEIGHTS.get(priority or "none", 0)


def utcnow() -> datetime:
    """Naive UTC timestamp matching the loop_items convention."""

    return datetime.now(timezone.utc).replace(tzinfo=None)


class LoopItemExecutionService:
    """Lifecycle, profile compilation, and claiming for Wework executions."""

    # ------------------------------------------------------------------
    # Creation and approval
    # ------------------------------------------------------------------

    def create_for_assignment(
        self,
        db: Session,
        *,
        loop_item_id: str,
        cloud_project_id: str,
        agent: ProjectChatAgent,
        assigner_user_id: int,
        environment: str,
        execution_device_id: Optional[str],
        priority: Optional[str],
        automation_context: dict[str, Any] | None = None,
        instruction: str | None = None,
    ) -> LoopItemExecution:
        """Create a run row when a task is assigned to a robot.

        A manual-approval robot starts in `pending_approval`; an auto robot
        enters the queue immediately.
        """

        from app.services.project_chat.service import bot_config

        inferred_context, _ = self._task_automation_context(db, loop_item_id)
        effective_context = (
            dict(automation_context)
            if automation_context is not None
            else inferred_context
        )
        mode = str(bot_config(agent).get("execution_mode") or "auto")
        return self._enqueue(
            db,
            loop_item_id=loop_item_id,
            cloud_project_id=cloud_project_id,
            executor_type="project_robot",
            owner_user_id=int(agent.created_by_user_id or 0),
            agent_id=agent.id,
            assigner_user_id=assigner_user_id,
            environment=environment,
            execution_device_id=execution_device_id,
            priority=priority,
            automation_context=effective_context,
            requires_approval=mode == "manual_approval",
        )

    def enqueue_automation_manager(
        self,
        db: Session,
        *,
        loop_item_id: str,
        cloud_project_id: str,
        owner_user_id: int,
        assigner_user_id: int,
        environment: str,
        execution_device_id: str | None,
        priority: str | None,
        automation_context: dict[str, Any] | None = None,
        requires_approval: bool = False,
    ) -> LoopItemExecution:
        """Queue a custom AI manager on the ordinary Wework transport."""

        return self._enqueue(
            db,
            loop_item_id=loop_item_id,
            cloud_project_id=cloud_project_id,
            executor_type="automation_manager",
            owner_user_id=owner_user_id,
            agent_id="",
            assigner_user_id=assigner_user_id,
            environment=environment,
            execution_device_id=execution_device_id,
            priority=priority,
            automation_context=automation_context,
            requires_approval=requires_approval,
        )

    def _enqueue(
        self,
        db: Session,
        *,
        loop_item_id: str,
        cloud_project_id: str,
        executor_type: str,
        owner_user_id: int,
        agent_id: str,
        assigner_user_id: int,
        environment: str,
        execution_device_id: str | None,
        priority: str | None,
        automation_context: dict[str, Any] | None,
        requires_approval: bool,
    ) -> LoopItemExecution:
        """Persist queue identity; runtime configuration stays canonical."""

        # Project robots keep the shipped assignment semantics: their target
        # is validated when the robot is configured, and legacy local targets
        # may be represented by the App rather than a backend device row.
        # A custom manager has no robot entity, so the rule target is
        # its only source of truth and must be validated here as well as when
        # the rule is saved.
        if executor_type == "automation_manager":
            validate_wework_execution_target(
                db,
                user_id=owner_user_id,
                environment=environment,
                execution_device_id=execution_device_id,
            )
        task = self.resolve_task_context(
            db,
            execution=LoopItemExecution(
                loop_item_id=loop_item_id,
                cloud_project_id=cloud_project_id,
            ),
            user_id=owner_user_id,
        )
        if task is None:
            raise ValueError(f"Wework execution task '{loop_item_id}' is unavailable")
        context = dict(automation_context or {})
        run_id_value = context.get("run_id")
        automation_run_id = (
            str(run_id_value) if isinstance(run_id_value, (str, int)) else ""
        )
        now = utcnow()
        row = LoopItemExecution(
            loop_item_id=loop_item_id,
            cloud_project_id=cloud_project_id,
            executor_owner_user_id=owner_user_id,
            agent_id=agent_id,
            automation_run_id=automation_run_id,
            execution_environment=environment,
            execution_device_id=execution_device_id or "",
            assigner_user_id=assigner_user_id,
            status=STATUS_PENDING_APPROVAL if requires_approval else STATUS_QUEUED,
            priority_weight=priority_weight(priority),
            queued_at=now,
            max_retries=DEFAULT_MAX_RETRIES,
            approval_status="pending" if requires_approval else "",
            execution_note="",
        )
        db.add(row)
        db.flush()
        row.runtime_task_id = runtime_task_id_for(row.id)
        self._set_automation_run_status(db, row, "queued")
        db.flush()
        return row

    @staticmethod
    def _task_automation_context(
        db: Session, loop_item_id: str
    ) -> tuple[dict[str, Any], str | None]:
        item = db.get(LoopItem, loop_item_id)
        metadata = (
            item.metadata_json if item and isinstance(item.metadata_json, dict) else {}
        )
        automation = metadata.get("automation")
        if not isinstance(automation, dict):
            return {}, None
        context = dict(automation)
        instruction = context.pop("prompt", None)
        return context, str(instruction) if isinstance(instruction, str) else None

    def approve(
        self, db: Session, *, execution_id: int, user_id: int
    ) -> LoopItemExecution:
        """Approve a pending run; only the robot creator may do this."""

        row = self._get_for_creator(db, execution_id, user_id)
        if row.status != STATUS_PENDING_APPROVAL:
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Run is not waiting for robot approval"
            )
        now = utcnow()
        row.status = STATUS_QUEUED
        row.queued_at = now
        row.approval_status = "approved"
        row.approved_by_user_id = user_id
        row.approved_at = now
        row.execution_note = ""
        # Do not commit here: callers fold this change into one transaction
        # with their own versioned item update, so a stale-version conflict
        # rolls the approval back instead of half-applying it.
        db.flush()
        db.refresh(row)
        return row

    def reject(
        self,
        db: Session,
        *,
        execution_id: int,
        user_id: int,
        reason: Optional[str] = None,
    ) -> LoopItemExecution:
        """Reject a pending run; only the robot creator may do this."""

        row = self._get_for_creator(db, execution_id, user_id)
        if row.status != STATUS_PENDING_APPROVAL:
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Run is not waiting for robot approval"
            )
        now = utcnow()
        row.status = STATUS_CANCELLED
        row.approval_status = "rejected"
        row.rejected_reason = reason or ""
        row.execution_note = self._execution_note(
            reason or "Robot creator rejected the run"
        )
        row.completed_at = now
        self._finish_linked_activity(
            db,
            execution=row,
            status_value="cancelled",
            content=reason or "AI execution was rejected.",
            error=reason,
        )
        self._finish_project_automation_run(db, row, "cancelled", reason)
        # Same transaction rule as approve: the caller owns the commit so a
        # concurrent version conflict cannot leave a half-applied rejection.
        db.flush()
        db.refresh(row)
        return row

    def cancel(
        self,
        db: Session,
        *,
        execution_id: int,
        note: Optional[str] = None,
        commit: bool = True,
        expected_status: Optional[str] = None,
        expected_version: Optional[int] = None,
    ) -> LoopItemExecution:
        """Cancel a run that is queued or stuck (for example on unassign)."""

        row = self._transition_terminal(
            db,
            execution_id=execution_id,
            terminal_status=STATUS_CANCELLED,
            note=note,
            content=note or "AI execution was cancelled.",
            error=note,
            commit=commit,
            expected_status=expected_status,
            expected_version=expected_version,
        )
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Execution not found")
        return row

    # ------------------------------------------------------------------
    # Capacity-gated claiming
    # ------------------------------------------------------------------

    def claim(
        self,
        db: Session,
        *,
        agent_id: str,
        execution_device_id: str,
        environment: str,
        lease_seconds: int = DEFAULT_LEASE_SECONDS,
        device_capacity: int = 1,
        assigner_filter: Optional[int] = None,
    ) -> Optional[LoopItemExecution]:
        """Atomically claim the next queued run for one robot on one device.

        Returns None when the robot's queue is empty or the device has no free
        capacity. The caller is responsible for holding the per-device Redis
        lock when multiple workers/pullers race (cloud dispatchers); the CAS
        below keeps a single claim atomic even without it.
        """

        running_count = (
            db.query(func.count(LoopItemExecution.id))
            .filter(
                LoopItemExecution.execution_device_id == execution_device_id,
                LoopItemExecution.execution_environment == environment,
                LoopItemExecution.status == STATUS_RUNNING,
            )
            .scalar()
            or 0
        )
        if running_count >= device_capacity:
            return None
        already_running = (
            db.query(LoopItemExecution.id)
            .filter(
                LoopItemExecution.agent_id == agent_id,
                LoopItemExecution.status == STATUS_RUNNING,
            )
            .first()
        )
        if already_running is not None:
            return None

        query = (
            db.query(LoopItemExecution)
            .filter(
                LoopItemExecution.agent_id == agent_id,
                LoopItemExecution.execution_device_id == execution_device_id,
                LoopItemExecution.execution_environment == environment,
                LoopItemExecution.status == STATUS_QUEUED,
            )
            .order_by(
                LoopItemExecution.priority_weight.desc(),
                LoopItemExecution.queued_at.asc(),
                LoopItemExecution.id.asc(),
            )
            .limit(1)
        )
        if assigner_filter is not None:
            query = query.filter(LoopItemExecution.assigner_user_id == assigner_filter)
        candidate = query.first()
        if candidate is None:
            return None

        now = utcnow()
        claimed = (
            db.query(LoopItemExecution)
            .filter(
                LoopItemExecution.id == candidate.id,
                LoopItemExecution.status == STATUS_QUEUED,
            )
            .update(
                {
                    "status": STATUS_RUNNING,
                    "started_at": now,
                    "heartbeat_at": now,
                    "lease_expires_at": now + timedelta(seconds=lease_seconds),
                    "version": LoopItemExecution.version + 1,
                }
            )
        )
        db.commit()
        if claimed != 1:
            return None
        db.refresh(candidate)
        self._persist_runtime_identity(
            db,
            execution=candidate,
            runtime_device_id=execution_device_id,
        )
        self._set_automation_run_status(db, candidate, "running", commit=True)
        return candidate

    def claim_next_for_device(
        self,
        db: Session,
        *,
        execution_device_id: str,
        environment: str,
        lease_seconds: int = DEFAULT_LEASE_SECONDS,
        device_capacity: int = 1,
        owner_user_id: int | None = None,
    ) -> Optional[LoopItemExecution]:
        """Claim one queued run for any robot bound to a device.

        Used by the cloud dispatcher after acquiring the per-device Redis lock.
        The caller loops until this returns None to drain the device up to its
        capacity (each robot still runs one task at a time).
        """

        running_count_query = db.query(func.count(LoopItemExecution.id)).filter(
            LoopItemExecution.execution_device_id == execution_device_id,
            LoopItemExecution.execution_environment == environment,
            LoopItemExecution.status == STATUS_RUNNING,
        )
        if owner_user_id is not None:
            running_count_query = running_count_query.filter(
                LoopItemExecution.executor_owner_user_id == owner_user_id
            )
        running_count = running_count_query.scalar() or 0
        if running_count >= device_capacity:
            return None
        running_agents_query = db.query(LoopItemExecution.agent_id).filter(
            LoopItemExecution.execution_device_id == execution_device_id,
            LoopItemExecution.execution_environment == environment,
            LoopItemExecution.status == STATUS_RUNNING,
            LoopItemExecution.agent_id != "",
        )
        if owner_user_id is not None:
            running_agents_query = running_agents_query.filter(
                LoopItemExecution.executor_owner_user_id == owner_user_id
            )
        running_agent_ids = {agent_id for (agent_id,) in running_agents_query.all()}
        query = (
            db.query(LoopItemExecution)
            .filter(
                LoopItemExecution.execution_device_id == execution_device_id,
                LoopItemExecution.execution_environment == environment,
                LoopItemExecution.status == STATUS_QUEUED,
            )
            .order_by(
                LoopItemExecution.priority_weight.desc(),
                LoopItemExecution.queued_at.asc(),
                LoopItemExecution.id.asc(),
            )
        )
        if owner_user_id is not None:
            query = query.filter(
                LoopItemExecution.executor_owner_user_id == owner_user_id
            )
        query = query.limit(32)
        candidate = next(
            (
                row
                for row in query.all()
                if not row.agent_id or row.agent_id not in running_agent_ids
            ),
            None,
        )
        if candidate is None:
            return None
        now = utcnow()
        claimed = (
            db.query(LoopItemExecution)
            .filter(
                LoopItemExecution.id == candidate.id,
                LoopItemExecution.status == STATUS_QUEUED,
            )
            .update(
                {
                    "status": STATUS_RUNNING,
                    "started_at": now,
                    "heartbeat_at": now,
                    "lease_expires_at": now + timedelta(seconds=lease_seconds),
                    "version": LoopItemExecution.version + 1,
                }
            )
        )
        db.commit()
        if claimed != 1:
            return None
        db.refresh(candidate)
        self._persist_runtime_identity(
            db,
            execution=candidate,
            runtime_device_id=execution_device_id,
        )
        self._set_automation_run_status(db, candidate, "running", commit=True)
        return candidate

    def claim_batch_for_device(
        self,
        db: Session,
        *,
        execution_device_id: str,
        environment: str,
        lease_seconds: int = DEFAULT_LEASE_SECONDS,
        device_capacity: int = 1,
        batch_size: int = 16,
        owner_user_id: int | None = None,
    ) -> list[LoopItemExecution]:
        """Atomically claim a batch of queued runs for one device.

        The caller holds the per-device lock, so this is the single consumer
        path for a device. Runs move to `claimed` (taken but not yet handed to
        the executor); `mark_running` advances them once the execution subtask
        actually starts. Capacity is measured on `running` plus `claimed`
        (already taken by this pass) so the device is never over-subscribed
        across consumers.
        """

        occupied_query = db.query(func.count(LoopItemExecution.id)).filter(
            LoopItemExecution.execution_device_id == execution_device_id,
            LoopItemExecution.execution_environment == environment,
            LoopItemExecution.status.in_([STATUS_CLAIMED, STATUS_RUNNING]),
        )
        if owner_user_id is not None:
            occupied_query = occupied_query.filter(
                LoopItemExecution.executor_owner_user_id == owner_user_id
            )
        occupied = occupied_query.scalar() or 0
        if occupied >= device_capacity:
            return []
        occupied_agents_query = db.query(LoopItemExecution.agent_id).filter(
            LoopItemExecution.execution_device_id == execution_device_id,
            LoopItemExecution.execution_environment == environment,
            LoopItemExecution.status.in_([STATUS_CLAIMED, STATUS_RUNNING]),
            LoopItemExecution.agent_id != "",
        )
        if owner_user_id is not None:
            occupied_agents_query = occupied_agents_query.filter(
                LoopItemExecution.executor_owner_user_id == owner_user_id
            )
        occupied_agent_ids = {agent_id for (agent_id,) in occupied_agents_query.all()}
        candidates = db.query(LoopItemExecution).filter(
            LoopItemExecution.execution_device_id == execution_device_id,
            LoopItemExecution.execution_environment == environment,
            LoopItemExecution.status == STATUS_QUEUED,
        )
        if owner_user_id is not None:
            candidates = candidates.filter(
                LoopItemExecution.executor_owner_user_id == owner_user_id
            )
        candidates = (
            candidates.order_by(
                LoopItemExecution.priority_weight.desc(),
                LoopItemExecution.queued_at.asc(),
                LoopItemExecution.id.asc(),
            )
            .limit(batch_size)
            .all()
        )
        if not candidates:
            return []
        slots = max(0, device_capacity - occupied)
        claimable: list[int] = []
        seen_agent_ids: set[str] = set()
        for candidate in candidates:
            if len(claimable) >= slots:
                break
            if candidate.agent_id:
                if not candidate.agent_id:
                    continue
                if (
                    candidate.agent_id in occupied_agent_ids
                    or candidate.agent_id in seen_agent_ids
                ):
                    continue
                seen_agent_ids.add(candidate.agent_id)
            claimable.append(candidate.id)
        if not claimable:
            return []
        now = utcnow()
        updated = (
            db.query(LoopItemExecution)
            .filter(
                LoopItemExecution.id.in_(claimable),
                LoopItemExecution.status == STATUS_QUEUED,
            )
            .update(
                {
                    "status": STATUS_CLAIMED,
                    "started_at": now,
                    "heartbeat_at": now,
                    "lease_expires_at": now + timedelta(seconds=lease_seconds),
                    "version": LoopItemExecution.version + 1,
                },
                synchronize_session=False,
            )
        )
        db.commit()
        if updated == 0:
            return []
        db.expire_all()
        rows = (
            db.query(LoopItemExecution)
            .filter(LoopItemExecution.id.in_(claimable))
            .all()
        )
        by_id = {row.id: row for row in rows}
        return [
            by_id[execution_id] for execution_id in claimable if execution_id in by_id
        ]

    def claim_next_unbound_local(
        self,
        db: Session,
        *,
        owner_user_id: int,
        execution_device_id: str,
        lease_seconds: int = DEFAULT_LEASE_SECONDS,
        device_capacity: int = 1,
    ) -> Optional[LoopItemExecution]:
        """Claim a legacy project-robot run without a persisted device binding."""

        occupied = (
            db.query(func.count(LoopItemExecution.id))
            .filter(
                LoopItemExecution.executor_owner_user_id == owner_user_id,
                LoopItemExecution.execution_device_id == execution_device_id,
                LoopItemExecution.execution_environment == "local",
                LoopItemExecution.status == STATUS_RUNNING,
            )
            .scalar()
            or 0
        )
        if occupied >= device_capacity:
            return None

        running_agent_ids = {
            agent_id
            for (agent_id,) in db.query(LoopItemExecution.agent_id)
            .filter(
                LoopItemExecution.executor_owner_user_id == owner_user_id,
                LoopItemExecution.status == STATUS_RUNNING,
                LoopItemExecution.agent_id != "",
            )
            .all()
        }
        candidates = (
            db.query(LoopItemExecution)
            .join(ProjectChatAgent, ProjectChatAgent.id == LoopItemExecution.agent_id)
            .filter(
                LoopItemExecution.executor_owner_user_id == owner_user_id,
                LoopItemExecution.execution_environment == "local",
                LoopItemExecution.status == STATUS_QUEUED,
                or_(
                    LoopItemExecution.execution_device_id.is_(None),
                    LoopItemExecution.execution_device_id == "",
                ),
                ProjectChatAgent.created_by_user_id == owner_user_id,
                ProjectChatAgent.status == "active",
            )
            .order_by(
                LoopItemExecution.priority_weight.desc(),
                LoopItemExecution.queued_at.asc(),
                LoopItemExecution.id.asc(),
            )
            .limit(32)
            .all()
        )
        candidate = next(
            (row for row in candidates if row.agent_id not in running_agent_ids),
            None,
        )
        if candidate is None:
            return None

        now = utcnow()
        claimed = (
            db.query(LoopItemExecution)
            .filter(
                LoopItemExecution.id == candidate.id,
                LoopItemExecution.status == STATUS_QUEUED,
            )
            .update(
                {
                    "status": STATUS_RUNNING,
                    "execution_device_id": execution_device_id,
                    "started_at": now,
                    "heartbeat_at": now,
                    "lease_expires_at": now + timedelta(seconds=lease_seconds),
                    "version": LoopItemExecution.version + 1,
                }
            )
        )
        db.commit()
        if claimed != 1:
            return None
        db.refresh(candidate)
        self._persist_runtime_identity(
            db,
            execution=candidate,
            runtime_device_id=execution_device_id,
        )
        self._set_automation_run_status(db, candidate, "running", commit=True)
        return candidate

    def mark_running(
        self,
        db: Session,
        *,
        execution_ids: list[int],
        lease_seconds: int = DEFAULT_LEASE_SECONDS,
    ) -> int:
        """Advance claimed runs to running once their execution has started.

        Returns the number of runs actually advanced. A run that was already
        reclaimed by the lease watchdog (back to queued) or cancelled is left
        untouched, so the caller must not start a runtime task for it.
        """

        if not execution_ids:
            return 0
        now = utcnow()
        updated = (
            db.query(LoopItemExecution)
            .filter(
                LoopItemExecution.id.in_(execution_ids),
                LoopItemExecution.status == STATUS_CLAIMED,
            )
            .update(
                {
                    "status": STATUS_RUNNING,
                    "heartbeat_at": now,
                    "lease_expires_at": now + timedelta(seconds=lease_seconds),
                    "version": LoopItemExecution.version + 1,
                },
                synchronize_session=False,
            )
        )
        db.commit()
        for execution_id in execution_ids:
            row = db.get(LoopItemExecution, execution_id)
            if row is not None and row.status == STATUS_RUNNING:
                self._set_automation_run_status(db, row, "running")
        db.commit()
        return updated

    @staticmethod
    def _persist_runtime_identity(
        db: Session,
        *,
        execution: LoopItemExecution,
        runtime_device_id: str,
    ) -> None:
        """Bind the canonical runtime task identity before the executor runs.

        The runtime task id is derived from the execution id and stored on the
        row at claim time, so runtime events can match the execution even when
        they arrive before the transport reports the created task.
        """

        execution.runtime_device_id = runtime_device_id
        execution.runtime_task_id = runtime_task_id_for(execution.id)
        db.commit()
        db.refresh(execution)

    # ------------------------------------------------------------------
    # Runtime write-back
    # ------------------------------------------------------------------

    def heartbeat(
        self,
        db: Session,
        *,
        execution_id: int,
        runtime_device_id: Optional[str] = None,
        runtime_task_id: Optional[str] = None,
        lease_seconds: int = DEFAULT_LEASE_SECONDS,
    ) -> Optional[LoopItemExecution]:
        """Extend the lease of a running execution."""

        row = db.get(LoopItemExecution, execution_id)
        if row is None or row.status != STATUS_RUNNING:
            return None
        now = utcnow()
        row.heartbeat_at = now
        row.lease_expires_at = now + timedelta(seconds=lease_seconds)
        if runtime_device_id:
            row.runtime_device_id = runtime_device_id
        if runtime_task_id:
            row.runtime_task_id = runtime_task_id
        db.commit()
        db.refresh(row)
        return row

    def execution_for_runtime(
        self,
        db: Session,
        *,
        runtime_device_id: str,
        runtime_task_id: str,
    ) -> Optional[LoopItemExecution]:
        """Resolve the running execution owned by a runtime task identity."""

        return (
            db.query(LoopItemExecution)
            .filter(
                LoopItemExecution.runtime_device_id == runtime_device_id,
                LoopItemExecution.runtime_task_id == runtime_task_id,
                LoopItemExecution.status == STATUS_RUNNING,
            )
            .order_by(LoopItemExecution.id.desc())
            .first()
        )

    def open_execution_activity(
        self,
        db: Session,
        *,
        execution: LoopItemExecution,
        prompt: Optional[str] = None,
    ) -> Optional[object]:
        """Open the reviewable AI activity message for a started robot run.

        The runtime identity is bound at claim time, so every execution channel
        (cloud RPC and the local App puller) opens exactly one streaming
        message before any runtime event can arrive. The project chat service
        key is (project, task, agent, runtime ids), making this idempotent.
        """

        current = db.get(
            LoopItemExecution,
            execution.id,
            populate_existing=True,
        )
        if current is None or current.status != STATUS_RUNNING:
            logger.info(
                "[LoopItemExecution] Activity open skipped for non-running "
                "execution=%s status=%s",
                execution.id,
                current.status if current is not None else "missing",
            )
            return None
        execution = current
        if not execution.runtime_device_id or not execution.runtime_task_id:
            return None
        import uuid

        from app.services.project_chat.service import project_chat_service

        existing_streaming = (
            db.query(ProjectChatMessage)
            .filter(
                ProjectChatMessage.runtime_device_id == execution.runtime_device_id,
                ProjectChatMessage.runtime_task_id == execution.runtime_task_id,
                ProjectChatMessage.sender_type == "agent",
                ProjectChatMessage.status == "streaming",
                loop_datetime_is_unset(ProjectChatMessage.deleted_at),
            )
            .count()
        )
        logger.info(
            "[LoopItemExecution] Open activity execution=%s runtime_task_id=%s "
            "existing_streaming=%s",
            execution.id,
            execution.runtime_task_id,
            existing_streaming,
        )
        try:
            profile, _ = self._runtime_profile_and_context(db, execution=execution)
        except WeworkRuntimeConfigurationError:
            logger.exception(
                "[LoopItemExecution] Activity open failed: unavailable runtime "
                "configuration execution=%s",
                execution.id,
            )
            return None
        row = self._linked_activity(db, execution)
        if row is None:
            message_id = (
                str(uuid.uuid7()) if hasattr(uuid, "uuid7") else str(uuid.uuid4())
            )
            row = ProjectChatMessage(
                message_id=message_id,
                client_message_id=message_id,
                project_id=execution.cloud_project_id,
                task_id=execution.loop_item_id,
                sender_type="agent",
                sender_id=execution.agent_id
                or f"{execution.executor_type}:{execution.automation_run_id}",
                sender_name=profile.display_name,
                message_type="agent_chunk",
                content="",
                metadata_json={},
                agent_id=execution.agent_id or "",
                status="streaming",
            )
            db.add(row)
            db.flush()
        metadata = dict(row.metadata_json or {})
        metadata.update(
            {
                "run_status": "running",
                "execution_id": execution.id,
                "executor_type": execution.executor_type,
                "executor_ref": execution.agent_id
                or self._automation_rule_id(db, execution),
                "automation_run_id": execution.automation_run_id,
                "model": profile.model or None,
            }
        )
        row.sender_type = "agent"
        row.sender_id = execution.agent_id or (
            f"{execution.executor_type}:{execution.automation_run_id}"
        )
        row.sender_name = profile.display_name
        row.message_type = "agent_chunk"
        row.metadata_json = metadata
        row.agent_id = execution.agent_id or ""
        row.runtime_device_id = execution.runtime_device_id
        row.runtime_task_id = execution.runtime_task_id
        row.runtime_activity_key = project_chat_service._runtime_activity_key(
            execution.runtime_device_id,
            execution.runtime_task_id,
            row.trigger_message_id or "",
        )
        row.status = "streaming"
        agent = (
            db.get(ProjectChatAgent, execution.agent_id) if execution.agent_id else None
        )
        if execution.executor_type != "automation_manager":
            project_chat_service._set_task_ai_state(
                db,
                row=row,
                trigger=None,
                agent=agent,
                status_value="running",
                prompt=prompt or profile.runtime_prompt(),
                user_id=execution.executor_owner_user_id,
            )
        db.commit()
        db.refresh(row)
        view = project_chat_service.to_view(row)
        from app.services.project_chat.push import push_project_chat_message

        push_project_chat_message(view.model_dump(by_alias=True))
        return view

    def close_placeholder_activity(
        self, db: Session, *, execution: LoopItemExecution
    ) -> None:
        """Return a linked activity card to queued state after a retry."""

        linked = self._apply_requeued_projection(db, execution=execution)
        db.commit()
        self._push_activity_after_commit(db, linked)

    def complete(
        self,
        db: Session,
        *,
        execution_id: int,
        note: Optional[str] = None,
        content: Optional[str] = None,
    ) -> Optional[LoopItemExecution]:
        """Mark a run completed and release its device slot."""

        previous = db.get(LoopItemExecution, execution_id)
        was_active_manager = bool(
            previous is not None
            and previous.status in ACTIVE_STATUSES
            and previous.executor_type == "automation_manager"
        )
        result = self._transition_terminal(
            db,
            execution_id=execution_id,
            terminal_status=STATUS_COMPLETED,
            note=note,
            content=content if content is not None else note,
        )
        if (
            was_active_manager
            and result is not None
            and result.status == STATUS_COMPLETED
        ):
            self._finalize_manager_transport(
                db,
                execution=result,
                content=content if content is not None else note,
            )
        return result

    def fail(
        self,
        db: Session,
        *,
        execution_id: int,
        error: str,
        note: Optional[str] = None,
        requeue: bool = False,
        requeue_infra: bool = False,
        expected_status: Optional[str] = None,
        expected_version: Optional[int] = None,
    ) -> Optional[LoopItemExecution]:
        """Mark a run failed, requeue it when retries remain, or requeue it
        after a transient infrastructure failure.

        ``requeue_infra`` covers device/transport failures (device offline,
        emit rejected, executor session start timeout). Such failures must not
        consume ``retry_attempt``: the device may come back at any moment, and
        the run should stay queued for the next scan instead of terminally
        failing after one or two attempts.
        """

        row = db.get(LoopItemExecution, execution_id)
        if row is None or row.status in TERMINAL_STATUSES:
            return row
        now = utcnow()
        should_requeue = requeue_infra or (
            requeue and row.retry_attempt < row.max_retries
        )
        if not should_requeue:
            return self._transition_terminal(
                db,
                execution_id=execution_id,
                terminal_status=STATUS_FAILED,
                note=note,
                content=error,
                error=error,
                expected_status=expected_status,
                expected_version=expected_version,
            )

        values: dict[str, Any] = {
            "status": STATUS_QUEUED,
            "queued_at": now,
            "lease_expires_at": EPOCH_TIME,
            "error_message": self._error_text(error)[:2000],
            "version": LoopItemExecution.version + 1,
        }
        if requeue and not requeue_infra:
            values["retry_attempt"] = LoopItemExecution.retry_attempt + 1
        if note:
            values["execution_note"] = self._execution_note(note)
        query = db.query(LoopItemExecution).filter(
            LoopItemExecution.id == execution_id,
            (
                LoopItemExecution.status == expected_status
                if expected_status is not None
                else LoopItemExecution.status.in_(ACTIVE_STATUSES)
            ),
        )
        if expected_version is not None:
            query = query.filter(LoopItemExecution.version == expected_version)
        updated = query.update(values, synchronize_session=False)
        if updated != 1:
            db.rollback()
            return db.get(LoopItemExecution, execution_id)

        try:
            db.expire_all()
            row = db.get(LoopItemExecution, execution_id)
            if row is None:
                raise RuntimeError(
                    f"Requeued execution disappeared after CAS: {execution_id}"
                )
            activity = self._apply_requeued_projection(db, execution=row)
            db.commit()
        except Exception:
            db.rollback()
            raise
        db.refresh(row)
        self._push_activity_after_commit(db, activity)
        return row

    def _transition_terminal(
        self,
        db: Session,
        *,
        execution_id: int,
        terminal_status: str,
        note: Optional[str],
        content: Optional[str],
        error: Optional[str] = None,
        commit: bool = True,
        expected_status: Optional[str] = None,
        expected_version: Optional[int] = None,
    ) -> Optional[LoopItemExecution]:
        """Atomically choose and project the first terminal outcome.

        The execution row is the aggregate root. A conditional update elects
        exactly one terminal writer; that writer projects the same outcome to
        the automation run and activity in the same transaction. Losing
        writers reload the durable winner and perform no side effects.
        """

        if terminal_status not in TERMINAL_STATUSES:
            raise ValueError(f"Unsupported terminal status: {terminal_status}")
        now = utcnow()
        values: dict[str, Any] = {
            "status": terminal_status,
            "completed_at": now,
            "lease_expires_at": EPOCH_TIME,
            "version": LoopItemExecution.version + 1,
        }
        if terminal_status == STATUS_FAILED:
            values["error_message"] = self._error_text(error or content or "")[:2000]
        else:
            values["error_message"] = ""
        if note:
            values["execution_note"] = self._execution_note(note)

        query = db.query(LoopItemExecution).filter(
            LoopItemExecution.id == execution_id,
            (
                LoopItemExecution.status == expected_status
                if expected_status is not None
                else LoopItemExecution.status.in_(ACTIVE_STATUSES)
            ),
        )
        if expected_version is not None:
            query = query.filter(LoopItemExecution.version == expected_version)
        updated = query.update(values, synchronize_session=False)
        if updated != 1:
            if commit:
                # End a potentially stale REPEATABLE READ snapshot before
                # loading the concurrent winner.
                db.rollback()
                return db.get(LoopItemExecution, execution_id)
            # A caller-owned transaction may already hold the LoopItem lock.
            # Do not release it on a terminal race. FOR UPDATE is a current
            # read under MySQL REPEATABLE READ, so it observes the durable
            # winner while retaining every lock owned by this transaction.
            return (
                db.query(LoopItemExecution)
                .filter(LoopItemExecution.id == execution_id)
                .populate_existing()
                .with_for_update()
                .one_or_none()
            )

        try:
            db.expire_all()
            execution = db.get(LoopItemExecution, execution_id)
            if execution is None:
                raise RuntimeError(
                    f"Terminal execution disappeared after CAS: {execution_id}"
                )
            activity = self._apply_terminal_projection(
                db,
                execution=execution,
                terminal_status=terminal_status,
                content=content,
                error=error,
                summary_note=note,
                completed_at=now,
            )
            if commit:
                db.commit()
            else:
                db.flush()
        except Exception:
            if commit:
                db.rollback()
            raise

        if commit:
            db.refresh(execution)
            self._push_activity_after_commit(db, activity)
        return execution

    def publish_terminal_projection(
        self, db: Session, execution: LoopItemExecution
    ) -> None:
        """Broadcast a terminal projection after its caller-owned commit."""

        activity = self._linked_activity(db, execution)
        self._push_activity_after_commit(db, activity)

    def reconcile_automation_run_projection(
        self,
        db: Session,
        *,
        run_id: str,
    ) -> bool:
        """Repair a run whose newest execution already has a terminal outcome.

        ``LoopItemExecution`` is the execution aggregate root. The automation
        run and activity are durable projections of its newest execution. This
        method is intentionally idempotent so a healthy worker can repair a
        write interrupted by an older process or a crash without reopening or
        rewriting the terminal execution.
        """

        from app.models.delivery import ProjectAutomationRun

        run = db.get(ProjectAutomationRun, run_id)
        if run is None:
            return False
        execution = (
            db.query(LoopItemExecution)
            .filter(LoopItemExecution.automation_run_id == run_id)
            .order_by(LoopItemExecution.id.desc())
            .first()
        )
        if execution is None or execution.status not in TERMINAL_STATUSES:
            return False
        if (
            execution.executor_type == "automation_manager"
            and self._manager_assignment_recorded(db, run_id=run_id)
        ):
            return False

        activity = self._linked_activity(db, execution)
        before = self._projection_fingerprint(run, activity)
        content, error = self._terminal_projection_content(execution)
        projected = self._apply_terminal_projection(
            db,
            execution=execution,
            terminal_status=execution.status,
            content=content,
            error=error,
            summary_note=execution.execution_note or None,
            completed_at=(
                execution.completed_at
                if not loop_datetime_value_is_unset(execution.completed_at)
                else utcnow()
            ),
        )
        if before == self._projection_fingerprint(run, projected):
            return False
        db.commit()
        db.refresh(execution)
        self._push_activity_after_commit(db, projected)
        logger.warning(
            "[LoopItemExecutions] Reconciled terminal automation projection "
            "run=%s execution=%s execution_status=%s run_status=%s",
            run_id,
            execution.id,
            execution.status,
            run.status,
        )
        return True

    def reconcile_terminal_automation_projections(
        self,
        db: Session,
        *,
        limit: int = 100,
    ) -> int:
        """Repair active automation runs backed by terminal executions."""

        from app.models.delivery import ProjectAutomationRun

        latest_executions = (
            db.query(
                LoopItemExecution.automation_run_id.label("automation_run_id"),
                func.max(LoopItemExecution.id).label("execution_id"),
            )
            .filter(LoopItemExecution.automation_run_id != "")
            .group_by(LoopItemExecution.automation_run_id)
            .subquery()
        )
        run_ids = [
            str(run_id)
            for (run_id,) in (
                db.query(ProjectAutomationRun.id)
                .join(
                    latest_executions,
                    latest_executions.c.automation_run_id == ProjectAutomationRun.id,
                )
                .join(
                    LoopItemExecution,
                    LoopItemExecution.id == latest_executions.c.execution_id,
                )
                .filter(
                    ProjectAutomationRun.status.notin_(TERMINAL_RUN_STATUSES),
                    LoopItemExecution.status.in_(TERMINAL_STATUSES),
                )
                .limit(limit)
                .all()
            )
        ]
        repaired = 0
        for run_id in run_ids:
            if self.reconcile_automation_run_projection(db, run_id=run_id):
                repaired += 1
        return repaired

    @staticmethod
    def _projection_fingerprint(
        run: object, activity: ProjectChatMessage | None
    ) -> tuple[object, ...]:
        activity_metadata = (
            activity.metadata_json
            if activity is not None and isinstance(activity.metadata_json, dict)
            else {}
        )
        return (
            getattr(run, "status", None),
            getattr(run, "description", None),
            getattr(run, "completed_at", None),
            getattr(activity, "status", None),
            getattr(activity, "message_type", None),
            getattr(activity, "content", None),
            activity_metadata.get("run_status"),
            activity_metadata.get("error"),
        )

    @staticmethod
    def _terminal_projection_content(
        execution: LoopItemExecution,
    ) -> tuple[str, str | None]:
        if execution.status == STATUS_FAILED:
            error = execution.error_message or "Automation execution failed"
            return error, error
        if execution.status == STATUS_CANCELLED:
            return execution.execution_note or "Automation run cancelled", None
        return execution.execution_note or "Automation run completed", None

    @staticmethod
    def _manager_assignment_recorded(db: Session, *, run_id: str) -> bool:
        from app.services.project_automation_execution import (
            project_automation_execution,
        )

        return project_automation_execution.has_recorded_manager_assignment(
            db, run_id=run_id
        )

    def _apply_terminal_projection(
        self,
        db: Session,
        *,
        execution: LoopItemExecution,
        terminal_status: str,
        content: Optional[str],
        error: Optional[str],
        summary_note: Optional[str],
        completed_at: datetime,
    ) -> ProjectChatMessage | None:
        """Apply the elected execution outcome without committing or pushing."""

        from app.models.delivery import ProjectAutomationRun
        from app.services.project_automation_execution import (
            project_automation_execution,
        )
        from app.services.project_chat.service import project_chat_service

        activity = self._linked_activity(db, execution)
        manager_assignment_recorded = bool(
            execution.executor_type == "automation_manager"
            and execution.automation_run_id
            and project_automation_execution.has_recorded_manager_assignment(
                db, run_id=execution.automation_run_id
            )
        )
        if activity is not None and execution.executor_type == "automation_manager":
            if terminal_status != STATUS_COMPLETED and manager_assignment_recorded:
                activity.status = STATUS_COMPLETED
                activity.message_type = "text"
                activity.content = "AI 调度员已完成分派，但调度结果回传失败。" + (
                    f" {error}" if error else ""
                )
                activity_metadata = dict(activity.metadata_json or {})
                activity.metadata_json = {
                    **activity_metadata,
                    "run_status": STATUS_COMPLETED,
                    **({"transport_error": str(error)} if error else {}),
                }
            elif terminal_status != STATUS_COMPLETED:
                activity.status = terminal_status
                activity.message_type = "text"
                activity.content = str(content or error or "AI manager failed")
                activity_metadata = dict(activity.metadata_json or {})
                activity.metadata_json = {
                    **activity_metadata,
                    "run_status": terminal_status,
                    **({"error": str(error)} if error else {}),
                }
        elif activity is not None:
            project_chat_service._finish_activity(
                db,
                activity,
                status_value=terminal_status,
                content=content,
                error=error,
            )
            metadata = dict(activity.metadata_json or {})
            activity.metadata_json = {
                **metadata,
                "run_status": terminal_status,
            }

        if execution.automation_run_id:
            run = db.get(ProjectAutomationRun, execution.automation_run_id)
            if run is not None:
                if (
                    execution.executor_type == "automation_manager"
                    and manager_assignment_recorded
                ):
                    if run.status not in TERMINAL_RUN_STATUSES:
                        run.status = "succeeded"
                        run.completed_at = completed_at
                        run.version += 1
                    return activity
                if (
                    execution.executor_type == "automation_manager"
                    and terminal_status == STATUS_COMPLETED
                ):
                    return activity
                if (
                    execution.executor_type == "project_robot"
                    and project_automation_execution.has_recorded_manager_assignment(
                        db, run_id=execution.automation_run_id
                    )
                ):
                    return activity
                run_status = {
                    STATUS_COMPLETED: "succeeded",
                    STATUS_FAILED: "failed",
                    STATUS_CANCELLED: "cancelled",
                }[terminal_status]
                summary = summary_note
                if terminal_status == STATUS_FAILED:
                    summary = error or summary_note
                description = (
                    str(summary).strip()[:2000] if summary else f"Run {run_status}."
                )
                if (
                    run.status != run_status
                    or run.description != description
                    or run.completed_at != completed_at
                ):
                    run.status = run_status
                    run.description = description
                    run.completed_at = completed_at
                    run.version += 1
        return activity

    @staticmethod
    def _finalize_manager_transport(
        db: Session,
        *,
        execution: LoopItemExecution,
        content: str | None,
    ) -> None:
        if not execution.automation_run_id:
            raise WeworkRuntimeConfigurationError(
                "AI manager execution is not linked to an automation run"
            )
        from app.services.project_automation_execution import (
            project_automation_execution,
        )

        try:
            project_automation_execution.finalize_manager_result(
                db,
                run_id=execution.automation_run_id,
                content=content if isinstance(content, str) else None,
            )
        except Exception as exc:
            logger.exception(
                "[LoopItemExecution] AI manager finalization failed execution=%s",
                execution.id,
            )
            db.rollback()
            project_automation_execution._fail_run(
                db,
                run_id=execution.automation_run_id,
                error=str(exc) or "AI manager finalization failed",
            )

    def _apply_requeued_projection(
        self,
        db: Session,
        *,
        execution: LoopItemExecution,
    ) -> ProjectChatMessage | None:
        """Project an elected retry to its run and reusable activity card."""

        from app.models.delivery import ProjectAutomationRun

        linked = self._linked_activity(db, execution)
        if linked is not None:
            metadata = dict(linked.metadata_json or {})
            linked.metadata_json = {**metadata, "run_status": STATUS_QUEUED}
            linked.status = "pending"
            linked.runtime_device_id = ""
            linked.runtime_task_id = ""
            linked.runtime_activity_key = project_chat_message_key(linked.message_id)
        if execution.runtime_device_id and execution.runtime_task_id:
            rows = (
                db.query(ProjectChatMessage)
                .filter(
                    ProjectChatMessage.runtime_device_id == execution.runtime_device_id,
                    ProjectChatMessage.runtime_task_id == execution.runtime_task_id,
                    ProjectChatMessage.sender_type == "agent",
                    ProjectChatMessage.status == "streaming",
                    loop_datetime_is_unset(ProjectChatMessage.deleted_at),
                )
                .all()
            )
            for row in rows:
                if linked is not None and row.id == linked.id:
                    continue
                if (row.content or "").strip():
                    continue
                row.deleted_at = utcnow()
                row.runtime_activity_key = project_chat_message_key(
                    row.message_id, deleted=True
                )
        if execution.automation_run_id:
            run = db.get(ProjectAutomationRun, execution.automation_run_id)
            if run is not None and run.status not in {
                "succeeded",
                "failed",
                "cancelled",
            }:
                run.status = STATUS_QUEUED
                run.version += 1
        return linked

    def _push_activity_after_commit(
        self, db: Session, activity: ProjectChatMessage | None
    ) -> None:
        """Broadcast a committed projection without weakening its durability."""

        if activity is None:
            return
        try:
            db.refresh(activity)
            self._push_activity(activity)
        except Exception:
            logger.exception(
                "[LoopItemExecution] Committed activity push failed message=%s",
                activity.message_id,
            )

    def _finish_linked_activity(
        self,
        db: Session,
        *,
        execution: LoopItemExecution,
        status_value: str,
        content: Optional[str],
        error: Optional[str] = None,
    ) -> None:
        """Close the streaming activity when a channel reports a terminal state.

        Runtime events normally close the message through the project chat
        projection; direct App-side terminal reports (complete/fail) use this
        so a started run never leaves a streaming comment behind.
        """

        from app.services.project_chat.service import project_chat_service

        try:
            row = self._linked_activity(db, execution)
            if row is None:
                return
            if status_value == "cancelled":
                if not row.content and isinstance(content, str):
                    row.content = content
                row.status = "cancelled"
                row.message_type = "text"
                project_chat_service._set_task_ai_state(
                    db,
                    row=row,
                    trigger=None,
                    agent=None,
                    status_value="cancelled",
                    error=error or content,
                )
            else:
                project_chat_service._finish_activity(
                    db, row, status_value=status_value, content=content, error=error
                )
            metadata = dict(row.metadata_json or {})
            row.metadata_json = {**metadata, "run_status": status_value}
            db.commit()
            db.refresh(row)
            self._push_activity(row)
        except Exception:
            logger.exception(
                "[LoopItemExecution] Activity finish failed execution=%s status=%s",
                execution.id,
                status_value,
            )

    @staticmethod
    def _automation_run_and_rule(
        db: Session, execution: LoopItemExecution
    ) -> tuple[Any | None, Any | None]:
        if not execution.automation_run_id:
            return None, None
        from app.models.delivery import ProjectAutomationRule, ProjectAutomationRun

        run = db.get(ProjectAutomationRun, execution.automation_run_id)
        parent_id = getattr(run, "parent_id", None)
        rule = db.get(ProjectAutomationRule, parent_id) if parent_id else None
        return run, rule

    @staticmethod
    def _automation_rule_id(db: Session, execution: LoopItemExecution) -> str:
        _, rule = LoopItemExecutionService._automation_run_and_rule(db, execution)
        return str(getattr(rule, "id", "") or "")

    @staticmethod
    def _automation_activity_message_id(
        db: Session, execution: LoopItemExecution
    ) -> str:
        run, _ = LoopItemExecutionService._automation_run_and_rule(db, execution)
        metadata = getattr(run, "metadata_json", None)
        if not isinstance(metadata, dict):
            return ""
        value = metadata.get("activity_message_id")
        return value if isinstance(value, str) else ""

    @staticmethod
    def _linked_activity(
        db: Session, execution: LoopItemExecution
    ) -> ProjectChatMessage | None:
        activity_message_id = LoopItemExecutionService._automation_activity_message_id(
            db, execution
        )
        if activity_message_id:
            row = (
                db.query(ProjectChatMessage)
                .filter(
                    ProjectChatMessage.message_id == activity_message_id,
                    ProjectChatMessage.project_id == execution.cloud_project_id,
                    loop_datetime_is_unset(ProjectChatMessage.deleted_at),
                )
                .first()
            )
            row_metadata = (
                row.metadata_json
                if row is not None and isinstance(row.metadata_json, dict)
                else {}
            )
            if row is not None and row_metadata.get("execution_id") == execution.id:
                return row
        if not execution.runtime_device_id or not execution.runtime_task_id:
            runtime_row = None
        else:
            runtime_row = (
                db.query(ProjectChatMessage)
                .filter(
                    ProjectChatMessage.runtime_device_id == execution.runtime_device_id,
                    ProjectChatMessage.runtime_task_id == execution.runtime_task_id,
                    ProjectChatMessage.sender_type == "agent",
                    loop_datetime_is_unset(ProjectChatMessage.deleted_at),
                )
                .order_by(ProjectChatMessage.id.desc())
                .first()
            )
        if runtime_row is not None:
            return runtime_row
        candidates = (
            db.query(ProjectChatMessage)
            .filter(
                ProjectChatMessage.project_id == execution.cloud_project_id,
                ProjectChatMessage.task_id == execution.loop_item_id,
                loop_datetime_is_unset(ProjectChatMessage.deleted_at),
            )
            .order_by(ProjectChatMessage.id.desc())
            .limit(20)
            .all()
        )
        for candidate in candidates:
            metadata = candidate.metadata_json
            if (
                isinstance(metadata, dict)
                and metadata.get("execution_id") == execution.id
            ):
                return candidate
        return None

    @staticmethod
    def _push_activity(row: ProjectChatMessage) -> None:
        from app.services.project_chat.push import push_project_chat_message
        from app.services.project_chat.service import project_chat_service

        push_project_chat_message(
            project_chat_service.to_view(row).model_dump(by_alias=True)
        )

    def _finish_project_automation_run(
        self,
        db: Session,
        execution: LoopItemExecution,
        status_value: str,
        note: Optional[str],
    ) -> None:
        """Finish the exact automation run formally linked to this execution."""

        from app.models.delivery import ProjectAutomationRun

        if not execution.automation_run_id:
            return
        run = db.get(ProjectAutomationRun, execution.automation_run_id)
        if run is None or run.status in {"succeeded", "failed", "cancelled"}:
            return
        terminal_status = status_value
        summary = str(note).strip() if note else f"Run {terminal_status}."
        run.status = terminal_status
        run.description = summary[:2000]
        run.completed_at = utcnow()
        run.version += 1
        db.commit()

    @staticmethod
    def _set_automation_run_status(
        db: Session,
        execution: LoopItemExecution,
        status_value: str,
        *,
        commit: bool = False,
    ) -> None:
        if not execution.automation_run_id:
            return
        from app.models.delivery import ProjectAutomationRun

        run = db.get(ProjectAutomationRun, execution.automation_run_id)
        if run is None or run.status in {"succeeded", "failed", "cancelled"}:
            return
        run.status = status_value
        run.version += 1
        if commit:
            db.commit()

    @staticmethod
    def _execution_note(note: str) -> str:
        """Fit runtime summaries into the persisted execution note column."""

        return note[:500]

    @staticmethod
    def _error_text(error: Any) -> str:
        """Normalize a runtime error value to a readable one-line string."""

        if isinstance(error, str):
            return error
        if isinstance(error, dict):
            for key in ("message", "error", "detail"):
                message = error.get(key)
                if isinstance(message, str) and message:
                    return message
            try:
                return json.dumps(error, ensure_ascii=False)[:2000]
            except (TypeError, ValueError):
                pass
        return str(error)

    def handle_runtime_event(
        self,
        db: Session,
        *,
        device_id: str,
        runtime_task_id: str,
        event_name: str,
        payload: dict,
        lease_seconds: int = DEFAULT_LEASE_SECONDS,
    ) -> Optional[LoopItemExecution]:
        """Project device runtime events onto the matching running execution.

        Streaming events extend the lease (the device is alive); terminal
        events complete or fail the run. This is the write-back path shared by
        cloud dispatches and cloud-project local pulls.
        """

        row = self.execution_for_runtime(
            db,
            runtime_device_id=device_id,
            runtime_task_id=runtime_task_id,
        )
        if row is None:
            return None
        now = utcnow()
        row.heartbeat_at = now
        row.lease_expires_at = now + timedelta(seconds=lease_seconds)
        terminal = self._terminal_status(event_name, payload)
        if terminal == STATUS_COMPLETED:
            data = payload.get("data")
            data = data if isinstance(data, dict) else {}
            from app.services.project_chat.service import ProjectChatService

            return self.complete(
                db,
                execution_id=row.id,
                content=ProjectChatService._project_chat_final_text(data, payload),
            )
        if terminal in {STATUS_FAILED, STATUS_CANCELLED}:
            data = payload.get("data")
            data = data if isinstance(data, dict) else {}
            error_value = payload.get("error") or data.get("error")
            if terminal == STATUS_CANCELLED:
                error_text = (
                    self._error_text(error_value) if error_value is not None else None
                )
                return self._transition_terminal(
                    db,
                    execution_id=row.id,
                    terminal_status=STATUS_CANCELLED,
                    note=error_text,
                    content=error_text or "AI execution was cancelled.",
                    error=error_text,
                )
            error_value = error_value or "Runtime task ended with failed"
            return self.fail(
                db,
                execution_id=row.id,
                error=self._error_text(error_value),
                requeue=True,
            )
        db.commit()
        db.refresh(row)
        return row

    def resolve_task_context(
        self,
        db: Session,
        *,
        execution: LoopItemExecution,
        user_id: int,
    ) -> Optional[TaskContext]:
        """Resolve live task data for a run from the provider or local store."""

        from app.services.loop_items.external_provider import (
            external_loop_item_provider,
        )

        project = db.get(CloudProject, execution.cloud_project_id)
        if project is not None and project.task_provider in {"github", "gitlab"}:
            view = external_loop_item_provider.task_view(
                db, execution.loop_item_id, user_id
            )
            return TaskContext(**view)
        item = db.get(LoopItem, execution.loop_item_id)
        if item is None:
            return None
        return TaskContext(
            id=item.id,
            cloud_project_id=str(item.cloud_project_id or ""),
            title=item.title or item.name or "",
            description=item.description or "",
            status=item.status,
            priority=item.priority,
            parent_id=item.parent_id or None,
            tags=item.tags,
            assignee_user_id=item.assignee_user_id or None,
            assignee_agent_id=item.assignee_agent_id or None,
        )

    def build_runtime_payload(
        self,
        db: Session,
        *,
        execution: LoopItemExecution,
    ) -> dict[str, Any]:
        """Materialize credentials and the runtime request at dispatch time."""

        profile, origin_context = self._runtime_profile_and_context(
            db, execution=execution
        )
        try:
            task = self.resolve_task_context(
                db,
                execution=execution,
                user_id=execution.executor_owner_user_id,
            )
        except Exception as exc:
            raise WeworkRuntimeConfigurationError(
                f"Execution task '{execution.loop_item_id}' is unavailable"
            ) from exc
        if task is None:
            raise WeworkRuntimeConfigurationError(
                f"Execution task '{execution.loop_item_id}' is unavailable"
            )
        materialize_request = self._materialize_backend_request(
            db,
            execution=execution,
            profile=profile,
        )
        try:
            return profile.build_runtime_payload(
                db,
                runtime_task_id=(
                    execution.runtime_task_id or runtime_task_id_for(execution.id)
                ),
                task=task,
                cloud_project_id=execution.cloud_project_id,
                origin_context=origin_context,
                materialize_execution_request=materialize_request,
            )
        except Exception as exc:
            model_label = profile.model or "the selected runtime default"
            raise WeworkRuntimeConfigurationError(
                f"Execution model '{model_label}' is unavailable"
            ) from exc

    def _runtime_profile_and_context(
        self,
        db: Session,
        *,
        execution: LoopItemExecution,
    ) -> tuple[WeworkExecutionProfile, dict[str, Any]]:
        """Resolve live executor configuration from its canonical record."""

        run, rule = self._automation_run_and_rule(db, execution)
        if execution.executor_type == "project_robot":
            if not execution.agent_id:
                raise WeworkRuntimeConfigurationError(
                    "Project robot execution has no robot"
                )
            agent = db.get(ProjectChatAgent, execution.agent_id)
            if (
                agent is None
                or agent.status != "active"
                or str(agent.cloud_project_id) != str(execution.cloud_project_id)
            ):
                raise WeworkRuntimeConfigurationError(
                    f"Project robot '{execution.agent_id}' is unavailable"
                )
            owner_user_id = int(agent.created_by_user_id or 0)
            if owner_user_id != execution.executor_owner_user_id:
                raise WeworkRuntimeConfigurationError(
                    "Project robot owner no longer matches the queued execution"
                )
            if run is not None and rule is not None:
                # Automation only decides who receives the task. Once a
                # project robot is assigned it must execute through the same
                # role + live task-context contract as an ordinary assignment;
                # the manager's scheduling prompt is not an execution prompt.
                instruction = ""
                origin_context = self._automation_runtime_context(run, rule)
            else:
                origin_context, instruction = self._task_automation_context(
                    db, execution.loop_item_id
                )
            return (
                WeworkExecutionProfile.for_project_robot(
                    agent,
                    instruction=instruction,
                ),
                origin_context,
            )

        if execution.executor_type != "automation_manager":
            raise WeworkRuntimeConfigurationError(
                f"Unknown Wework executor type '{execution.executor_type}'"
            )
        if run is None or rule is None:
            raise WeworkRuntimeConfigurationError(
                "AI manager automation run or rule is unavailable"
            )
        owner_user_id = int(getattr(rule, "created_by_user_id", 0) or 0)
        if owner_user_id != execution.executor_owner_user_id:
            raise WeworkRuntimeConfigurationError(
                "AI manager owner no longer matches the queued execution"
            )
        rule_metadata = getattr(rule, "metadata_json", None)
        rule_metadata = rule_metadata if isinstance(rule_metadata, dict) else {}
        if (
            assignment_mode(rule_metadata) != "ai_managed"
            or manager_type(rule_metadata) != "custom"
        ):
            raise WeworkRuntimeConfigurationError(
                "Automation is no longer configured for a custom AI manager"
            )
        model = rule_metadata.get("model")
        if not isinstance(model, str) or not model:
            raise WeworkRuntimeConfigurationError(
                "Custom AI manager model is unavailable"
            )
        from app.services.project_automation_execution import (
            project_automation_execution,
        )

        project = db.get(CloudProject, execution.cloud_project_id)
        owner = db.get(User, owner_user_id)
        if project is None or owner is None:
            raise WeworkRuntimeConfigurationError(
                "Automation project or owner is unavailable"
            )
        manager_prompt = project_automation_execution._managed_prompt(
            db,
            owner=owner,
            project=project,
            rule=rule,
            run=run,
            context=self._automation_runtime_context(run, rule),
        )
        return (
            WeworkExecutionProfile.for_automation_manager(
                owner_user_id=owner_user_id,
                display_name="自定义 AI 调度员",
                instruction=manager_prompt,
                model=model,
                system_prompt="你只负责选择项目成员或项目机器人，不执行原始任务。",
            ),
            self._automation_runtime_context(run, rule),
        )

    @staticmethod
    def _automation_runtime_context(run: Any, rule: Any) -> dict[str, Any]:
        run_metadata = getattr(run, "metadata_json", None)
        run_metadata = run_metadata if isinstance(run_metadata, dict) else {}
        return {
            "rule_id": str(getattr(rule, "id", "") or ""),
            "run_id": str(getattr(run, "id", "") or ""),
            "trigger": run_metadata.get("trigger") or getattr(run, "source", None),
            "scheduled_for": run_metadata.get("scheduled_for"),
            "event": run_metadata.get("event") or {},
        }

    @staticmethod
    def _materialize_backend_request(
        db: Session,
        *,
        execution: LoopItemExecution,
        profile: WeworkExecutionProfile,
    ) -> bool:
        """Choose the trusted component that resolves current model secrets."""

        if execution.execution_environment == "local":
            # The App owns the local model catalog and resolves the persisted
            # model reference immediately after claim. Even when the backend
            # happens to know a Model CRD with the same name, it must not move
            # provider credentials across the local claim boundary.
            return False
        if not profile.model:
            return True
        from app.services.chat.config.model_resolver import _find_model_with_namespace
        from app.services.runtime_codex_model import (
            get_enabled_codex_runtime_model_spec,
        )

        model_kind, model_spec = _find_model_with_namespace(
            db,
            profile.model,
            profile.owner_user_id,
        )
        if model_kind is not None and model_spec is not None:
            return True
        if (
            get_enabled_codex_runtime_model_spec(
                db,
                profile.owner_user_id,
                profile.model,
            )
            is not None
        ):
            return True
        raise WeworkRuntimeConfigurationError(
            f"Execution model '{profile.model}' is unavailable"
        )

    @staticmethod
    def _terminal_status(event_name: str, payload: dict) -> Optional[str]:
        from app.services.project_chat.service import ProjectChatService

        data = payload.get("data")
        data = data if isinstance(data, dict) else {}
        return ProjectChatService._project_chat_terminal_status(
            event_name, payload, data
        )

    # ------------------------------------------------------------------
    # Queue queries and recovery
    # ------------------------------------------------------------------

    def list_queue(
        self,
        db: Session,
        *,
        project_id: str,
        agent_id: Optional[str] = None,
        assigner_user_id: Optional[int] = None,
        status_filter: Optional[str] = None,
        include_terminal: bool = False,
        limit: int = 200,
    ) -> list[dict]:
        """Return queue rows without task display data.

        Display fields are filled by the caller (local task rows or the live
        external provider), so the execution table never duplicates tasks.
        """

        query = db.query(LoopItemExecution).filter(
            LoopItemExecution.cloud_project_id == project_id
        )
        if agent_id:
            query = query.filter(LoopItemExecution.agent_id == agent_id)
        if assigner_user_id is not None:
            query = query.filter(LoopItemExecution.assigner_user_id == assigner_user_id)
        if status_filter:
            query = query.filter(LoopItemExecution.status == status_filter)
        elif not include_terminal:
            query = query.filter(LoopItemExecution.status.in_(ACTIVE_STATUSES))
        rows = (
            query.order_by(
                LoopItemExecution.priority_weight.desc(),
                LoopItemExecution.queued_at.asc(),
                LoopItemExecution.id.asc(),
            )
            .limit(limit)
            .all()
        )
        return [
            {
                "id": execution.id,
                "loop_item_id": execution.loop_item_id,
                "cloud_project_id": execution.cloud_project_id,
                "task_title": None,
                "task_status": None,
                "task_priority": None,
                "executor_type": execution.executor_type,
                "executor_owner_user_id": execution.executor_owner_user_id,
                "agent_id": _optional_text(execution.agent_id),
                "automation_run_id": execution.automation_run_id,
                "assigner_user_id": execution.assigner_user_id,
                "execution_environment": execution.execution_environment,
                "execution_device_id": _optional_text(execution.execution_device_id),
                "status": execution.status,
                "priority_weight": execution.priority_weight,
                "queued_at": _optional_datetime(execution.queued_at),
                "started_at": _optional_datetime(execution.started_at),
                "completed_at": _optional_datetime(execution.completed_at),
                "lease_expires_at": _optional_datetime(execution.lease_expires_at),
                "heartbeat_at": _optional_datetime(execution.heartbeat_at),
                "retry_attempt": execution.retry_attempt,
                "error_message": execution.error_message,
                "execution_note": execution.execution_note,
                "approval_status": _optional_text(execution.approval_status),
                "approved_by_user_id": _optional_user_id(execution.approved_by_user_id),
                "rejected_reason": _optional_text(execution.rejected_reason),
                "runtime_device_id": _optional_text(execution.runtime_device_id),
                "runtime_task_id": _optional_text(execution.runtime_task_id),
                "version": execution.version,
                "created_at": execution.created_at,
                "updated_at": execution.updated_at,
            }
            for execution in rows
        ]

    def active_for_item(
        self, db: Session, *, item_id: str
    ) -> Optional[LoopItemExecution]:
        """Return the newest active run for a task (used by task details)."""

        return (
            db.query(LoopItemExecution)
            .filter(
                LoopItemExecution.loop_item_id == item_id,
                LoopItemExecution.status.in_(ACTIVE_STATUSES),
            )
            .order_by(LoopItemExecution.id.desc())
            .first()
        )

    def latest_for_item(
        self, db: Session, *, item_id: str
    ) -> Optional[LoopItemExecution]:
        """Return the newest run for a task regardless of terminal state."""

        return (
            db.query(LoopItemExecution)
            .filter(LoopItemExecution.loop_item_id == item_id)
            .order_by(LoopItemExecution.id.desc())
            .first()
        )

    def recovery_scan(
        self,
        db: Session,
        *,
        now: Optional[datetime] = None,
        lease_seconds: int = DEFAULT_LEASE_SECONDS,
    ) -> tuple[int, int]:
        """Recover runs whose lease expired (crashed devices/workers).

        Returns (requeued, failed) counts. A run is requeued when it has not
        exceeded its retry budget, otherwise it is marked failed.
        """

        projection_repairs = self.reconcile_terminal_automation_projections(db)
        if projection_repairs:
            logger.warning(
                "[LoopItemExecutions] Repaired %s terminal automation projection(s)",
                projection_repairs,
            )
        current = now or utcnow()
        # A healthy run renews its lease on every runtime event, so a run is
        # stale shortly after its lease expires. Do not wait another full
        # lease period: a dead executor would otherwise block the device slot
        # for up to two lease periods (10 minutes) while new runs queue.
        stale_threshold = current - timedelta(seconds=min(lease_seconds, 60))
        stale_rows = (
            db.query(LoopItemExecution)
            .filter(
                LoopItemExecution.status.in_([STATUS_CLAIMED, STATUS_RUNNING]),
                ~loop_datetime_is_unset(LoopItemExecution.lease_expires_at),
                LoopItemExecution.lease_expires_at < stale_threshold,
            )
            .all()
        )
        requeued = 0
        failed = 0
        for row in stale_rows:
            logger.warning(
                "[LoopItemExecutions] Recovering stale run execution=%s task=%s "
                "status=%s lease_expires_at=%s",
                row.id,
                row.loop_item_id,
                row.status,
                row.lease_expires_at,
            )
            self.fail(
                db,
                execution_id=row.id,
                error="Run lease expired; execution environment did not heartbeat",
                requeue=True,
            )
            if row.status == STATUS_QUEUED:
                requeued += 1
            else:
                failed += 1
        return requeued, failed

    def stall_scan(
        self,
        db: Session,
        *,
        now: Optional[datetime] = None,
        text_timeout_seconds: int = DEFAULT_STALL_TEXT_TIMEOUT_SECONDS,
    ) -> list[LoopItemExecution]:
        """Fail runs that produced no AI text for a long time.

        Lease renewal keeps event-flowing runs alive forever, which includes
        runaway tool loops that never emit assistant text. A run executing
        longer than ``text_timeout_seconds`` with an empty streaming message is
        stalled: mark it failed so the task unlocks and the device slot frees.
        Returns the stalled runs so callers can also cancel them on the device.
        """

        current = now or utcnow()
        threshold = current - timedelta(seconds=text_timeout_seconds)
        candidates = (
            db.query(LoopItemExecution)
            .filter(
                LoopItemExecution.status == STATUS_RUNNING,
                LoopItemExecution.started_at.isnot(None),
                LoopItemExecution.started_at < threshold,
            )
            .all()
        )
        stalled: list[LoopItemExecution] = []
        for execution in candidates:
            if not execution.runtime_device_id or not execution.runtime_task_id:
                continue
            message = (
                db.query(ProjectChatMessage)
                .filter(
                    ProjectChatMessage.runtime_device_id == execution.runtime_device_id,
                    ProjectChatMessage.runtime_task_id == execution.runtime_task_id,
                    ProjectChatMessage.sender_type == "agent",
                    loop_datetime_is_unset(ProjectChatMessage.deleted_at),
                )
                .order_by(ProjectChatMessage.id.desc())
                .first()
            )
            if message is not None and (message.content or "").strip():
                continue
            self.fail(
                db,
                execution_id=execution.id,
                error=(
                    f"AI 执行超过 {text_timeout_seconds // 60} 分钟未产生任何输出，"
                    "已自动停止（疑似卡死）"
                ),
                requeue=False,
            )
            stalled.append(execution)
        return stalled

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _get_for_creator(
        self, db: Session, execution_id: int, user_id: int
    ) -> LoopItemExecution:
        row = db.get(LoopItemExecution, execution_id)
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Execution not found")
        if row.executor_owner_user_id != user_id:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "Only the executor owner can approve or reject this run",
            )
        return row


loop_item_execution_service = LoopItemExecutionService()
