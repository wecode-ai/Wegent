# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Project robot queue execution records.

The queue is a derived view over `loop_item_executions`: any row in a
non-terminal state is part of the queue. This service owns the run lifecycle
(assignment -> approval -> queued -> capacity-gated claim -> running ->
terminal) plus lease-based recovery so multi-device local pullers and
multi-worker cloud dispatchers never double-claim a run.
"""

import json
import logging
from dataclasses import dataclass
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
from app.models.project_chat_message import ProjectChatMessage

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
    """Lifecycle and claiming operations for robot queue runs."""

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
    ) -> LoopItemExecution:
        """Create a run row when a task is assigned to a robot.

        A manual-approval robot starts in `pending_approval`; an auto robot
        enters the queue immediately.
        """

        from app.services.project_chat.service import bot_config

        mode = str(bot_config(agent).get("execution_mode") or "auto")
        now = utcnow()
        row = LoopItemExecution(
            loop_item_id=loop_item_id,
            cloud_project_id=cloud_project_id,
            agent_id=agent.id,
            execution_environment=environment,
            execution_device_id=execution_device_id or "",
            assigner_user_id=assigner_user_id,
            status=(
                STATUS_PENDING_APPROVAL if mode == "manual_approval" else STATUS_QUEUED
            ),
            priority_weight=priority_weight(priority),
            queued_at=now,
            max_retries=DEFAULT_MAX_RETRIES,
            approval_status=("pending" if mode == "manual_approval" else ""),
        )
        db.add(row)
        db.flush()
        return row

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
        # Same transaction rule as approve: the caller owns the commit so a
        # concurrent version conflict cannot leave a half-applied rejection.
        db.flush()
        db.refresh(row)
        return row

    def cancel(
        self, db: Session, *, execution_id: int, note: Optional[str] = None
    ) -> LoopItemExecution:
        """Cancel a run that is queued or stuck (for example on unassign)."""

        row = db.get(LoopItemExecution, execution_id)
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Execution not found")
        if row.status in TERMINAL_STATUSES:
            return row
        now = utcnow()
        row.status = STATUS_CANCELLED
        row.completed_at = now
        if note:
            row.execution_note = self._execution_note(note)
        db.commit()
        self._finish_project_automation_run(db, row.loop_item_id, "cancelled", note)
        db.refresh(row)
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
        return candidate

    def claim_next_for_device(
        self,
        db: Session,
        *,
        execution_device_id: str,
        environment: str,
        lease_seconds: int = DEFAULT_LEASE_SECONDS,
        device_capacity: int = 1,
    ) -> Optional[LoopItemExecution]:
        """Claim one queued run for any robot bound to a device.

        Used by the cloud dispatcher after acquiring the per-device Redis lock.
        The caller loops until this returns None to drain the device up to its
        capacity (each robot still runs one task at a time).
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
        running_agents = {
            agent_id
            for (agent_id,) in db.query(LoopItemExecution.agent_id)
            .filter(
                LoopItemExecution.execution_device_id == execution_device_id,
                LoopItemExecution.execution_environment == environment,
                LoopItemExecution.status == STATUS_RUNNING,
            )
            .all()
        }
        candidate = (
            db.query(LoopItemExecution)
            .filter(
                LoopItemExecution.execution_device_id == execution_device_id,
                LoopItemExecution.execution_environment == environment,
                LoopItemExecution.status == STATUS_QUEUED,
                (
                    LoopItemExecution.agent_id.notin_(running_agents)
                    if running_agents
                    else True
                ),
            )
            .order_by(
                LoopItemExecution.priority_weight.desc(),
                LoopItemExecution.queued_at.asc(),
                LoopItemExecution.id.asc(),
            )
            .limit(1)
            .first()
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
    ) -> list[LoopItemExecution]:
        """Atomically claim a batch of queued runs for one device.

        The caller holds the per-device lock, so this is the single consumer
        path for a device. Runs move to `claimed` (taken but not yet handed to
        the executor); `mark_running` advances them once the execution subtask
        actually starts. Capacity is measured on `running` plus `claimed`
        (already taken by this pass) so the device is never over-subscribed
        across consumers.
        """

        occupied = (
            db.query(func.count(LoopItemExecution.id))
            .filter(
                LoopItemExecution.execution_device_id == execution_device_id,
                LoopItemExecution.execution_environment == environment,
                LoopItemExecution.status.in_([STATUS_CLAIMED, STATUS_RUNNING]),
            )
            .scalar()
            or 0
        )
        if occupied >= device_capacity:
            return []
        occupied_agents = {
            agent_id
            for (agent_id,) in db.query(LoopItemExecution.agent_id)
            .filter(
                LoopItemExecution.execution_device_id == execution_device_id,
                LoopItemExecution.execution_environment == environment,
                LoopItemExecution.status.in_([STATUS_CLAIMED, STATUS_RUNNING]),
            )
            .all()
        }
        candidates = (
            db.query(LoopItemExecution)
            .filter(
                LoopItemExecution.execution_device_id == execution_device_id,
                LoopItemExecution.execution_environment == environment,
                LoopItemExecution.status == STATUS_QUEUED,
                (
                    LoopItemExecution.agent_id.notin_(occupied_agents)
                    if occupied_agents
                    else True
                ),
            )
            .order_by(
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
        seen_agents: set[str] = set()
        for candidate in candidates:
            if len(claimable) >= slots:
                break
            if candidate.agent_id in seen_agents:
                continue
            seen_agents.add(candidate.agent_id)
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
        return updated

    def claim_next_unbound_local(
        self,
        db: Session,
        *,
        creator_user_id: int,
        execution_device_id: str,
        lease_seconds: int = DEFAULT_LEASE_SECONDS,
    ) -> Optional[LoopItemExecution]:
        """Claim the next queued local run whose robot has no bound device.

        Robots created before device binding existed have an empty
        execution_device_id; they run on any of the creator's local devices.
        The claim binds the device so future capacity accounting is stable.
        """

        from app.models.delivery import ProjectChatAgent

        candidate = (
            db.query(LoopItemExecution)
            .join(ProjectChatAgent, ProjectChatAgent.id == LoopItemExecution.agent_id)
            .filter(
                ProjectChatAgent.created_by_user_id == creator_user_id,
                ProjectChatAgent.status == "active",
                LoopItemExecution.execution_environment == "local",
                LoopItemExecution.status == STATUS_QUEUED,
                or_(
                    LoopItemExecution.execution_device_id.is_(None),
                    LoopItemExecution.execution_device_id == "",
                ),
            )
            .order_by(
                LoopItemExecution.priority_weight.desc(),
                LoopItemExecution.queued_at.asc(),
                LoopItemExecution.id.asc(),
            )
            .limit(1)
            .first()
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
        return candidate

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

        if not execution.runtime_device_id or not execution.runtime_task_id:
            return None
        from app.schemas.project_chat import ProjectChatAgentStart
        from app.services.project_chat.service import bot_config, project_chat_service

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
        agent = db.get(ProjectChatAgent, execution.agent_id)
        if agent is None or not agent.created_by_user_id:
            logger.warning(
                "[LoopItemExecution] Activity open skipped: agent=%s unavailable",
                execution.agent_id,
            )
            return None
        return project_chat_service.start_agent_response(
            db,
            user_id=int(agent.created_by_user_id),
            request=ProjectChatAgentStart(
                project_id=str(execution.cloud_project_id),
                task_id=execution.loop_item_id,
                trigger_message_id=None,
                agent_id=agent.id,
                runtime_device_id=execution.runtime_device_id,
                runtime_task_id=execution.runtime_task_id,
                prompt=prompt or self.build_robot_prompt(agent),
                auto_retry=True,
                model=bot_config(agent).get("model"),
            ),
        )

    def close_placeholder_activity(
        self, db: Session, *, execution: LoopItemExecution
    ) -> None:
        """Drop an empty streaming activity when a run is handed back to queue.

        The message is only a placeholder until the first output arrives, so a
        requeued run must not leave a fake "AI 执行" card behind. Content-bearing
        messages are left untouched and closed by the normal terminal path.
        """

        if not execution.runtime_device_id or not execution.runtime_task_id:
            return
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
            if (row.content or "").strip():
                continue
            row.deleted_at = utcnow()
            row.runtime_activity_key = None
        db.commit()

    def complete(
        self, db: Session, *, execution_id: int, note: Optional[str] = None
    ) -> Optional[LoopItemExecution]:
        """Mark a run completed and release its device slot."""

        row = db.get(LoopItemExecution, execution_id)
        if row is None or row.status in TERMINAL_STATUSES:
            return row
        row.status = STATUS_COMPLETED
        row.completed_at = utcnow()
        row.lease_expires_at = EPOCH_TIME
        if note:
            row.execution_note = self._execution_note(note)
        db.commit()
        self._finish_runtime_activity(
            db,
            execution=row,
            status_value="completed",
            content=note,
        )
        self._finish_project_automation_run(db, row.loop_item_id, "succeeded", note)
        db.refresh(row)
        return row

    def fail(
        self,
        db: Session,
        *,
        execution_id: int,
        error: str,
        note: Optional[str] = None,
        requeue: bool = False,
        requeue_infra: bool = False,
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
        if requeue_infra:
            row.status = STATUS_QUEUED
            row.queued_at = now
            row.lease_expires_at = EPOCH_TIME
            row.error_message = self._error_text(error)[:2000]
        elif requeue and row.retry_attempt < row.max_retries:
            row.retry_attempt += 1
            row.status = STATUS_QUEUED
            row.queued_at = now
            row.lease_expires_at = EPOCH_TIME
            row.error_message = self._error_text(error)[:2000]
        else:
            row.status = STATUS_FAILED
            row.completed_at = now
            row.lease_expires_at = EPOCH_TIME
            row.error_message = self._error_text(error)[:2000]
        if note:
            row.execution_note = self._execution_note(note)
        db.commit()
        if row.status == STATUS_QUEUED:
            self.close_placeholder_activity(db, execution=row)
        elif row.status == STATUS_FAILED:
            self._finish_runtime_activity(
                db,
                execution=row,
                status_value="failed",
                content=error,
                error=error,
            )
            self._finish_project_automation_run(db, row.loop_item_id, "failed", error)
        db.refresh(row)
        return row

    def _finish_runtime_activity(
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

        if not execution.runtime_device_id or not execution.runtime_task_id:
            return
        from app.services.project_chat.service import project_chat_service

        try:
            project_chat_service.finish_runtime_activity(
                db,
                runtime_device_id=execution.runtime_device_id,
                runtime_task_id=execution.runtime_task_id,
                status_value=status_value,
                content=content,
                error=error,
            )
        except Exception:
            logger.exception(
                "[LoopItemExecution] Activity finish failed execution=%s status=%s",
                execution.id,
                status_value,
            )

    def _finish_project_automation_run(
        self,
        db: Session,
        loop_item_id: str,
        status_value: str,
        note: Optional[str],
    ) -> None:
        """Finish an automation after its run and child tasks terminate."""

        from app.models.delivery import ProjectAutomationRun

        item = db.get(LoopItem, loop_item_id)
        run = (
            db.query(ProjectAutomationRun)
            .filter(ProjectAutomationRun.task_id == loop_item_id)
            .first()
        )
        is_scan_task = run is not None
        if run is None and item is not None and item.parent_id:
            run = (
                db.query(ProjectAutomationRun)
                .filter(ProjectAutomationRun.task_id == item.parent_id)
                .first()
            )
        if run is None or run.status != "running":
            return
        if is_scan_task and status_value in {"failed", "cancelled"}:
            terminal_status = status_value
        else:
            children = (
                db.query(LoopItem)
                .filter(
                    LoopItem.parent_id == run.task_id,
                    loop_datetime_is_unset(LoopItem.deleted_at),
                )
                .all()
            )
            if is_scan_task and not children:
                terminal_status = "succeeded"
                summary = str(note).strip() if note else ""
            else:
                executions = [
                    self.latest_for_item(db, item_id=child.id) for child in children
                ]
                if any(
                    execution is None or execution.status not in TERMINAL_STATUSES
                    for execution in executions
                ):
                    return
                terminal_status = (
                    "failed"
                    if any(
                        execution.status != STATUS_COMPLETED
                        for execution in executions
                        if execution
                    )
                    else "succeeded"
                )
                completed_count = sum(
                    execution is not None and execution.status == STATUS_COMPLETED
                    for execution in executions
                )
                summary = (
                    f"Completed {len(children)} child task(s)."
                    if completed_count == len(children)
                    else f"Completed {completed_count} of {len(children)} child task(s)."
                )
        run.status = terminal_status
        if is_scan_task and status_value in {"failed", "cancelled"}:
            summary = str(note).strip() if note else f"Run {terminal_status}."
        run.description = summary[:2000]
        run.completed_at = utcnow()
        run.version += 1
        parent = db.get(LoopItem, run.task_id) if run.task_id else None
        if parent is not None and terminal_status == "succeeded":
            from app.services.loop_items.service import loop_item_service

            project = db.get(CloudProject, parent.cloud_project_id)
            statuses = loop_item_service._project_status_ids(project) if project else []
            parent.status = statuses[-1] if statuses else parent.status
            parent.completed_at = utcnow()
            parent.version += 1
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
            row.status = STATUS_COMPLETED
            row.completed_at = now
            row.lease_expires_at = EPOCH_TIME
        elif terminal in {STATUS_FAILED, STATUS_CANCELLED}:
            db.flush()
            data = payload.get("data")
            data = data if isinstance(data, dict) else {}
            error_value = (
                payload.get("error")
                or data.get("error")
                or f"Runtime task ended with {terminal}"
            )
            return self.fail(
                db,
                execution_id=row.id,
                error=self._error_text(error_value),
                requeue=True,
            )
        db.commit()
        if terminal == STATUS_COMPLETED:
            self._finish_project_automation_run(db, row.loop_item_id, "succeeded", None)
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
        )

    def build_runtime_payload(
        self,
        db: Session,
        *,
        execution: LoopItemExecution,
        task: TaskContext,
    ) -> Optional[dict]:
        """Build the runtime.tasks.create payload for a claimed run.

        Replayed by the cloud dispatcher and the local App puller, so both
        sides create the exact task the App would have created.
        """

        from app.models.delivery import ProjectChatAgent
        from app.models.user import User
        from app.services.project_chat.service import bot_config

        agent = db.get(ProjectChatAgent, execution.agent_id)
        if task is None or agent is None:
            return None
        creator = (
            db.get(User, agent.created_by_user_id) if agent.created_by_user_id else None
        )
        if creator is None:
            return None
        team = self._resolve_default_team(db, creator.id)
        model = bot_config(agent).get("model")
        model_config = {}
        if isinstance(model, str) and model:
            from app.services.chat.trigger.unified import (
                _build_cloud_gateway_model_config,
                _build_codex_runtime_model_config,
            )

            resolved = _build_codex_runtime_model_config(
                model,
                {},
                db=db,
                user_id=creator.id,
            )
            gateway_config = _build_cloud_gateway_model_config(
                db,
                model_name=model,
                creator=creator,
                upstream_api_format=resolved.get("upstream_api_format"),
            )
            # Public/group cloud models route through the backend LLM gateway
            # (same as an App send); everything else keeps its direct config.
            model_config = gateway_config or resolved
            if gateway_config:
                upstream_model_id = str(resolved.get("model_id") or "").lower()
                inferred_catalog_model_id = (
                    "wework-kimi-k2-7" if "kimi-k2.7" in upstream_model_id else None
                )
                model_config.setdefault(
                    "codex_catalog_model_id",
                    resolved.get("codex_catalog_model_id")
                    or inferred_catalog_model_id
                    or "wework-gpt-5.6-sol",
                )
                model_config["codex_responses_compat_proxy"] = True
        runtime_task_id = getattr(
            execution, "runtime_task_id", None
        ) or runtime_task_id_for(execution.id)
        payload = self._build_runtime_payload(
            item=task,
            agent=agent,
            creator=creator,
            team=team,
            prompt=self.build_robot_prompt(agent),
            model_config=model_config,
            runtime_task_id=runtime_task_id,
        )
        request = payload.get("executionRequest") or {}
        bot = request.get("bot") if isinstance(request, dict) else None
        model_config_value = (
            request.get("model_config") if isinstance(request, dict) else None
        )
        logger.info(
            "[LoopItemExecution] Runtime payload built execution=%s bot_count=%s "
            "model_config_base_url=%s",
            execution.id,
            len(bot) if isinstance(bot, list) else -1,
            (
                model_config_value.get("base_url")
                if isinstance(model_config_value, dict)
                else None
            )
            or None,
        )
        return payload

    @staticmethod
    def build_robot_prompt(agent: object) -> str:
        """Build the robot role description sent to the executor.

        The task title and description are not embedded here; the AI reads the
        bound task itself through wework_space (get_board_item). Mirror the
        App-side role description so local and cloud runs stay consistent.
        """

        from app.services.project_chat.service import bot_config

        system_prompt = bot_config(agent).get("system_prompt") or ""
        agent_name = (
            getattr(agent, "title", None) or getattr(agent, "name", None) or "AI"
        )
        return (
            f"你是 {agent_name}，这个项目任务的 AI 执行者。\n{system_prompt}"
            if system_prompt
            else f"你是 {agent_name}，这个项目任务的 AI 执行者。"
        )

    @staticmethod
    def _resolve_default_team(db: Session, user_id: int) -> Optional[object]:
        """Resolve the user's default Wework team (same source as the App)."""

        from app.api.endpoints.users import parse_default_team_config
        from app.core.config import settings
        from app.models.kind import Kind

        config = parse_default_team_config(settings.DEFAULT_TEAM_WEWORK)
        if config is None:
            return None
        return (
            db.query(Kind)
            .filter(
                Kind.kind == "Team",
                Kind.name == config.name,
                Kind.namespace == config.namespace,
                Kind.user_id == user_id,
                Kind.is_active == True,
            )
            .first()
        )

    @staticmethod
    def _build_runtime_payload(
        *,
        item: object,
        agent: object,
        creator: object,
        team: Optional[object],
        prompt: str,
        model_config: Optional[dict] = None,
        runtime_task_id: str,
    ) -> dict:
        """Build the same runtime.tasks.create payload the App sends."""

        from app.services.project_chat.service import bot_config

        config = bot_config(agent)
        system_prompt = config.get("system_prompt") or ""
        model = config.get("model")
        model = model if isinstance(model, str) else None
        runtime_model_id = model
        if model_config and model_config.get("base_url"):
            # The App routes cloud models through a known Codex catalog entry
            # while the gateway config selects the real upstream model. Using
            # the display name here makes Codex fall back to guessed metadata
            # and can add unsupported request fields such as `reasoning`.
            runtime_model_id = (
                model_config.get("codex_catalog_model_id") or "wework-gpt-5.6-sol"
            )
        task_id = runtime_task_id
        subtask_id = f"{task_id}-assistant"
        team_id = int(getattr(team, "id", 0) or 0)
        team_name = getattr(team, "name", "") or ""
        team_namespace = getattr(team, "namespace", "default") or "default"
        agent_name = (
            getattr(agent, "title", None) or getattr(agent, "name", None) or "AI"
        )
        title = getattr(item, "title", None) or getattr(item, "name", None) or ""
        local_project_id = int(
            getattr(item, "local_project_id", 0)
            or getattr(agent, "local_project_id", 0)
            or 0
        )
        identity = (
            f"你是 {agent_name}，这个项目任务的 AI 执行者。\n{system_prompt}"
            if system_prompt
            else f"你是 {agent_name}，这个项目任务的 AI 执行者。"
        )
        execution_request = {
            "task_id": task_id,
            "subtask_id": subtask_id,
            "team_id": team_id,
            "team_name": team_name,
            "team_namespace": team_namespace,
            "task_title": title,
            "subtask_title": f"{title} - Assistant",
            "user_id": creator.id,
            "user_name": creator.user_name,
            "user": {
                "id": creator.id,
                "name": creator.user_name,
                "user_name": creator.user_name,
            },
            "bot": [
                {
                    "id": agent.id,
                    "name": agent_name,
                    "shell_type": "codex",
                    "system_prompt": identity,
                }
            ],
            "system_prompt": identity,
            "prompt": prompt,
            "model_config": model_config or {},
            "standalone_chat_workspace": local_project_id <= 0,
            "enable_tools": True,
            "enable_web_search": False,
            # Match the App's default send. Enabling this unconditionally adds
            # a `reasoning` parameter that some otherwise supported gateway
            # models reject before the automation can start.
            "enable_deep_thinking": False,
            "skill_names": [],
            "mcp_servers": [],
        }
        return {
            "taskId": task_id,
            "teamId": team_id,
            "runtime": "codex",
            "message": prompt,
            "title": title,
            **({"modelId": runtime_model_id} if runtime_model_id else {}),
            "cloudProjectId": str(getattr(item, "cloud_project_id", "")),
            **({"local_project_id": local_project_id} if local_project_id > 0 else {}),
            "executionRequest": execution_request,
            "additionalContext": {
                "projectChat": {
                    "kind": "application",
                    "value": (
                        f"This run is bound to task cloud://projects/"
                        f"{getattr(item, 'cloud_project_id', '')}/todos/{getattr(item, 'id', '')} "
                        "in the current project space. Read the task with the wework_space "
                        "get_board_item tool before executing; the task link already "
                        "contains the space_id and item_id, so do not call list_spaces to "
                        "find the project. Your final response is a reviewable task comment. "
                        "Report actual changes, verification, unfinished work, and risks."
                    ),
                },
                "projectChatAgent": {
                    "kind": "application",
                    "value": identity,
                },
            },
        }

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
                "agent_id": execution.agent_id,
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
        agent = db.get(ProjectChatAgent, row.agent_id)
        if agent is None or agent.created_by_user_id != user_id:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "Only the robot creator can approve or reject this run",
            )
        return row


loop_item_execution_service = LoopItemExecutionService()
