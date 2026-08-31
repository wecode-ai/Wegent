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
from collections.abc import Collection
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from urllib.parse import urlsplit

from fastapi import HTTPException, status
from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session, aliased

from app.models.delivery import (
    CloudProject,
    CloudProjectLocalBinding,
    LoopItem,
    ProjectChatAgent,
    RuntimeProfile,
    loop_datetime_is_unset,
    loop_datetime_value_is_unset,
)
from app.models.kind import Kind
from app.models.loop_item_execution import EPOCH_TIME, LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage, project_chat_message_key
from app.models.user import User
from app.schemas.runtime_work import RuntimeTaskCreateRequest
from app.services.loop_item_executions.profile import (
    WeworkExecutionProfile,
    WeworkExecutionProfileError,
    validate_wework_execution_target,
)
from app.services.project_automation_domain import (
    TERMINAL_RUN_STATUSES,
    assignment_mode,
    manager_type,
)

logger = logging.getLogger(__name__)


def _safe_model_endpoint(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        return ""
    parsed = urlsplit(value.strip())
    if not parsed.scheme or not parsed.hostname:
        return "<invalid-url>"
    port = f":{parsed.port}" if parsed.port is not None else ""
    return f"{parsed.scheme}://{parsed.hostname}{port}{parsed.path}"


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
    assignee_team_id: int | None = None
    created_by_user_id: int | None = None

    def to_context(self) -> dict[str, Any]:
        return asdict(self)


class WeworkRuntimeConfigurationError(RuntimeError):
    """The execution intent cannot be materialized on its selected target."""


STATUS_PENDING_APPROVAL = "pending_approval"
STATUS_WAITING_RUNTIME = "waiting_runtime"
STATUS_QUEUED = "queued"
STATUS_CLAIMED = "claimed"
STATUS_RUNNING = "running"
STATUS_CANCEL_REQUESTED = "cancel_requested"
STATUS_COMPLETED = "completed"
STATUS_FAILED = "failed"
STATUS_CANCELLED = "cancelled"

TERMINAL_STATUSES = {STATUS_COMPLETED, STATUS_FAILED, STATUS_CANCELLED}
ACTIVE_STATUSES = {
    STATUS_WAITING_RUNTIME,
    STATUS_PENDING_APPROVAL,
    STATUS_QUEUED,
    STATUS_CLAIMED,
    STATUS_RUNNING,
    STATUS_CANCEL_REQUESTED,
}
CAPACITY_STATUSES = {STATUS_CLAIMED, STATUS_RUNNING, STATUS_CANCEL_REQUESTED}

OBSERVED_UNCONFIRMED = "unconfirmed"
OBSERVED_ACCEPTED = "accepted"
OBSERVED_RUNNING = "running"
OBSERVED_SUCCEEDED = "succeeded"
OBSERVED_FAILED = "failed"
OBSERVED_CANCELLED = "cancelled"

SYNC_PENDING = "pending"
SYNC_IN_SYNC = "in_sync"
SYNC_STALE = "stale"
SYNC_DIVERGED = "diverged"

# Canonical runtime task identity. The backend owns the name so every channel
# (cloud RPC, local App puller) reports the same task id and events always
# match the execution row before any output can arrive.
RUNTIME_TASK_ID_PREFIX = "codex-queue"


def runtime_task_id_for(execution_id: int) -> str:
    """Return the canonical runtime task id for one execution."""

    return f"{RUNTIME_TASK_ID_PREFIX}-{execution_id}"


def runtime_configuration_complete(
    *,
    execution_device_id: str | None,
    model: object,
    workspace_binding_required: bool = False,
    workspace_binding: object = None,
) -> bool:
    """Return whether an execution snapshot contains a runnable Runtime."""

    return bool(
        execution_device_id
        and isinstance(model, str)
        and model.strip()
        and (not workspace_binding_required or isinstance(workspace_binding, dict))
    )


def execution_scope_for(
    *,
    loop_item_id: str,
    agent_id: str,
    team_id: int | None = None,
    automation_run_id: str,
) -> str:
    """Return the concurrency and retry scope for one execution attempt."""

    if agent_id:
        return f"project_robot:{loop_item_id}"
    if team_id:
        return f"wegent_team:{loop_item_id}"
    manager_identity = automation_run_id or loop_item_id
    return f"automation_manager:{manager_identity}"


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


def execution_display_state(execution: LoopItemExecution) -> str:
    """Return the single user-facing state derived from execution truth."""

    if execution.status == STATUS_COMPLETED:
        return "succeeded"
    if execution.status in {STATUS_FAILED, STATUS_CANCELLED}:
        return execution.status
    if execution.sync_state in {SYNC_STALE, SYNC_DIVERGED}:
        return "unknown"
    if execution.status == STATUS_PENDING_APPROVAL:
        return "waiting_approval"
    if execution.status == STATUS_WAITING_RUNTIME:
        return "waiting_runtime"
    if execution.status == STATUS_QUEUED:
        return "queued"
    if execution.status == STATUS_CANCEL_REQUESTED:
        return "cancelling"
    if execution.status == STATUS_CLAIMED:
        return (
            "starting"
            if execution.observed_state == OBSERVED_UNCONFIRMED
            else "waiting_runtime"
        )
    if (
        execution.status == STATUS_RUNNING
        and execution.observed_state == OBSERVED_RUNNING
    ):
        return "running"
    return "waiting_runtime"


def execution_ai_state(
    db: Session,
    execution: LoopItemExecution,
    *,
    existing: object = None,
) -> dict[str, object] | None:
    """Project task AI metadata from the authoritative execution attempt.

    Message identifiers and prompts remain useful presentation context, but
    their cached status and Runtime address must never override the newest
    execution row.
    """

    if execution.status == STATUS_PENDING_APPROVAL:
        return None
    state = dict(existing) if isinstance(existing, dict) else {}
    agent = db.get(ProjectChatAgent, execution.agent_id) if execution.agent_id else None
    team = db.get(Kind, execution.team_id) if execution.team_id else None

    def iso(value: datetime) -> str | None:
        optional = _optional_datetime(value)
        return optional.isoformat() if optional is not None else None

    state.update(
        {
            "run_id": state.get("run_id") or f"exec-{execution.id}",
            "status": execution_display_state(execution),
            "agent_id": execution.agent_id or None,
            "team_id": execution.team_id or None,
            "agent_name": (
                "AI 托管"
                if execution.executor_type == "automation_manager"
                else (
                    team.name
                    if execution.executor_type == "wegent_team" and team is not None
                    else ((agent.title or agent.name) if agent is not None else None)
                )
            ),
            "runtime_device_id": execution.runtime_device_id or None,
            "runtime_task_id": execution.runtime_task_id or None,
            "started_at": iso(execution.started_at),
            "heartbeat_at": iso(execution.heartbeat_at),
            "lease_expires_at": iso(execution.lease_expires_at),
            "completed_at": iso(execution.completed_at),
            "updated_at": iso(execution.updated_at),
            "last_error": execution.error_message or None,
        }
    )
    return state


def _occupied_execution_scopes(
    db: Session,
    execution_scopes: set[str] | None = None,
) -> set[str]:
    """Return scopes whose previous attempt may still own a Runtime process."""

    if execution_scopes is not None and not execution_scopes:
        return set()
    query = db.query(LoopItemExecution.execution_scope).filter(
        LoopItemExecution.status.in_(CAPACITY_STATUSES),
        LoopItemExecution.execution_scope != "",
    )
    if execution_scopes is not None:
        query = query.filter(
            LoopItemExecution.execution_scope.in_(execution_scopes),
        )
    return {scope for (scope,) in query.all()}


def _runtime_capacity_used(
    db: Session,
    *,
    owner_user_id: int,
    runtime_instance_id: str,
    runtime_active: int,
    runtime_active_task_ids: set[str] | frozenset[str],
) -> int | None:
    """Combine Runtime truth with durable reservations without double-counting."""

    ambiguous = (
        db.query(LoopItemExecution.id)
        .filter(
            LoopItemExecution.executor_owner_user_id == owner_user_id,
            LoopItemExecution.status.in_(CAPACITY_STATUSES),
            LoopItemExecution.runtime_instance_id == "",
        )
        .first()
    )
    if ambiguous is not None:
        return None
    durable_task_ids = [
        str(runtime_task_id or "")
        for (runtime_task_id,) in db.query(LoopItemExecution.runtime_task_id)
        .filter(
            LoopItemExecution.executor_owner_user_id == owner_user_id,
            LoopItemExecution.runtime_instance_id == runtime_instance_id,
            LoopItemExecution.status.in_(CAPACITY_STATUSES),
        )
        .all()
    ]
    pending_reservations = sum(
        1
        for runtime_task_id in durable_task_ids
        if not runtime_task_id or runtime_task_id not in runtime_active_task_ids
    )
    return runtime_active + pending_reservations


def _active_agent_counts(
    db: Session,
    agent_ids: set[str] | None = None,
) -> dict[str, int]:
    if agent_ids is not None and not agent_ids:
        return {}
    query = db.query(
        LoopItemExecution.agent_id,
        func.count(LoopItemExecution.id),
    ).filter(
        LoopItemExecution.status.in_(CAPACITY_STATUSES),
        LoopItemExecution.agent_id != "",
    )
    if agent_ids is not None:
        query = query.filter(LoopItemExecution.agent_id.in_(agent_ids))
    return {
        str(agent_id): int(count)
        for agent_id, count in query.group_by(LoopItemExecution.agent_id).all()
    }


def _agent_limits(db: Session, agent_ids: set[str]) -> dict[str, int]:
    if not agent_ids:
        return {}
    from app.services.project_chat.service import bot_max_concurrent_executions

    return {
        row.id: bot_max_concurrent_executions(row)
        for row in db.query(ProjectChatAgent)
        .filter(ProjectChatAgent.id.in_(agent_ids))
        .all()
    }


def _agent_has_capacity(
    agent_id: str,
    *,
    active_counts: dict[str, int],
    claimed_counts: dict[str, int],
    limits: dict[str, int],
) -> bool:
    if not agent_id:
        return True
    return active_counts.get(agent_id, 0) + claimed_counts.get(
        agent_id, 0
    ) < limits.get(agent_id, 1)


def _fair_single_candidate(
    rows: list[LoopItemExecution],
    *,
    occupied_scopes: set[str],
    active_counts: dict[str, int],
    limits: dict[str, int],
) -> LoopItemExecution | None:
    """Pick FIFO per agent and least-active agent within the top priority."""

    for priority in sorted({row.priority_weight for row in rows}, reverse=True):
        first_by_agent: dict[str, LoopItemExecution] = {}
        for row in rows:
            if row.priority_weight != priority:
                continue
            if not _agent_has_capacity(
                row.agent_id,
                active_counts=active_counts,
                claimed_counts={},
                limits=limits,
            ):
                continue
            if row.execution_scope and row.execution_scope in occupied_scopes:
                continue
            key = row.agent_id or f"automation:{row.id}"
            first_by_agent.setdefault(key, row)
        if first_by_agent:
            candidates = list(first_by_agent.values())
            return min(
                enumerate(candidates),
                key=lambda item: (
                    active_counts.get(item[1].agent_id, 0),
                    item[0],
                ),
            )[1]
    return None


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
        config = bot_config(agent)
        mode = str(config.get("execution_mode") or "auto")
        runtime = str(config.get("runtime") or "codex")
        team_id = int(config["wegent_team_id"]) if runtime == "wegent" else None
        runtime_source = str(effective_context.get("runtime_source") or "agent_default")
        runtime_profile_id = effective_context.get("runtime_profile_id")
        if runtime_source == "agent_default":
            runtime_profile_id = config.get("default_runtime_profile_id")
        runtime_profile = (
            db.get(RuntimeProfile, str(runtime_profile_id))
            if runtime_profile_id
            else None
        )
        if runtime_profile is not None and runtime_profile.status != "active":
            runtime_profile = None
        task = self.resolve_task_context(
            db,
            execution=LoopItemExecution(
                loop_item_id=loop_item_id,
                cloud_project_id=cloud_project_id,
            ),
            user_id=assigner_user_id,
        )
        runtime_subject_user_id = int(
            effective_context.get("runtime_subject_user_id")
            or (task.assignee_user_id if task else 0)
            or (task.created_by_user_id if task else 0)
            or assigner_user_id
        )
        profile_metadata = (
            dict(runtime_profile.metadata_json or {}) if runtime_profile else {}
        )
        configured_model = str(
            effective_context.get("model")
            or profile_metadata.get("model")
            or config.get("model")
            or ""
        )
        configured_model_type = (
            effective_context.get("model_type")
            or profile_metadata.get("model_type")
            or config.get("model_type")
        )
        configured_model_options = dict(
            effective_context.get("model_options")
            or profile_metadata.get("model_options")
            or config.get("model_options")
            or {}
        )
        owner_user_id = int(
            runtime_profile.user_id if runtime_profile else runtime_subject_user_id
        )
        device_id = (
            None
            if runtime == "wegent"
            else (
                str(
                    effective_context.get("execution_device_id")
                    or (
                        runtime_profile.device_id
                        if runtime_profile is not None
                        else None
                    )
                    or config.get("execution_device_id")
                    or execution_device_id
                    or ""
                )
                or None
            )
        )
        if runtime == "wegent":
            selected_environment = "wegent"
        elif device_id:
            from app.services.loop_item_executions.profile import (
                wework_execution_environment,
            )

            selected_environment = wework_execution_environment(
                db,
                user_id=owner_user_id,
                execution_device_id=device_id,
            )
        else:
            selected_environment = str(environment or "local")
        runtime_selection = {
            "runtime_source": runtime_source,
            "runtime_profile_id": runtime_profile.id if runtime_profile else None,
            "runtime_profile_version": (
                runtime_profile.version if runtime_profile else None
            ),
            "model": configured_model or None,
            "model_type": configured_model_type,
            "model_options": configured_model_options,
            "workspace_policy": (profile_metadata.get("workspace_policy") or "project"),
        }
        workspace_binding_required = "workspace_binding" in effective_context
        waiting_runtime = runtime != "wegent" and not runtime_configuration_complete(
            execution_device_id=device_id,
            model=configured_model,
            workspace_binding_required=workspace_binding_required,
            workspace_binding=effective_context.get("workspace_binding"),
        )
        return self._enqueue(
            db,
            loop_item_id=loop_item_id,
            cloud_project_id=cloud_project_id,
            executor_type="project_robot",
            owner_user_id=owner_user_id,
            agent_id=agent.id,
            team_id=team_id,
            assigner_user_id=assigner_user_id,
            environment=selected_environment,
            execution_device_id=device_id,
            priority=priority,
            automation_context=effective_context,
            requires_approval=mode == "manual_approval",
            runtime_selection=runtime_selection,
            waiting_runtime=waiting_runtime,
        )

    def create_for_team_assignment(
        self,
        db: Session,
        *,
        loop_item_id: str,
        cloud_project_id: str,
        team: Kind,
        assigner_user_id: int,
        priority: str | None,
    ) -> LoopItemExecution:
        """Create the authoritative run for a Wegent Team assignment."""

        return self._enqueue(
            db,
            loop_item_id=loop_item_id,
            cloud_project_id=cloud_project_id,
            executor_type="wegent_team",
            owner_user_id=assigner_user_id,
            agent_id="",
            team_id=team.id,
            assigner_user_id=assigner_user_id,
            environment="managed",
            execution_device_id=None,
            priority=priority,
            automation_context=None,
            requires_approval=False,
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
        runtime_selection: dict[str, Any] | None = None,
        waiting_runtime: bool = False,
    ) -> LoopItemExecution:
        """Queue a custom AI manager on the ordinary Wework transport."""

        return self._enqueue(
            db,
            loop_item_id=loop_item_id,
            cloud_project_id=cloud_project_id,
            executor_type="automation_manager",
            owner_user_id=owner_user_id,
            agent_id="",
            team_id=None,
            assigner_user_id=assigner_user_id,
            environment=environment,
            execution_device_id=execution_device_id,
            priority=priority,
            automation_context=automation_context,
            requires_approval=requires_approval,
            runtime_selection={
                "executor_kind": "automation_manager",
                **(runtime_selection or {}),
            },
            waiting_runtime=waiting_runtime,
        )

    def enqueue_generic_robot(
        self,
        db: Session,
        *,
        loop_item_id: str,
        cloud_project_id: str,
        runtime_subject_user_id: int,
        runtime_profile: RuntimeProfile | None,
        execution_device_id: str | None,
        model: str | None,
        model_type: str | None,
        model_options: dict[str, str] | None,
        assigner_user_id: int,
        priority: str | None,
        automation_context: dict[str, Any],
    ) -> LoopItemExecution:
        """Queue a workflow AI role whose Runtime is selected independently."""

        metadata = dict(runtime_profile.metadata_json or {}) if runtime_profile else {}
        device_id = (
            str(runtime_profile.device_id or "")
            if runtime_profile
            else str(execution_device_id or "")
        )
        selected_model = str(metadata.get("model") or model or "")
        selected_model_type = metadata.get("model_type") or model_type
        selected_model_options = dict(
            metadata.get("model_options") or model_options or {}
        )
        environment = str(metadata.get("execution_environment") or "")
        if not environment and device_id:
            from app.services.device_service import device_service

            device = device_service.get_device_by_device_id(
                db, user_id=runtime_subject_user_id, device_id=device_id
            )
            device_type = (
                (device.json or {}).get("spec", {}).get("deviceType", "local")
                if device is not None
                else "local"
            )
            environment = "cloud" if device_type in {"cloud", "remote"} else "local"
        environment = environment or "local"
        workspace_binding_required = "workspace_binding" in automation_context
        waiting_runtime = not runtime_configuration_complete(
            execution_device_id=device_id,
            model=selected_model,
            workspace_binding_required=workspace_binding_required,
            workspace_binding=automation_context.get("workspace_binding"),
        )
        return self._enqueue(
            db,
            loop_item_id=loop_item_id,
            cloud_project_id=cloud_project_id,
            executor_type="generic_robot",
            owner_user_id=(
                int(runtime_profile.user_id or 0)
                if runtime_profile
                else runtime_subject_user_id
            ),
            agent_id="",
            team_id=None,
            assigner_user_id=assigner_user_id,
            environment=environment,
            execution_device_id=device_id or None,
            priority=priority,
            automation_context=automation_context,
            requires_approval=False,
            runtime_selection={
                "executor_kind": "generic_robot",
                "runtime_source": automation_context.get("runtime_source"),
                "runtime_profile_id": runtime_profile.id if runtime_profile else None,
                "runtime_profile_version": (
                    runtime_profile.version if runtime_profile else None
                ),
                "model": selected_model or None,
                "model_type": selected_model_type,
                "model_options": selected_model_options,
                "workspace_policy": metadata.get("workspace_policy") or "project",
            },
            waiting_runtime=waiting_runtime,
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
        team_id: int | None,
        assigner_user_id: int,
        environment: str,
        execution_device_id: str | None,
        priority: str | None,
        automation_context: dict[str, Any] | None,
        requires_approval: bool,
        runtime_selection: dict[str, Any] | None = None,
        waiting_runtime: bool = False,
    ) -> LoopItemExecution:
        """Persist queue identity and its immutable non-secret V2 intent."""

        # Project robots keep the shipped assignment semantics: their target
        # is validated when the robot is configured, and legacy local targets
        # may be represented by the App rather than a backend device row.
        # A custom manager has no robot entity, so the rule target is
        # its only source of truth and must be validated here as well as when
        # the rule is saved.
        if executor_type == "automation_manager" and not waiting_runtime:
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
        execution_scope = execution_scope_for(
            loop_item_id=loop_item_id,
            agent_id=agent_id,
            team_id=team_id,
            automation_run_id=automation_run_id,
        )
        previous = (
            db.query(LoopItemExecution)
            .filter(LoopItemExecution.execution_scope == execution_scope)
            .order_by(LoopItemExecution.id.desc())
            .first()
        )
        now = utcnow()
        row = LoopItemExecution(
            loop_item_id=loop_item_id,
            cloud_project_id=cloud_project_id,
            executor_owner_user_id=owner_user_id,
            agent_id=agent_id,
            team_id=team_id,
            automation_run_id=automation_run_id,
            execution_environment=environment,
            execution_device_id=execution_device_id or "",
            assigner_user_id=assigner_user_id,
            status=(
                STATUS_WAITING_RUNTIME
                if waiting_runtime
                else STATUS_PENDING_APPROVAL if requires_approval else STATUS_QUEUED
            ),
            priority_weight=priority_weight(priority),
            queued_at=now,
            max_retries=DEFAULT_MAX_RETRIES,
            approval_status="pending" if requires_approval else "",
            execution_note=(
                "Select a device and model before this execution can start"
                if waiting_runtime
                else ""
            ),
            execution_payload=self._serialize_execution_intent(
                runtime_selection=runtime_selection or {},
                origin_context=context,
            ),
            attempt_no=(previous.attempt_no + 1 if previous is not None else 1),
            previous_execution_id=(previous.id if previous is not None else 0),
            execution_scope=execution_scope,
            observed_state=OBSERVED_UNCONFIRMED,
            sync_state=SYNC_PENDING,
        )
        db.add(row)
        db.flush()
        row.runtime_task_id = runtime_task_id_for(row.id)
        if not waiting_runtime and executor_type != "wegent_team":
            self._persist_runtime_request_intent(db, execution=row)
        self._set_automation_run_status(
            db,
            row,
            (
                "waiting_device"
                if waiting_runtime
                else "pending" if requires_approval else "queued"
            ),
        )
        db.flush()
        return row

    @staticmethod
    def _serialize_execution_intent(
        *,
        runtime_selection: dict[str, Any],
        origin_context: dict[str, Any],
        runtime_request: dict[str, Any] | None = None,
    ) -> str:
        value: dict[str, Any] = {
            "schema_version": 2,
            "runtime_selection": runtime_selection,
            "origin_context": origin_context,
        }
        if runtime_request is not None:
            value["runtime_request"] = runtime_request
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

    def _persist_runtime_request_intent(
        self,
        db: Session,
        *,
        execution: LoopItemExecution,
    ) -> RuntimeTaskCreateRequest:
        """Build and persist the one request that both compilers consume."""

        profile, origin_context = self._runtime_profile_and_context(
            db,
            execution=execution,
        )
        task = self.resolve_task_context(
            db,
            execution=execution,
            user_id=execution.executor_owner_user_id,
        )
        if task is None:
            raise WeworkRuntimeConfigurationError(
                f"Execution task '{execution.loop_item_id}' is unavailable"
            )
        request = profile.build_runtime_request(
            db,
            execution_id=execution.id,
            runtime_task_id=(
                execution.runtime_task_id or runtime_task_id_for(execution.id)
            ),
            task=task,
            cloud_project_id=execution.cloud_project_id,
            origin_context=origin_context,
            execution_device_id=execution.execution_device_id or "",
        )
        execution.execution_payload = self._serialize_execution_intent(
            runtime_selection=dict(execution.runtime_selection),
            origin_context=dict(origin_context),
            runtime_request=request.model_dump(by_alias=True, exclude_none=True),
        )
        logger.info(
            "[RuntimeV2] Persisted execution intent: execution_id=%s task_id=%s "
            "environment=%s device_id=%s model=%s model_type=%s project_id=%s "
            "runtime_project_key=%s standalone=%s",
            execution.id,
            request.local_task_id,
            execution.execution_environment,
            request.device_id,
            request.model_id,
            request.model_type,
            request.project_id,
            request.runtime_project_key,
            request.standalone_chat_workspace,
        )
        db.flush()
        return request

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
        origin_context = row.runtime_origin_context
        needs_runtime = not row.team_id and not runtime_configuration_complete(
            execution_device_id=row.execution_device_id,
            model=row.runtime_selection.get("model"),
            workspace_binding_required="workspace_binding" in origin_context,
            workspace_binding=origin_context.get("workspace_binding"),
        )
        row.status = STATUS_WAITING_RUNTIME if needs_runtime else STATUS_QUEUED
        if not needs_runtime:
            row.queued_at = now
        row.approval_status = "approved"
        row.approved_by_user_id = user_id
        row.approved_at = now
        row.execution_note = (
            "Select a device and model before this execution can start"
            if needs_runtime
            else ""
        )
        # Do not commit here: callers fold this change into one transaction
        # with their own versioned item update, so a stale-version conflict
        # rolls the approval back instead of half-applying it.
        db.flush()
        db.refresh(row)
        return row

    def mark_managed_running(
        self,
        db: Session,
        *,
        execution_id: int,
        backend_task_id: int,
    ) -> LoopItemExecution:
        """Record that the ordinary Wegent Team pipeline accepted a board run."""

        now = utcnow()
        updated = (
            db.query(LoopItemExecution)
            .filter(
                LoopItemExecution.id == execution_id,
                LoopItemExecution.team_id > 0,
                LoopItemExecution.status == STATUS_QUEUED,
            )
            .update(
                {
                    "status": STATUS_RUNNING,
                    "backend_task_id": backend_task_id,
                    "started_at": now,
                    "observed_state": OBSERVED_RUNNING,
                    "sync_state": SYNC_IN_SYNC,
                    "observed_at": now,
                    "heartbeat_at": now,
                    "version": LoopItemExecution.version + 1,
                },
                synchronize_session=False,
            )
        )
        if updated != 1:
            db.rollback()
            current = db.get(LoopItemExecution, execution_id)
            if current is None:
                raise RuntimeError("Board Team execution disappeared")
            return current
        activity = self._linked_activity(db, db.get(LoopItemExecution, execution_id))
        if activity is not None:
            activity.status = "streaming"
            metadata = dict(activity.metadata_json or {})
            activity.metadata_json = {**metadata, "run_status": "running"}
        db.commit()
        db.expire_all()
        row = db.get(LoopItemExecution, execution_id)
        if row is None:
            raise RuntimeError("Board Team execution disappeared")
        self._push_activity_after_commit(db, activity)
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
        row.observed_state = OBSERVED_CANCELLED
        row.sync_state = SYNC_IN_SYNC
        row.observed_at = now
        row.termination_reason = "approval_rejected"
        self._apply_terminal_projection(
            db,
            execution=row,
            terminal_status=STATUS_CANCELLED,
            content=reason or "AI execution was rejected.",
            error=reason,
            summary_note=reason or "Robot creator rejected the run",
            completed_at=now,
        )
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
        """Request cancellation and terminalize only when no process can exist.

        A delivered Start or a Runtime-observed process remains
        ``cancel_requested`` until Runtime confirms that it stopped. This keeps
        reassignment and user cancellation from manufacturing a terminal fact.
        """

        row = db.get(LoopItemExecution, execution_id)
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Execution not found")
        if row.status in TERMINAL_STATUSES:
            return row
        if expected_status is not None and row.status != expected_status:
            return row
        if expected_version is not None and row.version != expected_version:
            return row
        start_was_delivered = not loop_datetime_value_is_unset(row.start_requested_at)
        if row.status in {STATUS_PENDING_APPROVAL, STATUS_QUEUED} or (
            row.status == STATUS_CLAIMED and not start_was_delivered
        ):
            terminal = self._transition_terminal(
                db,
                execution_id=execution_id,
                terminal_status=STATUS_CANCELLED,
                note=note,
                content=note or "AI execution was cancelled.",
                error=note,
                commit=commit,
                expected_status=row.status,
                expected_version=row.version,
                observed_state=OBSERVED_CANCELLED,
                observed_at=utcnow(),
                termination_reason="cancelled_before_start",
            )
            if terminal is None:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "Execution not found")
            return terminal

        now = utcnow()
        updated = (
            db.query(LoopItemExecution)
            .filter(
                LoopItemExecution.id == execution_id,
                LoopItemExecution.status.in_({STATUS_CLAIMED, STATUS_RUNNING}),
                LoopItemExecution.version == row.version,
            )
            .update(
                {
                    "status": STATUS_CANCEL_REQUESTED,
                    "cancel_requested_at": now,
                    "sync_state": SYNC_PENDING,
                    "execution_note": self._execution_note(
                        note or "Runtime cancellation requested"
                    ),
                    "version": LoopItemExecution.version + 1,
                },
                synchronize_session=False,
            )
        )
        if updated != 1:
            if commit:
                db.rollback()
            current = db.get(LoopItemExecution, execution_id)
            if current is None:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "Execution not found")
            return current
        if commit:
            db.commit()
        else:
            db.flush()
        db.expire_all()
        current = db.get(LoopItemExecution, execution_id)
        if current is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Execution not found")
        if commit:
            self.open_execution_activity(db, execution=current)
            db.refresh(current)
        return current

    def confirm_runtime_cancelled(
        self,
        db: Session,
        *,
        execution_id: int,
        note: Optional[str] = None,
        commit: bool = True,
    ) -> Optional[LoopItemExecution]:
        """Commit cancellation after Runtime's stop ACK or cancelled event."""

        current = db.get(LoopItemExecution, execution_id)
        if current is not None and current.termination_reason == "stall_timeout":
            return self._transition_terminal(
                db,
                execution_id=execution_id,
                terminal_status=STATUS_FAILED,
                note=note or current.execution_note,
                content=current.execution_note or "Runtime execution stalled",
                error=current.execution_note or "Runtime execution stalled",
                expected_status=STATUS_CANCEL_REQUESTED,
                observed_state=OBSERVED_CANCELLED,
                observed_at=utcnow(),
                termination_reason="stall_timeout",
                commit=commit,
            )
        return self._transition_terminal(
            db,
            execution_id=execution_id,
            terminal_status=STATUS_CANCELLED,
            note=note,
            content=note or "AI execution was cancelled.",
            expected_status=STATUS_CANCEL_REQUESTED,
            observed_state=OBSERVED_CANCELLED,
            observed_at=utcnow(),
            termination_reason="runtime_cancel_acknowledged",
            commit=commit,
        )

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
        owner_user_id: int,
        runtime_instance_id: str,
        device_capacity: int,
        runtime_active: int,
        runtime_active_task_ids: set[str] | frozenset[str],
        lease_seconds: int = DEFAULT_LEASE_SECONDS,
        assigner_filter: Optional[int] = None,
    ) -> Optional[LoopItemExecution]:
        """Atomically claim the next queued run for one robot on one device.

        Returns None when the robot's queue is empty or the device has no free
        capacity. The caller is responsible for holding the per-device Redis
        lock when multiple workers/pullers race (cloud dispatchers); the CAS
        below keeps a single claim atomic even without it.
        """

        running_count = _runtime_capacity_used(
            db,
            owner_user_id=owner_user_id,
            runtime_instance_id=runtime_instance_id,
            runtime_active=runtime_active,
            runtime_active_task_ids=runtime_active_task_ids,
        )
        if running_count is None or running_count >= device_capacity:
            return None
        active_counts = _active_agent_counts(db, {agent_id})
        limits = _agent_limits(db, {agent_id})
        if not _agent_has_capacity(
            agent_id,
            active_counts=active_counts,
            claimed_counts={},
            limits=limits,
        ):
            return None

        query = (
            db.query(LoopItemExecution)
            .filter(
                LoopItemExecution.executor_owner_user_id == owner_user_id,
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
        )
        if assigner_filter is not None:
            query = query.filter(LoopItemExecution.assigner_user_id == assigner_filter)
        candidate = query.first()
        if candidate is None:
            return None
        if candidate.execution_scope in _occupied_execution_scopes(
            db,
            {candidate.execution_scope} if candidate.execution_scope else set(),
        ):
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
                    "status": STATUS_CLAIMED,
                    "claimed_at": now,
                    "heartbeat_at": now,
                    "lease_expires_at": now + timedelta(seconds=lease_seconds),
                    "runtime_device_id": execution_device_id,
                    "runtime_instance_id": runtime_instance_id,
                    "runtime_task_id": runtime_task_id_for(candidate.id),
                    "version": LoopItemExecution.version + 1,
                }
            )
        )
        db.commit()
        if claimed != 1:
            return None
        db.refresh(candidate)
        return candidate

    def claim_next_for_device(
        self,
        db: Session,
        *,
        execution_device_id: str,
        runtime_device_id: Optional[str] = None,
        environment: str,
        runtime_instance_id: str,
        device_capacity: int,
        runtime_active: int,
        runtime_active_task_ids: set[str] | frozenset[str],
        owner_user_id: int,
        lease_seconds: int = DEFAULT_LEASE_SECONDS,
    ) -> Optional[LoopItemExecution]:
        """Claim one queued run for a stable execution target."""

        running_count = _runtime_capacity_used(
            db,
            owner_user_id=owner_user_id,
            runtime_instance_id=runtime_instance_id,
            runtime_active=runtime_active,
            runtime_active_task_ids=runtime_active_task_ids,
        )
        if running_count is None or running_count >= device_capacity:
            return None
        queue_filters = (
            LoopItemExecution.executor_owner_user_id == owner_user_id,
            LoopItemExecution.execution_device_id == execution_device_id,
            LoopItemExecution.execution_environment == environment,
            LoopItemExecution.status == STATUS_QUEUED,
        )
        agent_ids = {
            str(agent_id)
            for (agent_id,) in db.query(LoopItemExecution.agent_id)
            .filter(*queue_filters, LoopItemExecution.agent_id != "")
            .distinct()
            .all()
        }
        active_counts = _active_agent_counts(db, agent_ids)
        limits = _agent_limits(db, agent_ids)

        active_execution = aliased(LoopItemExecution)
        scope_is_available = or_(
            LoopItemExecution.execution_scope == "",
            ~db.query(active_execution.id)
            .filter(
                active_execution.status.in_(CAPACITY_STATUSES),
                active_execution.execution_scope == LoopItemExecution.execution_scope,
            )
            .exists(),
        )
        ranked = (
            db.query(
                LoopItemExecution.id.label("execution_id"),
                func.row_number()
                .over(
                    partition_by=LoopItemExecution.agent_id,
                    order_by=(
                        LoopItemExecution.priority_weight.desc(),
                        LoopItemExecution.queued_at.asc(),
                        LoopItemExecution.id.asc(),
                    ),
                )
                .label("agent_queue_rank"),
            )
            .filter(*queue_filters, scope_is_available)
            .subquery()
        )
        candidate_ids = [
            int(execution_id)
            for (execution_id,) in db.query(ranked.c.execution_id)
            .filter(ranked.c.agent_queue_rank == 1)
            .all()
        ]
        if not candidate_ids:
            return None
        rows = (
            db.query(LoopItemExecution)
            .filter(LoopItemExecution.id.in_(candidate_ids))
            .order_by(
                LoopItemExecution.priority_weight.desc(),
                LoopItemExecution.queued_at.asc(),
                LoopItemExecution.id.asc(),
            )
            .all()
        )
        candidate = _fair_single_candidate(
            rows,
            occupied_scopes=set(),
            active_counts=active_counts,
            limits=limits,
        )
        if candidate is None:
            return None
        now = utcnow()
        claimed_runtime_device_id = runtime_device_id or execution_device_id
        claimed = (
            db.query(LoopItemExecution)
            .filter(
                LoopItemExecution.id == candidate.id,
                LoopItemExecution.status == STATUS_QUEUED,
            )
            .update(
                {
                    "status": STATUS_CLAIMED,
                    "claimed_at": now,
                    "heartbeat_at": now,
                    "lease_expires_at": now + timedelta(seconds=lease_seconds),
                    "runtime_device_id": claimed_runtime_device_id,
                    "runtime_instance_id": runtime_instance_id,
                    "runtime_task_id": runtime_task_id_for(candidate.id),
                    "version": LoopItemExecution.version + 1,
                }
            )
        )
        db.commit()
        if claimed != 1:
            return None
        db.refresh(candidate)
        return candidate

    def claim_batch_for_device(
        self,
        db: Session,
        *,
        execution_device_id: str,
        environment: str,
        runtime_instance_id: str,
        device_capacity: int,
        runtime_active: int,
        runtime_active_task_ids: set[str] | frozenset[str],
        owner_user_id: int,
        lease_seconds: int = DEFAULT_LEASE_SECONDS,
        batch_size: int = 16,
    ) -> list[LoopItemExecution]:
        """Atomically claim a batch of queued runs for one device.

        The caller holds the per-device lock, so this is the single consumer
        path for a device. Runs move to `claimed` (taken but not yet handed to
        the executor); `mark_start_requested` records when the execution
        subtask may deliver Start. Capacity includes every claimed or active run
        (already taken by this pass) so the device is never over-subscribed
        across consumers.
        """

        occupied = _runtime_capacity_used(
            db,
            owner_user_id=owner_user_id,
            runtime_instance_id=runtime_instance_id,
            runtime_active=runtime_active,
            runtime_active_task_ids=runtime_active_task_ids,
        )
        if occupied is None or occupied >= device_capacity:
            return []
        candidates = db.query(LoopItemExecution).filter(
            LoopItemExecution.execution_device_id == execution_device_id,
            LoopItemExecution.execution_environment == environment,
            LoopItemExecution.status == STATUS_QUEUED,
        )
        candidates = candidates.filter(
            LoopItemExecution.executor_owner_user_id == owner_user_id
        )
        candidates = candidates.order_by(
            LoopItemExecution.priority_weight.desc(),
            LoopItemExecution.queued_at.asc(),
            LoopItemExecution.id.asc(),
        ).all()
        if not candidates:
            return []
        slots = min(batch_size, max(0, device_capacity - occupied))
        claimable: list[int] = []
        claimed_agent_counts: dict[str, int] = {}
        seen_scopes: set[str] = set()
        agent_ids = {
            candidate.agent_id for candidate in candidates if candidate.agent_id
        }
        execution_scopes = {
            candidate.execution_scope
            for candidate in candidates
            if candidate.execution_scope
        }
        occupied_scopes = _occupied_execution_scopes(db, execution_scopes)
        active_counts = _active_agent_counts(db, agent_ids)
        limits = _agent_limits(db, agent_ids)
        priorities = sorted(
            {candidate.priority_weight for candidate in candidates}, reverse=True
        )
        for priority in priorities:
            queues: dict[str, list[LoopItemExecution]] = {}
            for candidate in candidates:
                if candidate.priority_weight != priority:
                    continue
                key = candidate.agent_id or f"automation:{candidate.id}"
                queues.setdefault(key, []).append(candidate)
            while queues and len(claimable) < slots:
                progressed = False
                for key in list(queues):
                    queue = queues[key]
                    selected = None
                    while queue:
                        candidate = queue.pop(0)
                        if not _agent_has_capacity(
                            candidate.agent_id,
                            active_counts=active_counts,
                            claimed_counts=claimed_agent_counts,
                            limits=limits,
                        ):
                            queue.clear()
                            break
                        if candidate.execution_scope and (
                            candidate.execution_scope in occupied_scopes
                            or candidate.execution_scope in seen_scopes
                        ):
                            continue
                        selected = candidate
                        break
                    if not queue:
                        queues.pop(key, None)
                    if selected is None:
                        continue
                    claimable.append(selected.id)
                    if selected.agent_id:
                        claimed_agent_counts[selected.agent_id] = (
                            claimed_agent_counts.get(selected.agent_id, 0) + 1
                        )
                    if selected.execution_scope:
                        seen_scopes.add(selected.execution_scope)
                    progressed = True
                    if len(claimable) >= slots:
                        break
                if not progressed:
                    break
            if len(claimable) >= slots:
                break
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
                    "claimed_at": now,
                    "heartbeat_at": now,
                    "lease_expires_at": now + timedelta(seconds=lease_seconds),
                    "runtime_instance_id": runtime_instance_id,
                    "version": LoopItemExecution.version + 1,
                },
                synchronize_session=False,
            )
        )
        db.flush()
        if updated != len(claimable):
            db.rollback()
            return []
        db.expire_all()
        rows = (
            db.query(LoopItemExecution)
            .filter(LoopItemExecution.id.in_(claimable))
            .all()
        )
        for row in rows:
            row.runtime_device_id = execution_device_id
            row.runtime_task_id = runtime_task_id_for(row.id)
        db.commit()
        for row in rows:
            db.refresh(row)
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
        runtime_instance_id: str,
        device_capacity: int,
        runtime_active: int,
        runtime_active_task_ids: set[str] | frozenset[str],
        lease_seconds: int = DEFAULT_LEASE_SECONDS,
    ) -> Optional[LoopItemExecution]:
        """Claim a legacy project-robot run without a persisted device binding."""

        occupied = _runtime_capacity_used(
            db,
            owner_user_id=owner_user_id,
            runtime_instance_id=runtime_instance_id,
            runtime_active=runtime_active,
            runtime_active_task_ids=runtime_active_task_ids,
        )
        if occupied is None or occupied >= device_capacity:
            return None
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
            .all()
        )
        agent_ids = {row.agent_id for row in candidates if row.agent_id}
        execution_scopes = {
            row.execution_scope for row in candidates if row.execution_scope
        }
        occupied_scopes = _occupied_execution_scopes(db, execution_scopes)
        active_counts = _active_agent_counts(db, agent_ids)
        limits = _agent_limits(db, agent_ids)
        candidate = _fair_single_candidate(
            candidates,
            occupied_scopes=occupied_scopes,
            active_counts=active_counts,
            limits=limits,
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
                    "status": STATUS_CLAIMED,
                    "execution_device_id": execution_device_id,
                    "claimed_at": now,
                    "heartbeat_at": now,
                    "lease_expires_at": now + timedelta(seconds=lease_seconds),
                    "runtime_device_id": execution_device_id,
                    "runtime_instance_id": runtime_instance_id,
                    "runtime_task_id": runtime_task_id_for(candidate.id),
                    "version": LoopItemExecution.version + 1,
                }
            )
        )
        db.commit()
        if claimed != 1:
            return None
        db.refresh(candidate)
        return candidate

    def mark_start_requested(
        self,
        db: Session,
        *,
        execution_ids: list[int],
        lease_seconds: int = DEFAULT_LEASE_SECONDS,
    ) -> int:
        """Record that a Runtime start command may now be delivered.

        The row stays claimed. Only a Runtime event or a trusted Runtime status
        query may prove that the process is running.
        """

        if not execution_ids:
            return 0
        now = utcnow()
        updated = (
            db.query(LoopItemExecution)
            .filter(
                LoopItemExecution.id.in_(execution_ids),
                LoopItemExecution.status == STATUS_CLAIMED,
                loop_datetime_is_unset(LoopItemExecution.start_requested_at),
            )
            .update(
                {
                    "start_requested_at": now,
                    "heartbeat_at": now,
                    "lease_expires_at": now + timedelta(seconds=lease_seconds),
                    "version": LoopItemExecution.version + 1,
                },
                synchronize_session=False,
            )
        )
        db.flush()
        if updated:
            db.expire_all()
            executions = (
                db.query(LoopItemExecution)
                .filter(
                    LoopItemExecution.id.in_(execution_ids),
                    LoopItemExecution.status == STATUS_CLAIMED,
                )
                .all()
            )
            for execution in executions:
                self._bind_issue_execution_task(db, execution=execution)
        db.commit()
        return updated

    def _bind_issue_execution_task(
        self,
        db: Session,
        *,
        execution: LoopItemExecution,
    ) -> None:
        """Create the Issue TaskBinding before Runtime delivery."""

        if not execution.runtime_device_id or not execution.runtime_task_id:
            return
        run, _ = self._automation_run_and_rule(db, execution)
        metadata = (
            run.metadata_json
            if run is not None and isinstance(run.metadata_json, dict)
            else {}
        )
        snapshot = metadata.get("workflow_stage_input")
        stage_snapshot = snapshot if isinstance(snapshot, dict) else None
        workflow_node_id: str | None = None
        if stage_snapshot is not None:
            target = stage_snapshot.get("target_stage")
            workflow_node_id = (
                str(target.get("id") or "") if isinstance(target, dict) else ""
            )
            if not workflow_node_id:
                raise WeworkRuntimeConfigurationError(
                    "Workflow stage execution has no target stage"
                )
        item = db.get(LoopItem, execution.loop_item_id)
        if item is None:
            raise WeworkRuntimeConfigurationError("Issue execution task is unavailable")
        from app.schemas.delivery import LoopItemTaskBind
        from app.services.loop_items.service import loop_item_service

        binding = loop_item_service.bind_execution_task(
            db,
            item_id=item.id,
            values=LoopItemTaskBind(
                deviceId=execution.runtime_device_id,
                taskId=execution.runtime_task_id,
                taskTitle=item.title or "",
                backendTaskId=execution.backend_task_id or None,
                workflowNodeId=workflow_node_id,
            ),
            user_id=execution.executor_owner_user_id,
            stage_snapshot=stage_snapshot,
            commit=False,
        )
        binding.metadata_json = {
            **(
                binding.metadata_json if isinstance(binding.metadata_json, dict) else {}
            ),
            "workspace_device_id": (
                execution.execution_device_id or execution.runtime_device_id
            ),
        }
        db.flush()

    def request_runtime_start(
        self,
        db: Session,
        *,
        execution_id: int,
        runtime_device_id: str,
        runtime_task_id: str,
        lease_seconds: int = DEFAULT_LEASE_SECONDS,
    ) -> Optional[LoopItemExecution]:
        """Fence one App-originated Runtime create before delivery.

        A persisted ``start_requested_at`` separates a claim that is safe to
        return to the queue from a create request that may already have reached
        Runtime. The latter must be reconciled, never guessed or redelivered.
        """

        row = db.get(LoopItemExecution, execution_id)
        if row is None or row.status != STATUS_CLAIMED:
            return None
        if runtime_task_id != runtime_task_id_for(row.id):
            return None
        if row.runtime_device_id not in {"", runtime_device_id}:
            return None
        updated = self.mark_start_requested(
            db,
            execution_ids=[execution_id],
            lease_seconds=lease_seconds,
        )
        if updated != 1:
            return None
        db.expire_all()
        return db.get(LoopItemExecution, execution_id)

    def report_runtime_dispatch_unknown(
        self,
        db: Session,
        *,
        execution_id: int,
        runtime_device_id: str,
        runtime_task_id: str,
        error: str,
    ) -> Optional[LoopItemExecution]:
        """Preserve capacity when an App-originated create has no known result.

        Once delivery intent exists, a missing response cannot distinguish a
        rejected request from a lost acceptance response. The execution stays
        claimed and becomes stale so reconciliation, not redelivery, decides.
        """

        row = db.get(LoopItemExecution, execution_id)
        if row is None:
            return None
        if (
            row.status != STATUS_CLAIMED
            or loop_datetime_value_is_unset(row.start_requested_at)
            or row.runtime_device_id != runtime_device_id
            or row.runtime_task_id != runtime_task_id
        ):
            return row
        return self.mark_dispatch_unknown(
            db,
            execution_id=execution_id,
            error=error,
        )

    def fail_runtime_preflight(
        self,
        db: Session,
        *,
        execution_id: int,
        error: str,
        note: Optional[str] = None,
    ) -> Optional[LoopItemExecution]:
        """Fail only while Runtime delivery is provably impossible."""

        row = db.get(LoopItemExecution, execution_id)
        if row is None:
            return None
        if (
            row.status != STATUS_CLAIMED
            or not loop_datetime_value_is_unset(row.start_requested_at)
            or row.observed_state != OBSERVED_UNCONFIRMED
        ):
            return row
        return self.fail(
            db,
            execution_id=row.id,
            error=error,
            note=note or "runtime_preflight_failed",
            requeue=False,
            expected_status=STATUS_CLAIMED,
            expected_version=row.version,
        )

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
        """Extend the control-plane lease without asserting Runtime liveness."""

        row = db.get(LoopItemExecution, execution_id)
        if row is None or row.status not in CAPACITY_STATUSES:
            return None
        expected_task_id = runtime_task_id_for(row.id)
        if runtime_task_id and runtime_task_id != expected_task_id:
            logger.warning(
                "[LoopItemExecution] Rejected heartbeat Runtime identity mismatch "
                "execution=%s expected=%s incoming=%s",
                row.id,
                expected_task_id,
                runtime_task_id,
            )
            return None
        if runtime_device_id and row.runtime_device_id not in {"", runtime_device_id}:
            logger.warning(
                "[LoopItemExecution] Rejected heartbeat device mismatch "
                "execution=%s expected=%s incoming=%s",
                row.id,
                row.runtime_device_id,
                runtime_device_id,
            )
            return None
        now = utcnow()
        row.heartbeat_at = now
        row.lease_expires_at = now + timedelta(seconds=lease_seconds)
        if runtime_device_id:
            row.runtime_device_id = runtime_device_id
        if runtime_task_id:
            row.runtime_task_id = expected_task_id
        db.commit()
        db.refresh(row)
        return row

    def confirm_runtime_accepted(
        self,
        db: Session,
        *,
        execution_id: int,
        runtime_device_id: str,
        runtime_task_id: str,
        lease_seconds: int = DEFAULT_LEASE_SECONDS,
        commit: bool = True,
    ) -> Optional[LoopItemExecution]:
        """Record Runtime acceptance without claiming that execution has started."""

        row = db.get(LoopItemExecution, execution_id)
        if row is None or row.status != STATUS_CLAIMED:
            return None
        if runtime_task_id != runtime_task_id_for(row.id):
            return None
        if row.runtime_device_id not in {"", runtime_device_id}:
            return None
        now = utcnow()
        row.runtime_device_id = runtime_device_id
        row.runtime_task_id = runtime_task_id
        if loop_datetime_value_is_unset(row.start_requested_at):
            row.start_requested_at = now
        row.observed_state = OBSERVED_ACCEPTED
        row.sync_state = SYNC_IN_SYNC
        row.error_message = ""
        row.termination_reason = ""
        row.observed_at = now
        row.heartbeat_at = now
        row.lease_expires_at = now + timedelta(seconds=lease_seconds)
        row.version += 1
        if commit:
            db.commit()
            db.refresh(row)
        else:
            db.flush()
        return row

    def accept_runtime_and_open_activity(
        self,
        db: Session,
        *,
        execution_id: int,
        runtime_device_id: str,
        runtime_task_id: str,
        prompt: Optional[str],
    ) -> Optional[LoopItemExecution]:
        """Commit Runtime acceptance and its activity projection together."""

        try:
            row = self.confirm_runtime_accepted(
                db,
                execution_id=execution_id,
                runtime_device_id=runtime_device_id,
                runtime_task_id=runtime_task_id,
                commit=False,
            )
            if row is None:
                db.rollback()
                return None
            view = self.open_execution_activity(
                db,
                execution=row,
                prompt=prompt,
                commit=False,
                push=False,
            )
            db.commit()
        except Exception:
            db.rollback()
            raise
        db.refresh(row)
        if view is not None:
            from app.services.project_chat.push import push_project_chat_message

            push_project_chat_message(view.model_dump(by_alias=True))
        return row

    def execution_for_runtime(
        self,
        db: Session,
        *,
        runtime_device_id: str,
        runtime_task_id: str,
    ) -> Optional[LoopItemExecution]:
        """Resolve the active execution owned by a Runtime task identity."""

        return (
            db.query(LoopItemExecution)
            .filter(
                LoopItemExecution.runtime_device_id == runtime_device_id,
                LoopItemExecution.runtime_task_id == runtime_task_id,
                LoopItemExecution.status.in_(CAPACITY_STATUSES),
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
        commit: bool = True,
        push: bool = True,
    ) -> Optional[object]:
        """Open the reviewable AI activity for a claimed or running attempt.

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
        if current is None or current.status not in CAPACITY_STATUSES:
            logger.info(
                "[LoopItemExecution] Activity open skipped for inactive "
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
                ProjectChatMessage.status.in_(["pending", "streaming"]),
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
            profile, origin_context = self._runtime_profile_and_context(
                db, execution=execution
            )
        except WeworkRuntimeConfigurationError:
            logger.exception(
                "[LoopItemExecution] Activity open failed: unavailable runtime "
                "configuration execution=%s",
                execution.id,
            )
            return None
        activity_status = (
            "streaming" if execution.status == STATUS_RUNNING else "pending"
        )
        run_status = (
            "running"
            if execution.status == STATUS_RUNNING
            else (
                "cancelling"
                if execution.status == STATUS_CANCEL_REQUESTED
                else "starting"
            )
        )
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
                status=activity_status,
            )
            db.add(row)
            db.flush()
        metadata = dict(row.metadata_json or {})
        metadata.update(
            {
                "run_status": run_status,
                "execution_id": execution.id,
                "executor_type": execution.executor_type,
                "executor_ref": execution.agent_id
                or self._automation_rule_id(db, execution),
                "automation_run_id": execution.automation_run_id,
                "model": profile.model or None,
            }
        )
        row.message_type = "agent_chunk"
        row.metadata_json = metadata
        row.runtime_device_id = execution.runtime_device_id
        row.runtime_task_id = execution.runtime_task_id
        row.runtime_activity_key = project_chat_service._runtime_activity_key(
            execution.runtime_device_id,
            execution.runtime_task_id,
            row.trigger_message_id or "",
        )
        row.status = activity_status
        agent = (
            db.get(ProjectChatAgent, execution.agent_id) if execution.agent_id else None
        )
        if (
            execution.executor_type != "automation_manager"
            and execution.status == STATUS_RUNNING
        ):
            visible_prompt = prompt or profile.user_input(
                project_id=execution.cloud_project_id,
                task_id=execution.loop_item_id,
                execution_id=execution.id,
                workflow_stage_input=(
                    origin_context.get("workflow_stage_input")
                    if isinstance(origin_context.get("workflow_stage_input"), dict)
                    else None
                ),
            )
            project_chat_service._set_task_ai_state(
                db,
                row=row,
                trigger=None,
                agent=agent,
                status_value="running",
                prompt=visible_prompt,
                user_id=execution.executor_owner_user_id,
            )
        if commit:
            db.commit()
            db.refresh(row)
        else:
            db.flush()
        view = project_chat_service.to_view(row)
        if push:
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
        expected_status: Optional[str] = None,
        expected_version: Optional[int] = None,
        observed_at: Optional[datetime] = None,
        event_seq: Optional[int] = None,
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
            expected_status=expected_status,
            expected_version=expected_version,
            observed_state=OBSERVED_SUCCEEDED,
            observed_at=observed_at,
            event_seq=event_seq,
            termination_reason="runtime_succeeded",
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
        observed_at: Optional[datetime] = None,
        event_seq: Optional[int] = None,
        termination_reason: str = "runtime_failed",
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
                observed_state=OBSERVED_FAILED,
                observed_at=observed_at,
                event_seq=event_seq,
                termination_reason=termination_reason,
            )

        if requeue and not requeue_infra:
            previous = self._transition_terminal(
                db,
                execution_id=execution_id,
                terminal_status=STATUS_FAILED,
                note=note,
                content=error,
                error=error,
                commit=False,
                expected_status=expected_status,
                expected_version=expected_version,
                observed_state=OBSERVED_FAILED,
                observed_at=observed_at,
                event_seq=event_seq,
                termination_reason=termination_reason,
            )
            if previous is None or previous.status != STATUS_FAILED:
                db.rollback()
                return db.get(LoopItemExecution, execution_id)
            retry = self._new_retry_attempt(previous, queued_at=now)
            db.add(retry)
            db.flush()
            retry.runtime_task_id = runtime_task_id_for(retry.id)
            self._set_automation_run_status(db, retry, "queued")
            db.commit()
            db.refresh(retry)
            self.publish_terminal_projection(db, previous)
            return retry

        values: dict[str, Any] = {
            "status": STATUS_QUEUED,
            "queued_at": now,
            "lease_expires_at": EPOCH_TIME,
            "error_message": self._error_text(error)[:2000],
            "version": LoopItemExecution.version + 1,
        }
        if requeue_infra:
            values.update(
                {
                    "start_requested_at": EPOCH_TIME,
                    "observed_state": OBSERVED_UNCONFIRMED,
                    "observed_at": EPOCH_TIME,
                    "sync_state": SYNC_PENDING,
                    "termination_reason": "",
                }
            )
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

    @staticmethod
    def _new_retry_attempt(
        previous: LoopItemExecution, *, queued_at: datetime
    ) -> LoopItemExecution:
        """Create an isolated attempt after Runtime proved the old one ended."""

        return LoopItemExecution(
            loop_item_id=previous.loop_item_id,
            cloud_project_id=previous.cloud_project_id,
            executor_owner_user_id=previous.executor_owner_user_id,
            agent_id=previous.agent_id,
            team_id=previous.team_id,
            backend_task_id=None,
            automation_run_id=previous.automation_run_id,
            execution_environment=previous.execution_environment,
            execution_device_id=previous.execution_device_id,
            assigner_user_id=previous.assigner_user_id,
            status=STATUS_QUEUED,
            priority_weight=previous.priority_weight,
            queued_at=queued_at,
            attempt_no=previous.attempt_no + 1,
            previous_execution_id=previous.id,
            execution_scope=previous.execution_scope,
            observed_state=OBSERVED_UNCONFIRMED,
            sync_state=SYNC_PENDING,
            retry_attempt=previous.retry_attempt + 1,
            max_retries=previous.max_retries,
            approval_status="approved" if previous.approval_status else "",
            approved_by_user_id=previous.approved_by_user_id,
            approved_at=previous.approved_at,
            execution_note=previous.execution_note,
            execution_payload=LoopItemExecutionService._serialize_execution_intent(
                runtime_selection=dict(previous.runtime_selection),
                origin_context=dict(previous.runtime_origin_context),
            ),
        )

    def mark_dispatch_unknown(
        self,
        db: Session,
        *,
        execution_id: int,
        error: str,
    ) -> Optional[LoopItemExecution]:
        """Preserve capacity when Start may have succeeded but no proof arrived."""

        row = db.get(LoopItemExecution, execution_id)
        if row is None or row.status not in CAPACITY_STATUSES:
            return row
        updated = (
            db.query(LoopItemExecution)
            .filter(
                LoopItemExecution.id == execution_id,
                LoopItemExecution.version == row.version,
                LoopItemExecution.status.in_(CAPACITY_STATUSES),
            )
            .update(
                {
                    "sync_state": SYNC_STALE,
                    "error_message": self._error_text(error)[:2000],
                    "termination_reason": "start_confirmation_timeout",
                    "version": LoopItemExecution.version + 1,
                },
                synchronize_session=False,
            )
        )
        if updated != 1:
            db.rollback()
            return db.get(LoopItemExecution, execution_id)
        db.commit()
        db.expire_all()
        return db.get(LoopItemExecution, execution_id)

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
        observed_state: Optional[str] = None,
        observed_at: Optional[datetime] = None,
        event_seq: Optional[int] = None,
        termination_reason: Optional[str] = None,
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
        if observed_state is not None:
            values["observed_state"] = observed_state
            values["sync_state"] = SYNC_IN_SYNC
            values["observed_at"] = observed_at or now
        if event_seq is not None:
            values["last_event_seq"] = event_seq
        if termination_reason is not None:
            values["termination_reason"] = termination_reason
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
        if event_seq is not None:
            query = query.filter(LoopItemExecution.last_event_seq < event_seq)
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
        run_ids: Collection[str] | None = None,
        limit: int = 100,
    ) -> int:
        """Repair active automation runs backed by terminal executions."""

        from app.models.delivery import ProjectAutomationRun

        normalized_run_ids = (
            {str(run_id) for run_id in run_ids if str(run_id)}
            if run_ids is not None
            else None
        )
        if normalized_run_ids == set():
            return 0
        latest_query = db.query(
            LoopItemExecution.automation_run_id.label("automation_run_id"),
            func.max(LoopItemExecution.id).label("execution_id"),
        ).filter(LoopItemExecution.automation_run_id != "")
        if normalized_run_ids is not None:
            latest_query = latest_query.filter(
                LoopItemExecution.automation_run_id.in_(normalized_run_ids)
            )
        latest_executions = latest_query.group_by(
            LoopItemExecution.automation_run_id
        ).subquery()
        candidate_run_ids = [
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
        for run_id in candidate_run_ids:
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
                        from app.services.project_workflow_projection import (
                            sync_automation_workflow_node,
                        )

                        sync_automation_workflow_node(db, run)
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
                    from app.services.project_workflow_projection import (
                        sync_automation_workflow_node,
                    )

                    sync_automation_workflow_node(db, run)
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
                from app.services.project_workflow_projection import (
                    sync_automation_workflow_node,
                )

                sync_automation_workflow_node(db, run)
        return linked

    def _push_activity_after_commit(
        self, db: Session, activity: ProjectChatMessage | None
    ) -> None:
        """Broadcast a committed projection without weakening its durability."""

        if activity is None:
            return
        message_id = activity.message_id
        try:
            db.refresh(activity)
            from app.services.project_chat.service import project_chat_service

            payload = project_chat_service.to_view(activity).model_dump(by_alias=True)
            # ``refresh`` starts a read transaction. End it before publishing to
            # Redis so a slow transport cannot retain a SQL connection or locks.
            db.commit()
            self._push_activity(payload)
        except Exception:
            if db.in_transaction():
                db.rollback()
            logger.exception(
                "[LoopItemExecution] Committed activity push failed message=%s",
                message_id,
            )

    def push_linked_activity_after_commit(
        self, db: Session, *, execution: LoopItemExecution
    ) -> None:
        """Push the already-committed activity projection for an execution."""

        self._push_activity_after_commit(db, self._linked_activity(db, execution))

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
    def _push_activity(payload: dict[str, Any]) -> None:
        from app.services.project_chat.push import push_project_chat_message

        push_project_chat_message(payload)

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
        from app.services.project_workflow_projection import (
            sync_automation_workflow_node,
        )

        sync_automation_workflow_node(db, run)
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
        allow_unsequenced_terminal: bool = False,
    ) -> Optional[LoopItemExecution]:
        """Accept one ordered Runtime observation for the matching attempt."""

        row = self.execution_for_runtime(
            db,
            runtime_device_id=device_id,
            runtime_task_id=runtime_task_id,
        )
        if row is None:
            return None
        terminal = self._terminal_status(event_name, payload)
        raw_event_seq = payload.get("eventSeq", payload.get("event_seq"))
        if isinstance(raw_event_seq, bool):
            raw_event_seq = None
        try:
            parsed_event_seq = int(raw_event_seq)
        except (TypeError, ValueError):
            parsed_event_seq = 0
        event_seq = parsed_event_seq if parsed_event_seq > 0 else None
        if event_seq is None and not (
            allow_unsequenced_terminal and terminal is not None
        ):
            logger.warning(
                "[LoopItemExecution] Rejected Runtime event without sequence "
                "execution=%s task=%s event=%s",
                row.id,
                runtime_task_id,
                event_name,
            )
            return None
        if event_seq is not None and event_seq <= row.last_event_seq:
            logger.info(
                "[LoopItemExecution] Ignored duplicate or reordered Runtime event "
                "execution=%s current_seq=%s incoming_seq=%s event=%s",
                row.id,
                row.last_event_seq,
                event_seq,
                event_name,
            )
            return None
        if row.status in TERMINAL_STATUSES:
            logger.info(
                "[LoopItemExecution] Ignored Runtime event after terminal truth "
                "execution=%s status=%s incoming_seq=%s event=%s",
                row.id,
                row.status,
                event_seq,
                event_name,
            )
            return None
        now = utcnow()
        if terminal is not None:
            self.open_execution_activity(
                db,
                execution=row,
                commit=False,
                push=False,
            )
        if terminal == STATUS_COMPLETED:
            data = payload.get("data")
            data = data if isinstance(data, dict) else {}
            from app.services.project_chat.service import ProjectChatService

            return self.complete(
                db,
                execution_id=row.id,
                content=ProjectChatService._project_chat_final_text(data, payload),
                observed_at=now,
                event_seq=event_seq,
            )
        if terminal in {STATUS_FAILED, STATUS_CANCELLED}:
            data = payload.get("data")
            data = data if isinstance(data, dict) else {}
            error_value = payload.get("error") or data.get("error")
            if row.status == STATUS_CANCEL_REQUESTED:
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
                    expected_status=STATUS_CANCEL_REQUESTED,
                    expected_version=row.version,
                    observed_state=OBSERVED_CANCELLED,
                    observed_at=now,
                    event_seq=event_seq,
                    termination_reason="runtime_cancelled",
                )
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
                    expected_status=row.status,
                    expected_version=row.version,
                    observed_state=OBSERVED_CANCELLED,
                    observed_at=now,
                    event_seq=event_seq,
                    termination_reason="runtime_cancelled",
                )
            error_value = error_value or "Runtime task ended with failed"
            return self.fail(
                db,
                execution_id=row.id,
                error=self._error_text(error_value),
                requeue=True,
                expected_status=row.status,
                expected_version=row.version,
                observed_at=now,
                event_seq=event_seq,
                termination_reason="runtime_failed",
            )
        next_status = (
            STATUS_CANCEL_REQUESTED
            if row.status == STATUS_CANCEL_REQUESTED
            else STATUS_RUNNING
        )
        was_running = row.status == STATUS_RUNNING
        started_at = (
            row.started_at if not loop_datetime_value_is_unset(row.started_at) else now
        )
        updated = (
            db.query(LoopItemExecution)
            .filter(
                LoopItemExecution.id == row.id,
                LoopItemExecution.version == row.version,
                LoopItemExecution.status.in_(CAPACITY_STATUSES),
                LoopItemExecution.last_event_seq < event_seq,
            )
            .update(
                {
                    "status": next_status,
                    "observed_state": OBSERVED_RUNNING,
                    "sync_state": SYNC_IN_SYNC,
                    "error_message": "",
                    "termination_reason": "",
                    "observed_at": now,
                    "started_at": started_at,
                    "heartbeat_at": now,
                    "lease_expires_at": now + timedelta(seconds=lease_seconds),
                    "last_event_seq": event_seq,
                    "version": LoopItemExecution.version + 1,
                },
                synchronize_session=False,
            )
        )
        if updated != 1:
            db.rollback()
            return None
        db.expire_all()
        row = db.get(LoopItemExecution, row.id)
        if row is None:
            db.rollback()
            return None
        self._set_automation_run_status(db, row, "running")
        task = db.get(LoopItem, row.loop_item_id)
        task_projection_is_stale = (
            row.executor_type != "automation_manager"
            and task is not None
            and task.status not in {"in_progress", "in_review", "completed"}
        )
        if not was_running or task_projection_is_stale:
            self.open_execution_activity(
                db,
                execution=row,
                commit=False,
                push=False,
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
            created_by_user_id=item.created_by_user_id or None,
        )

    def build_runtime_payload(
        self,
        db: Session,
        *,
        execution: LoopItemExecution,
    ) -> dict[str, Any]:
        """Build the payload exposed to the selected legacy transport."""

        return self._build_runtime_payload(
            db,
            execution=execution,
            execution_target_id=None,
        )

    def build_executor_runtime_payload(
        self,
        db: Session,
        *,
        execution: LoopItemExecution,
        execution_target_id: str,
        executor_device_id: str,
    ) -> dict[str, Any]:
        """Materialize a complete payload for an Executor-owned pull."""

        return self._build_runtime_payload(
            db,
            execution=execution,
            execution_target_id=execution_target_id,
            executor_device_id=executor_device_id,
        )

    def _build_runtime_payload(
        self,
        db: Session,
        *,
        execution: LoopItemExecution,
        execution_target_id: Optional[str],
        executor_device_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """Build either an App intent or a materialized Executor payload."""

        try:
            request = (
                RuntimeTaskCreateRequest.model_validate(execution.runtime_request)
                if execution.runtime_request
                else self._persist_runtime_request_intent(
                    db,
                    execution=execution,
                )
            )
            if execution_target_id:
                if request.device_id != execution_target_id:
                    raise WeworkExecutionProfileError(
                        "Execution request target does not match the claimed queue"
                    )
                workspace_source_task = request.workspace_source_task
                if (
                    workspace_source_task is not None
                    and workspace_source_task.device_id != execution_target_id
                ):
                    raise WeworkExecutionProfileError(
                        "Inherited workflow workspace belongs to a different "
                        "execution target"
                    )
                if not executor_device_id:
                    raise WeworkExecutionProfileError(
                        "Executor device identity is required"
                    )
                request = request.model_copy(
                    update={"device_id": executor_device_id},
                )
            elif execution.execution_environment == "local":
                return request.model_dump(by_alias=True, exclude_none=True)
            from app.services.runtime_work_service import compile_runtime_task_create

            compiled = compile_runtime_task_create(
                db=db,
                user_id=execution.executor_owner_user_id,
                request=request,
            )
            execution_request = compiled.payload.get("executionRequest")
            model_config = (
                execution_request.get("model_config")
                if isinstance(execution_request, dict)
                else None
            )
            logger.info(
                "[RuntimeV2] Compiled execution payload: execution_id=%s task_id=%s "
                "target_device_id=%s selected_model=%s selected_model_type=%s "
                "upstream_model=%s upstream_protocol=%s upstream_endpoint=%s "
                "upstream_auth_present=%s upstream_default_headers=%s",
                execution.id,
                request.local_task_id,
                compiled.target.device_id,
                compiled.payload.get("modelId"),
                compiled.payload.get("modelType"),
                (
                    model_config.get("model_id") or model_config.get("model")
                    if isinstance(model_config, dict)
                    else None
                ),
                (
                    model_config.get("protocol") or model_config.get("api_format")
                    if isinstance(model_config, dict)
                    else None
                ),
                (
                    _safe_model_endpoint(
                        model_config.get("request_url")
                        or model_config.get("responses_url")
                        or model_config.get("base_url")
                    )
                    if isinstance(model_config, dict)
                    else ""
                ),
                (
                    bool(
                        model_config.get("api_key")
                        or model_config.get("apiKey")
                        or model_config.get("auth_token")
                    )
                    if isinstance(model_config, dict)
                    else False
                ),
                (
                    len(model_config.get("default_headers") or {})
                    if isinstance(model_config, dict)
                    and isinstance(model_config.get("default_headers"), dict)
                    else 0
                ),
            )
            return compiled.payload
        except HTTPException as exc:
            raise WeworkRuntimeConfigurationError(str(exc.detail)) from exc
        except WeworkExecutionProfileError as exc:
            raise WeworkRuntimeConfigurationError(str(exc)) from exc
        except Exception as exc:
            model_label = str(execution.runtime_selection.get("model") or "")
            model_label = model_label or "the selected runtime default"
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
            runtime_profile = self._execution_runtime_profile(db, execution)
            owner_user_id = int(
                runtime_profile.user_id
                if runtime_profile is not None
                else agent.created_by_user_id or 0
            )
            if owner_user_id != execution.executor_owner_user_id:
                raise WeworkRuntimeConfigurationError(
                    "Selected Runtime owner no longer matches the queued execution"
                )
            if run is not None and rule is not None:
                # Automation only decides who receives the task. Once a
                # project robot is assigned it must execute through the same
                # role + live task-context contract as an ordinary assignment;
                # the manager's scheduling prompt is not an execution prompt.
                origin_context = self._automation_runtime_context(run, rule)
            else:
                origin_context = dict(execution.runtime_origin_context)
                if not origin_context:
                    origin_context, _ = self._task_automation_context(
                        db, execution.loop_item_id
                    )
            origin_context = self._selection_context(execution, origin_context)
            return (
                WeworkExecutionProfile.for_project_robot(
                    agent,
                    db=db,
                    runtime_profile=runtime_profile,
                    cloud_project_id=execution.cloud_project_id,
                    model_override=str(origin_context.get("model") or ""),
                    model_type_override=origin_context.get("model_type"),
                    model_options_override=origin_context.get("model_options"),
                    workspace_binding_override=origin_context.get("workspace_binding"),
                ),
                origin_context,
            )

        if execution.executor_type == "generic_robot":
            if run is None:
                raise WeworkRuntimeConfigurationError(
                    "Generic workflow execution has no automation run"
                )
            runtime_profile = self._execution_runtime_profile(db, execution)
            if runtime_profile is not None and (
                int(runtime_profile.user_id or 0) != execution.executor_owner_user_id
            ):
                raise WeworkRuntimeConfigurationError(
                    "Selected Runtime owner no longer matches the queued execution"
                )
            binding = (
                db.query(CloudProjectLocalBinding)
                .filter(
                    CloudProjectLocalBinding.cloud_project_id
                    == execution.cloud_project_id,
                    CloudProjectLocalBinding.user_id
                    == execution.executor_owner_user_id,
                    CloudProjectLocalBinding.device_id == execution.execution_device_id,
                    CloudProjectLocalBinding.status == "active",
                    loop_datetime_is_unset(CloudProjectLocalBinding.deleted_at),
                )
                .order_by(CloudProjectLocalBinding.updated_at.desc())
                .first()
            )
            run_metadata = (
                run.metadata_json if isinstance(run.metadata_json, dict) else {}
            )
            origin_context = self._selection_context(
                execution,
                self._automation_runtime_context(run, rule),
            )
            return (
                WeworkExecutionProfile.for_generic_robot(
                    runtime_profile=runtime_profile,
                    owner_user_id=execution.executor_owner_user_id,
                    display_name=(
                        rule.title
                        if rule is not None and rule.title
                        else str(run_metadata.get("workflow_node_name") or "AI")
                    ),
                    execution_prompt=(
                        rule.description
                        if rule is not None and rule.description
                        else str(run_metadata.get("instruction_override") or "")
                    ),
                    model_override=str(origin_context.get("model") or ""),
                    model_type_override=origin_context.get("model_type"),
                    model_options_override=origin_context.get("model_options"),
                    local_project_id=(
                        int(binding.local_project_id or 0) if binding else 0
                    ),
                    workspace_binding_override=origin_context.get("workspace_binding"),
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
        runtime_profile = self._execution_runtime_profile(db, execution)
        owner_user_id = int(
            runtime_profile.user_id
            if runtime_profile is not None
            else getattr(rule, "created_by_user_id", 0) or 0
        )
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
        profile_metadata = (
            dict(runtime_profile.metadata_json or {}) if runtime_profile else {}
        )
        selection = execution.runtime_selection
        model = selection.get("model") or profile_metadata.get("model")
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
                model_type=(
                    selection.get("model_type") or profile_metadata.get("model_type")
                ),
                model_options=dict(
                    selection.get("model_options")
                    or profile_metadata.get("model_options")
                    or {}
                ),
            ),
            self._selection_context(
                execution,
                self._automation_runtime_context(run, rule),
            ),
        )

    @staticmethod
    def _selection_context(
        execution: LoopItemExecution,
        context: dict[str, Any],
    ) -> dict[str, Any]:
        """Overlay the persisted selection on origin metadata exactly once."""

        selection = execution.runtime_selection
        merged = dict(execution.runtime_origin_context or context)
        for key in ("model", "model_type", "model_options"):
            if key in selection:
                merged[key] = selection[key]
        return merged

    @staticmethod
    def _execution_runtime_profile(
        db: Session, execution: LoopItemExecution
    ) -> RuntimeProfile | None:
        profile_id = execution.runtime_selection.get("runtime_profile_id")
        if not isinstance(profile_id, str) or not profile_id:
            return None
        profile = db.get(RuntimeProfile, profile_id)
        if profile is None or profile.status != "active":
            raise WeworkRuntimeConfigurationError(
                "Selected Runtime profile is unavailable"
            )
        return profile

    @staticmethod
    def _automation_runtime_context(run: Any, rule: Any) -> dict[str, Any]:
        run_metadata = getattr(run, "metadata_json", None)
        run_metadata = run_metadata if isinstance(run_metadata, dict) else {}
        workflow_config = run_metadata.get("workflow_execution_config")
        workflow_config = workflow_config if isinstance(workflow_config, dict) else {}
        workspace_binding = workflow_config.get("workspaceBinding")
        if not isinstance(workspace_binding, dict):
            workspace_binding = workflow_config.get("workspace_binding")
        context = {
            "rule_id": str(getattr(rule, "id", "") or ""),
            "run_id": str(getattr(run, "id", "") or ""),
            "trigger": run_metadata.get("trigger") or getattr(run, "source", None),
            "scheduled_for": run_metadata.get("scheduled_for"),
            "event": run_metadata.get("event") or {},
            "workflow_stage_input": run_metadata.get("workflow_stage_input"),
            "model": workflow_config.get("model"),
            "model_type": (
                workflow_config.get("modelType") or workflow_config.get("model_type")
            ),
            "model_options": (
                workflow_config.get("modelOptions")
                or workflow_config.get("model_options")
                or {}
            ),
            "execution_device_id": (
                workflow_config.get("executionDeviceId")
                or workflow_config.get("execution_device_id")
            ),
            "workspace_binding": workspace_binding,
        }
        if workflow_config:
            from app.schemas.issue_workflow import WorkflowExecutionConfig

            config = WorkflowExecutionConfig.model_validate(workflow_config)
            context.update(config.runtime_request_options())
        return context

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
        viewer_user_id: int,
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
        limits = _agent_limits(
            db, {execution.agent_id for execution in rows if execution.agent_id}
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
                "team_id": execution.optional_team_id,
                "backend_task_id": execution.optional_backend_task_id,
                "automation_run_id": execution.automation_run_id,
                "assigner_user_id": execution.assigner_user_id,
                "execution_environment": execution.execution_environment,
                "execution_device_id": _optional_text(execution.execution_device_id),
                "runtime_instance_id": _optional_text(execution.runtime_instance_id),
                "status": execution.status,
                "display_state": execution_display_state(execution),
                "observed_state": execution.observed_state,
                "sync_state": execution.sync_state,
                "priority_weight": execution.priority_weight,
                "queued_at": _optional_datetime(execution.queued_at),
                "started_at": _optional_datetime(execution.started_at),
                "completed_at": _optional_datetime(execution.completed_at),
                "lease_expires_at": _optional_datetime(execution.lease_expires_at),
                "heartbeat_at": _optional_datetime(execution.heartbeat_at),
                "claimed_at": _optional_datetime(execution.claimed_at),
                "start_requested_at": _optional_datetime(execution.start_requested_at),
                "observed_at": _optional_datetime(execution.observed_at),
                "cancel_requested_at": _optional_datetime(
                    execution.cancel_requested_at
                ),
                "attempt_no": execution.attempt_no,
                "previous_execution_id": _optional_user_id(
                    execution.previous_execution_id
                ),
                "execution_scope": execution.execution_scope,
                "last_event_seq": execution.last_event_seq,
                "termination_reason": execution.termination_reason,
                "retry_attempt": execution.retry_attempt,
                "error_message": execution.error_message,
                "execution_note": execution.execution_note,
                "approval_status": _optional_text(execution.approval_status),
                "approved_by_user_id": _optional_user_id(execution.approved_by_user_id),
                "rejected_reason": _optional_text(execution.rejected_reason),
                "runtime_device_id": _optional_text(execution.runtime_device_id),
                "runtime_task_id": _optional_text(execution.runtime_task_id),
                "agent_max_concurrent_executions": limits.get(execution.agent_id, 1),
                "runtime_profile_id": execution.runtime_selection.get(
                    "runtime_profile_id"
                ),
                "runtime_source": execution.runtime_selection.get("runtime_source"),
                "can_select_runtime": (
                    execution.executor_owner_user_id == viewer_user_id
                    and execution.status in {"waiting_runtime", "queued"}
                ),
                "waiting_runtime_reason": (
                    execution.execution_note
                    if execution.status == "waiting_runtime"
                    else None
                ),
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
        """Release provably unstarted claims and flag delivered starts stale.

        A lease is transport liveness, not process liveness. Once Start may
        have been delivered this scan must preserve the slot until a Runtime
        event, cancel ACK, or status query establishes the real outcome.
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
                LoopItemExecution.status.in_(CAPACITY_STATUSES),
                ~loop_datetime_is_unset(LoopItemExecution.lease_expires_at),
                LoopItemExecution.lease_expires_at < stale_threshold,
            )
            .all()
        )
        requeued = 0
        unknown = 0
        for row in stale_rows:
            logger.warning(
                "[LoopItemExecutions] Recovering stale run execution=%s task=%s "
                "status=%s lease_expires_at=%s",
                row.id,
                row.loop_item_id,
                row.status,
                row.lease_expires_at,
            )
            if row.status == STATUS_CLAIMED and loop_datetime_value_is_unset(
                row.start_requested_at
            ):
                self.fail(
                    db,
                    execution_id=row.id,
                    error="Claim lease expired before Runtime dispatch",
                    note="claim_lease_expired_before_start",
                    requeue_infra=True,
                )
                requeued += 1
            else:
                self.mark_dispatch_unknown(
                    db,
                    execution_id=row.id,
                    error="Runtime state must be reconciled after lease expiry",
                )
                unknown += 1
        return requeued, unknown

    def stale_for_reconciliation(
        self, db: Session, *, limit: int = 100
    ) -> list[LoopItemExecution]:
        """Return attempts whose Runtime truth must be queried."""

        return (
            db.query(LoopItemExecution)
            .filter(
                LoopItemExecution.status.in_(CAPACITY_STATUSES),
                LoopItemExecution.sync_state == SYNC_STALE,
                LoopItemExecution.runtime_device_id != "",
                LoopItemExecution.runtime_task_id != "",
            )
            .order_by(LoopItemExecution.observed_at.asc(), LoopItemExecution.id.asc())
            .limit(limit)
            .all()
        )

    def active_for_device_reconciliation(
        self,
        db: Session,
        *,
        owner_user_id: int,
        runtime_device_id: str,
        needs_confirmation_only: bool = False,
        limit: int = 100,
    ) -> list[LoopItemExecution]:
        """Return active attempts to reconcile when their device reconnects."""

        query = db.query(LoopItemExecution).filter(
            LoopItemExecution.executor_owner_user_id == owner_user_id,
            LoopItemExecution.runtime_device_id == runtime_device_id,
            LoopItemExecution.runtime_task_id != "",
            LoopItemExecution.status.in_(CAPACITY_STATUSES),
        )
        if needs_confirmation_only:
            query = query.filter(
                or_(
                    LoopItemExecution.sync_state == SYNC_STALE,
                    and_(
                        LoopItemExecution.status == STATUS_CLAIMED,
                        LoopItemExecution.observed_state == OBSERVED_ACCEPTED,
                    ),
                )
            )
        return query.order_by(LoopItemExecution.id.asc()).limit(limit).all()

    def reconcile_runtime_snapshot(
        self,
        db: Session,
        *,
        execution_id: int,
        runtime_status: str,
        running: bool,
        turn_status: Optional[str] = None,
    ) -> Optional[LoopItemExecution]:
        """Apply a trusted snapshot and restore its missing activity projection."""

        row = db.get(LoopItemExecution, execution_id)
        if row is None or row.status not in CAPACITY_STATUSES:
            return row
        normalized = runtime_status.lower().strip()
        normalized_turn = (turn_status or "").lower().strip()
        if normalized == "missing" and row.status == STATUS_CANCEL_REQUESTED:
            self.open_execution_activity(
                db,
                execution=row,
                commit=False,
                push=False,
            )
            return self.confirm_runtime_cancelled(
                db,
                execution_id=row.id,
                note="Runtime no longer reports the cancelled task",
            )
        if (
            normalized == "missing"
            and row.status == STATUS_CLAIMED
            and row.observed_state == OBSERVED_UNCONFIRMED
            and row.termination_reason == "start_confirmation_timeout"
            and not loop_datetime_value_is_unset(row.start_requested_at)
        ):
            self.open_execution_activity(
                db,
                execution=row,
                commit=False,
                push=False,
            )
            return self.fail(
                db,
                execution_id=row.id,
                error=(
                    "Runtime confirmed that the task does not exist after "
                    "start confirmation timed out"
                ),
                note="Runtime task was missing after an unconfirmed start",
                requeue_infra=True,
                expected_status=STATUS_CLAIMED,
                expected_version=row.version,
            )
        if running or normalized in {"running", "in_progress"}:
            now = utcnow()
            next_status = (
                STATUS_CANCEL_REQUESTED
                if row.status == STATUS_CANCEL_REQUESTED
                else STATUS_RUNNING
            )
            row.status = next_status
            row.observed_state = OBSERVED_RUNNING
            row.sync_state = SYNC_IN_SYNC
            row.error_message = ""
            row.termination_reason = ""
            row.observed_at = now
            if loop_datetime_value_is_unset(row.started_at):
                row.started_at = now
            row.version += 1
            self._set_automation_run_status(db, row, "running")
            db.flush()
            self.open_execution_activity(
                db,
                execution=row,
                commit=False,
                push=False,
            )
            db.commit()
            db.refresh(row)
            self.push_linked_activity_after_commit(db, execution=row)
            return row
        terminal_observations = {normalized, normalized_turn}
        if terminal_observations & {"failed", "error"}:
            terminal = STATUS_FAILED
        elif terminal_observations & {
            "cancelled",
            "canceled",
            "interrupted",
            "aborted",
        }:
            terminal = STATUS_CANCELLED
        elif terminal_observations & {"completed", "succeeded"}:
            terminal = STATUS_COMPLETED
        else:
            terminal = None
        if terminal == STATUS_COMPLETED:
            self.open_execution_activity(
                db,
                execution=row,
                commit=False,
                push=False,
            )
            return self.complete(
                db,
                execution_id=row.id,
                note="Runtime reconciled",
                expected_status=row.status,
                expected_version=row.version,
            )
        if terminal == STATUS_FAILED:
            self.open_execution_activity(
                db,
                execution=row,
                commit=False,
                push=False,
            )
            return self.fail(
                db,
                execution_id=row.id,
                error="Runtime reported a failed task during reconciliation",
                requeue=True,
                expected_status=row.status,
                expected_version=row.version,
                termination_reason="runtime_reconciled_failed",
            )
        if terminal == STATUS_CANCELLED:
            self.open_execution_activity(
                db,
                execution=row,
                commit=False,
                push=False,
            )
            return self._transition_terminal(
                db,
                execution_id=row.id,
                terminal_status=STATUS_CANCELLED,
                note="Runtime reconciled cancellation",
                content="AI execution was cancelled.",
                observed_state=OBSERVED_CANCELLED,
                observed_at=utcnow(),
                expected_status=row.status,
                expected_version=row.version,
                termination_reason="runtime_reconciled_cancelled",
            )
        if normalized in {"accepted", "active", "pending", "queued", "starting"}:
            now = utcnow()
            row.observed_state = OBSERVED_ACCEPTED
            row.sync_state = SYNC_IN_SYNC
            row.error_message = ""
            row.termination_reason = ""
            row.observed_at = now
            row.heartbeat_at = now
            row.lease_expires_at = now + timedelta(seconds=DEFAULT_LEASE_SECONDS)
            row.version += 1
            db.flush()
            self.open_execution_activity(
                db,
                execution=row,
                commit=False,
                push=False,
            )
            db.commit()
            db.refresh(row)
            self.push_linked_activity_after_commit(db, execution=row)
            return row
        row.sync_state = SYNC_DIVERGED
        row.error_message = (
            f"Runtime returned unrecognized status '{runtime_status or 'missing'}'"
        )[:2000]
        row.version += 1
        db.flush()
        self.open_execution_activity(
            db,
            execution=row,
            commit=False,
            push=False,
        )
        db.commit()
        db.refresh(row)
        self.push_linked_activity_after_commit(db, execution=row)
        return row

    def stall_scan(
        self,
        db: Session,
        *,
        now: Optional[datetime] = None,
        text_timeout_seconds: int = DEFAULT_STALL_TEXT_TIMEOUT_SECONDS,
    ) -> list[LoopItemExecution]:
        """Request cancellation for runs with no AI text for a long time.

        Lease renewal keeps event-flowing runs alive forever, which includes
        runaway tool loops that never emit assistant text. A delivered run is
        never terminalized from this timeout alone: it remains capacity-holding
        in ``cancel_requested`` until Runtime acknowledges the stop. Returns
        the cancellation intents so callers can emit the Runtime RPC.
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
            requested = self.cancel(
                db,
                execution_id=execution.id,
                note=(
                    f"AI 执行超过 {text_timeout_seconds // 60} 分钟未产生任何输出，"
                    "已自动停止（疑似卡死）"
                ),
            )
            stalled.append(requested)
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
