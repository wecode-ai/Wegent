# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Celery tasks for the project robot queue cloud dispatcher.

The queue is a derived view over `loop_item_executions`. This dispatcher drains
cloud robot runs: it recovers stale leases, then for every bound cloud device
with queued runs it acquires the per-device lock, checks the device is online,
claims one run at a time up to the device capacity, and starts the run on the
device through the same runtime RPC channel the App uses.
"""

import asyncio
import logging
import os
from typing import Optional

import celery.signals
from prometheus_client import Counter, Gauge
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.core.celery_app import celery_app
from app.core.config import settings
from app.core.distributed_lock import distributed_lock
from app.models.delivery import ProjectChatAgent
from app.models.loop_item_execution import LoopItemExecution
from app.models.user import User
from app.services.device_service import device_service
from app.services.loop_item_executions.service import (
    loop_item_execution_service,
)

logger = logging.getLogger(__name__)

ROBOT_QUEUE_SCAN_LOCK_TIMEOUT = 120
ROBOT_DEVICE_LOCK_TIMEOUT = 120
DISPATCH_START_TIMEOUT_SECONDS = 30
RUN_EVENT_CHANNEL = "wegent:robot-run-events"

ROBOT_QUEUE_DISPATCHED_TOTAL = Counter(
    "robot_queue_dispatched_total",
    "Total robot queue runs dispatched to cloud devices",
)
ROBOT_QUEUE_RECOVERED_TOTAL = Counter(
    "robot_queue_recovered_total",
    "Robot queue runs recovered by lease expiry",
    ["action"],
)
ROBOT_QUEUE_DEPTH = Gauge(
    "robot_queue_depth",
    "Number of queued robot runs",
)
ROBOT_QUEUE_RUNNING = Gauge(
    "robot_queue_running",
    "Number of running robot runs",
)
ROBOT_QUEUE_FAILED_TOTAL = Counter(
    "robot_queue_failed_total",
    "Robot queue runs marked failed",
)
ROBOT_QUEUE_INFRA_FAILED_TOTAL = Counter(
    "robot_queue_infra_failed_total",
    "Robot queue runs requeued after transient device/transport failures",
    ["reason"],
)

ROBOT_CONSUMER_INTERVAL_SECONDS = 1.0
ROBOT_CONSUMER_BACKOFF_MAX_SECONDS = 10.0
ROBOT_CONSUMER_BATCH_SIZE = 16


class RobotQueueInfraError(RuntimeError):
    """Device/transport dispatch failure that must not consume run retries.

    The run is requeued without incrementing ``retry_attempt`` so the next
    scan can dispatch it once the device is reachable again.
    """


class DeviceOfflineError(RobotQueueInfraError):
    """No online key for the resolved routing user and device."""


class DeviceEmitRejectedError(RobotQueueInfraError):
    """The internal runtime RPC emit could not be delivered to the device."""


class ExecutorSessionStartError(RobotQueueInfraError):
    """The device accepted the RPC but no codex session started in time."""


def _infra_reason(exc: BaseException) -> str:
    """Stable machine-readable reason for a transient dispatch failure."""

    if isinstance(exc, DeviceOfflineError):
        return "device_offline"
    if isinstance(exc, DeviceEmitRejectedError):
        return "device_emit_rejected"
    if isinstance(exc, ExecutorSessionStartError):
        return "executor_session_start_timeout"
    return "device_infra"


def _fail_dispatch(
    db: Session, execution: LoopItemExecution, exc: BaseException
) -> None:
    """Record one failed dispatch.

    Transient device/transport failures requeue the run without consuming
    retries; real execution errors keep the existing requeue-until-retries
    semantics.
    """

    if isinstance(exc, RobotQueueInfraError):
        reason = _infra_reason(exc)
        logger.warning(
            "[RobotQueue] Dispatch infra failure execution=%s device=%s reason=%s "
            "error=%s",
            execution.id,
            execution.execution_device_id,
            reason,
            str(exc)[:300],
        )
        loop_item_execution_service.fail(
            db,
            execution_id=execution.id,
            error=str(exc)[:2000],
            note=reason,
            requeue_infra=True,
        )
        ROBOT_QUEUE_INFRA_FAILED_TOTAL.labels(reason=reason).inc()
        return
    logger.exception(
        "[RobotQueue] Dispatch failed execution=%s device=%s",
        execution.id,
        execution.execution_device_id,
    )
    loop_item_execution_service.fail(
        db,
        execution_id=execution.id,
        error=str(exc)[:2000],
        requeue=True,
    )
    ROBOT_QUEUE_FAILED_TOTAL.inc()


# The Socket.IO server is a process singleton bound to the event loop that
# first created it. Celery runs each task on a fresh loop via asyncio.run, so
# reuse ONE loop for all queue dispatch to keep the singleton consistent.
_ROBOT_QUEUE_LOOP: Optional[asyncio.AbstractEventLoop] = None


def _robot_queue_loop() -> asyncio.AbstractEventLoop:
    global _ROBOT_QUEUE_LOOP
    if _ROBOT_QUEUE_LOOP is None or _ROBOT_QUEUE_LOOP.is_closed():
        _ROBOT_QUEUE_LOOP = asyncio.new_event_loop()
        # Celery prefork children inherit the Socket.IO singleton bound to the
        # parent's (dead) event loop; only those separate processes must rebind
        # it to the task loop. Embedded celery threads share the live uvicorn
        # singleton, and resetting it here would orphan every connected device
        # (their acks would never reach the recreated server).
        if os.environ.get("FORKED_BY_MULTIPROCESSING"):
            import app.core.socketio as socketio_module

            socketio_module._sio_instance = None
    return _ROBOT_QUEUE_LOOP


@celery_app.task(bind=True, name="app.tasks.robot_queue_tasks.scan_robot_queue")
def scan_robot_queue(self) -> dict:
    """Periodically drain robot queues (local and cloud) with capacity gating."""

    if not settings.ROBOT_QUEUE_SCHEDULER_ENABLED:
        return {"status": "skipped", "reason": "scheduler_disabled"}
    from app.db.session import get_db_session

    with distributed_lock.acquire_context(
        "scan_robot_queue", expire_seconds=ROBOT_QUEUE_SCAN_LOCK_TIMEOUT
    ) as acquired:
        if not acquired:
            return {"status": "skipped", "reason": "lock_held_by_another_instance"}
        with get_db_session() as db:
            try:
                from app.services.project_workflows import project_workflow_service

                automation_runs = project_workflow_service.run_due_automations(db)
                requeued, failed = loop_item_execution_service.recovery_scan(db)
                ROBOT_QUEUE_RECOVERED_TOTAL.labels(action="requeued").inc(requeued)
                ROBOT_QUEUE_RECOVERED_TOTAL.labels(action="failed").inc(failed)
                stalled = loop_item_execution_service.stall_scan(db)
                if stalled:
                    logger.warning(
                        "[RobotQueue] Stall scan stopped %s run(s) with no AI output: %s",
                        len(stalled),
                        [
                            f"execution={run.id} task={run.loop_item_id}"
                            for run in stalled
                        ],
                    )
                    emit_runtime_cancels(stalled)
                dispatched = _robot_queue_loop().run_until_complete(
                    _dispatch_queued_executions(db)
                )
                cleaned_resources = _robot_queue_loop().run_until_complete(
                    _cleanup_completed_workflow_resources(db)
                )
                from sqlalchemy import func, select

                ROBOT_QUEUE_DEPTH.set(
                    db.scalar(
                        select(func.count(LoopItemExecution.id)).where(
                            LoopItemExecution.status == "queued"
                        )
                    )
                    or 0
                )
                ROBOT_QUEUE_RUNNING.set(
                    db.scalar(
                        select(func.count(LoopItemExecution.id)).where(
                            LoopItemExecution.status == "running"
                        )
                    )
                    or 0
                )
                return {
                    "status": "ok",
                    "automation_runs": automation_runs,
                    "dispatched": dispatched,
                    "cleaned_resources": cleaned_resources,
                    "requeued": requeued,
                    "failed": failed,
                }
            except Exception:
                logger.exception("[RobotQueue] scan_robot_queue failed")
                raise


@celery_app.task(
    bind=True,
    name="app.tasks.robot_queue_tasks.execute_robot_task",
    max_retries=0,
)
def execute_robot_task(self, execution_id: int) -> dict:
    """Run one claimed cloud/local execution on its bound device.

    The consumer loop only claims (queued -> claimed) and hands the work here;
    this subtask advances claimed -> running, performs the runtime RPC and
    writes back. A run that was reclaimed by the lease watchdog in between is
    skipped instead of double-executed.
    """

    from app.db.session import get_db_session

    with get_db_session() as db:
        execution = db.get(LoopItemExecution, execution_id)
        if execution is None:
            return {"status": "missing", "execution_id": execution_id}
        advanced = loop_item_execution_service.mark_running(
            db, execution_ids=[execution_id]
        )
        if advanced != 1:
            return {
                "status": "skipped",
                "reason": "execution is no longer claimed",
                "execution_id": execution_id,
            }
        # mark_running updates the row out-of-band; refresh so heartbeat and
        # dispatch observe the running state instead of the stale claim.
        db.expire_all()
        execution = db.get(LoopItemExecution, execution_id)
        try:
            _robot_queue_loop().run_until_complete(_dispatch_execution(db, execution))
            ROBOT_QUEUE_DISPATCHED_TOTAL.inc()
            return {"status": "dispatched", "execution_id": execution_id}
        except Exception as exc:
            _fail_dispatch(db, execution, exc)
            if isinstance(exc, RobotQueueInfraError):
                return {
                    "status": "requeued",
                    "reason": _infra_reason(exc),
                    "execution_id": execution_id,
                }
            return {"status": "failed", "execution_id": execution_id}


def _queued_devices(db: Session) -> list[tuple[str, str]]:
    """Distinct bound devices with queued/claimed runs, both environments."""

    from sqlalchemy import select

    rows = db.execute(
        select(
            LoopItemExecution.execution_device_id,
            LoopItemExecution.execution_environment,
        )
        .where(
            LoopItemExecution.status.in_(["queued", "claimed"]),
            LoopItemExecution.execution_target_type == "registered_device",
            LoopItemExecution.execution_device_id.is_not(None),
            LoopItemExecution.execution_device_id != "",
        )
        .distinct()
    ).all()
    return [(str(row[0]), str(row[1])) for row in rows if row[0]]


def _device_owner_user_id(
    db: Session,
    device_id: str,
    preferred_user_id: Optional[int] = None,
    fallback_to_any: bool = True,
) -> Optional[int]:
    """Resolve the user who owns a device.

    The executor's device socket registers under the user who owns the device
    (its online key is ``device:online:{owner}:{device_id}``), which may
    differ from the robot creator in mixed dev environments. When a preferred
    user is given (the robot creator), their own Device row wins so robots
    bound to a same-named device such as "local-device" stay on the creator's
    device instead of an arbitrary shared owner.
    """

    from app.models.kind import Kind

    query = db.query(Kind).filter(
        Kind.kind == "Device",
        Kind.name == device_id,
        Kind.is_active == True,
    )
    if preferred_user_id is not None:
        row = query.filter(Kind.user_id == preferred_user_id).first()
        if row and row.user_id:
            return row.user_id
        if not fallback_to_any:
            return None
    row = query.first()
    return row.user_id if row and row.user_id else None


def _resolve_routing_user_ids(
    db: Session,
    device_id: str,
    creator_id: Optional[int],
    environment: str,
) -> list[int]:
    """Candidate routing users for one bound device, best owner first.

    Local/app robots must run on the creator's own device: a generic device id
    such as "local-device" can be registered by many users in shared
    environments, so the creator-scoped Device row is resolved first and no
    stranger's same-named device is ever used. Cloud devices have unique ids,
    so their recorded owner is preferred and the creator remains a fallback.
    """

    candidates: list[int] = []
    if environment == "cloud":
        owner = _device_owner_user_id(db, device_id)
        if owner:
            candidates.append(owner)
        if creator_id and creator_id not in candidates:
            candidates.append(creator_id)
        return candidates
    if creator_id:
        creator_owner = _device_owner_user_id(
            db,
            device_id,
            preferred_user_id=creator_id,
            fallback_to_any=False,
        )
        if creator_owner:
            candidates.append(creator_owner)
        if creator_id not in candidates:
            candidates.append(creator_id)
    return candidates


def _execution_initiator(
    db: Session,
    execution: LoopItemExecution,
) -> Optional[User]:
    """Resolve the user who started a legacy assignment or workflow stage."""

    if execution.assigner_user_id:
        user = db.get(User, execution.assigner_user_id)
        if user is not None:
            return user
    if execution.agent_id:
        agent = db.get(ProjectChatAgent, execution.agent_id)
        if agent and agent.created_by_user_id:
            return db.get(User, agent.created_by_user_id)
    return None


async def _routing_user_for_device(
    db: Session, device_id: str, environment: str
) -> Optional[int]:
    """Return an online user that can route RPCs to this device."""

    sample = (
        db.query(LoopItemExecution)
        .filter(
            LoopItemExecution.execution_device_id == device_id,
            LoopItemExecution.status.in_(["queued", "claimed"]),
        )
        .first()
    )
    if sample is None:
        return None
    sample_creator = _execution_initiator(db, sample)
    candidate_users = _resolve_routing_user_ids(
        db,
        device_id,
        sample_creator.id if sample_creator else None,
        environment,
    )
    for candidate in candidate_users:
        if await _device_online(candidate, device_id):
            return candidate
    return None


async def _dispatch_queued_executions(db: Session) -> int:
    """Dispatch queued robot runs to their bound devices.

    Local and cloud devices are the same kind of executor, so every run is
    claimed by the backend and pushed over the device WebSocket with the same
    `runtime.tasks.create` RPC the App uses to submit codex tasks. The payload
    carries the complete model configuration (same as an App send), so devices
    do not need an App to start a run. Offline devices stay queued and are
    retried on the next scan.
    """

    dispatched = await _dispatch_managed_container_executions(db)
    for device_id, environment in _queued_devices(db):
        with distributed_lock.acquire_context(
            f"robot_exec:{device_id}",
            expire_seconds=ROBOT_DEVICE_LOCK_TIMEOUT,
        ) as device_acquired:
            if not device_acquired:
                logger.info(
                    "[RobotQueue] Queued run not dispatched: device lock busy "
                    "device=%s environment=%s",
                    device_id,
                    environment,
                )
                continue
            sample = (
                db.query(LoopItemExecution)
                .filter(
                    LoopItemExecution.execution_device_id == device_id,
                    LoopItemExecution.execution_environment == environment,
                    LoopItemExecution.status == "queued",
                )
                .first()
            )
            if sample is None:
                continue
            sample_creator = _execution_initiator(db, sample)
            candidate_users = _resolve_routing_user_ids(
                db,
                device_id,
                sample_creator.id if sample_creator else None,
                environment,
            )
            routing_user_id = None
            for candidate in candidate_users:
                if await _device_online(candidate, device_id):
                    routing_user_id = candidate
                    break
            if routing_user_id is None:
                # Leave runs queued; no identity with this device is online.
                logger.info(
                    "[RobotQueue] Queued run not dispatched: no online device owner "
                    "for device=%s environment=%s sample_execution=%s",
                    device_id,
                    environment,
                    sample.id,
                )
                continue
            logger.info(
                "[RobotQueue] Dispatch route resolved device=%s environment=%s "
                "routing_user=%s sample_execution=%s",
                device_id,
                environment,
                routing_user_id,
                sample.id,
            )
            capacity = (
                settings.ROBOT_CLOUD_DEVICE_SLOTS
                if environment == "cloud"
                else settings.ROBOT_LOCAL_DEVICE_SLOTS
            )
            while True:
                execution = loop_item_execution_service.claim_next_for_device(
                    db,
                    execution_device_id=device_id,
                    environment=environment,
                    device_capacity=capacity,
                )
                if execution is None:
                    occupied = (
                        db.query(func.count(LoopItemExecution.id))
                        .filter(
                            LoopItemExecution.execution_device_id == device_id,
                            LoopItemExecution.execution_environment == environment,
                            LoopItemExecution.status.in_(["claimed", "running"]),
                        )
                        .scalar()
                        or 0
                    )
                    logger.info(
                        "[RobotQueue] Queued run not dispatched: device slot busy "
                        "device=%s environment=%s occupied=%s capacity=%s",
                        device_id,
                        environment,
                        occupied,
                        capacity,
                    )
                    break
                try:
                    await _dispatch_execution(
                        db, execution, routing_user_id=routing_user_id
                    )
                    dispatched += 1
                    ROBOT_QUEUE_DISPATCHED_TOTAL.inc()
                except Exception as exc:
                    _fail_dispatch(db, execution, exc)

    # Robots created before device binding have no bound device; they run on
    # any online local device of the creator.
    unbound = (
        db.query(LoopItemExecution)
        .join(ProjectChatAgent, ProjectChatAgent.id == LoopItemExecution.agent_id)
        .filter(
            LoopItemExecution.execution_environment == "local",
            LoopItemExecution.status == "queued",
            or_(
                LoopItemExecution.execution_device_id.is_(None),
                LoopItemExecution.execution_device_id == "",
            ),
            ProjectChatAgent.status == "active",
        )
        .order_by(
            LoopItemExecution.priority_weight.desc(),
            LoopItemExecution.queued_at.asc(),
            LoopItemExecution.id.asc(),
        )
        .limit(10)
        .all()
    )
    for execution in unbound:
        agent = db.get(ProjectChatAgent, execution.agent_id)
        if agent is None or not agent.created_by_user_id:
            continue
        device_id = await _online_local_device(db, agent.created_by_user_id)
        if not device_id:
            continue
        claimed = loop_item_execution_service.claim_next_unbound_local(
            db,
            creator_user_id=agent.created_by_user_id,
            execution_device_id=device_id,
        )
        if claimed is None:
            continue
        try:
            await _dispatch_execution(db, claimed)
            dispatched += 1
            ROBOT_QUEUE_DISPATCHED_TOTAL.inc()
        except Exception as exc:
            _fail_dispatch(db, claimed, exc)
    return dispatched


async def _cleanup_completed_workflow_resources(db: Session) -> int:
    """Remove merged workflow worktrees and managed sandboxes with retryable state."""

    from app.models.project_workflow import (
        ProjectRepositoryBinding,
        TaskDevelopmentLink,
        TaskStageRun,
        TaskWorkflowRun,
        TaskWorkspace,
    )
    from app.services import project_service
    from app.services.execution import get_executor_runtime_client

    rows = (
        db.query(TaskWorkspace, ProjectRepositoryBinding)
        .join(
            TaskDevelopmentLink,
            TaskDevelopmentLink.workspace_id == TaskWorkspace.id,
        )
        .join(
            ProjectRepositoryBinding,
            ProjectRepositoryBinding.id == TaskWorkspace.repository_binding_id,
        )
        .filter(
            TaskDevelopmentLink.pull_request_state == "merged",
            TaskWorkspace.status.in_(["ready", "released", "cleanup_failed"]),
            TaskWorkspace.cleanup_policy.in_(
                ["after_merge", "on_merge", "after_completion", "always"]
            ),
        )
        .all()
    )
    cleaned = 0
    for workspace, repository in rows:
        workspace.status = "cleaning"
        workspace.version += 1
        db.commit()
        try:
            if (
                workspace.workspace_kind == "git_worktree"
                and workspace.execution_target_type == "registered_device"
                and workspace.workspace_path
            ):
                if not repository.local_project_id or not workspace.execution_target_id:
                    raise RuntimeError(
                        "Git worktree cleanup requires a local project and device"
                    )
                await project_service.cleanup_git_worktree_path(
                    db=db,
                    user_id=repository.created_by_user_id,
                    project_id=repository.local_project_id,
                    client_origin="wework",
                    device_id=workspace.execution_target_id,
                    target_path=workspace.workspace_path,
                )
            if workspace.execution_target_type == "managed_container":
                run_ids = [
                    row[0]
                    for row in db.query(TaskWorkflowRun.id)
                    .filter(TaskWorkflowRun.loop_item_id == workspace.loop_item_id)
                    .all()
                ]
                sandbox_ids = {
                    row[0]
                    for row in db.query(TaskStageRun.runtime_instance_id)
                    .filter(
                        TaskStageRun.workflow_run_id.in_(run_ids),
                        TaskStageRun.runtime_instance_id != "",
                    )
                    .all()
                    if row[0]
                }
                client = get_executor_runtime_client()
                failed = []
                for sandbox_id in sorted(sandbox_ids):
                    deleted, error = await client.delete_sandbox(sandbox_id)
                    if not deleted:
                        failed.append(error or f"Failed to delete sandbox {sandbox_id}")
                if failed:
                    raise RuntimeError("; ".join(failed))
            workspace.status = "cleaned"
            workspace.workspace_path = ""
            workspace.version += 1
            cleaned += 1
        except Exception:
            workspace.status = "cleanup_failed"
            workspace.version += 1
            logger.exception(
                "[RobotQueue] Workflow resource cleanup failed workspace=%s task=%s",
                workspace.id,
                workspace.loop_item_id,
            )
        db.commit()
    return cleaned


async def _dispatch_managed_container_executions(db: Session) -> int:
    """Provision and dispatch queued coding-mode managed containers."""

    dispatched = 0
    with distributed_lock.acquire_context(
        "robot_exec:managed_containers",
        expire_seconds=ROBOT_DEVICE_LOCK_TIMEOUT,
    ) as acquired:
        if not acquired:
            return 0
        while True:
            execution = loop_item_execution_service.claim_next_managed_container(
                db,
                capacity=settings.ROBOT_MANAGED_CONTAINER_SLOTS,
            )
            if execution is None:
                break
            try:
                await _dispatch_managed_container(db, execution)
                dispatched += 1
                ROBOT_QUEUE_DISPATCHED_TOTAL.inc()
            except Exception as exc:
                _fail_dispatch(db, execution, exc)
    return dispatched


async def _dispatch_managed_container(
    db: Session,
    execution: LoopItemExecution,
) -> None:
    """Create a sandbox and start one workflow actor inside it."""

    from app.models.kind import Kind
    from app.models.project_workflow import (
        ProjectRepositoryBinding,
        TaskStageRun,
        TaskWorkflowRun,
    )
    from app.services.execution import get_executor_runtime_client
    from app.services.execution.request_builder import TaskRequestBuilder

    creator = db.get(User, execution.assigner_user_id)
    if creator is None:
        raise RuntimeError(f"Execution {execution.id} has no initiating user")
    task = loop_item_execution_service.resolve_task_context(
        db,
        execution=execution,
        user_id=creator.id,
    )
    if task is None:
        raise RuntimeError(f"Execution {execution.id} lost its task")

    prompt = (
        "Read the bound project task and its workflow artifacts, complete this "
        "stage, run real verification, and return a structured execution result."
    )
    bot_configs: list[dict]
    if execution.actor_type == "project_agent":
        agent = db.get(ProjectChatAgent, execution.actor_id)
        if agent is None:
            raise RuntimeError(
                f"Execution {execution.id} lost project Agent {execution.actor_id}"
            )
        prompt = loop_item_execution_service.build_robot_prompt(agent)
        payload = loop_item_execution_service.build_runtime_payload(
            db,
            execution=execution,
            task=task,
        )
        if payload is None:
            raise RuntimeError(f"Execution {execution.id} payload cannot be built")
        request = payload.get("executionRequest", {})
        bot_configs = request.get("bot", [])
    elif execution.actor_type == "wegent_team":
        snapshot = execution.actor_snapshot or {}
        team = (
            db.query(Kind)
            .filter(
                Kind.id == int(execution.actor_id),
                Kind.kind == "Team",
                Kind.namespace == snapshot.get("namespace"),
                Kind.name == snapshot.get("name"),
                Kind.user_id == snapshot.get("userId"),
                Kind.is_active.is_(True),
            )
            .first()
        )
        if team is None:
            raise RuntimeError(
                f"Execution {execution.id} lost Wegent Team {execution.actor_id}"
            )
        bot_configs = TaskRequestBuilder(db).build_team_bot_configs(
            team,
            creator.id,
        )
    else:
        raise RuntimeError(
            f"Execution {execution.id} has unsupported actor {execution.actor_type}"
        )
    if not bot_configs:
        raise RuntimeError(f"Execution {execution.id} has no runnable Bot")

    run = db.get(TaskWorkflowRun, execution.workflow_run_id)
    repository = (
        db.get(ProjectRepositoryBinding, run.repository_binding_id)
        if run and run.repository_binding_id
        else None
    )
    workflow_context_payload = {
        "executionRequest": {},
        "additionalContext": {},
    }
    await _apply_workflow_runtime_context(
        db,
        execution=execution,
        payload=workflow_context_payload,
        user_id=creator.id,
        prepare_workspace=False,
        include_workspace=False,
    )
    if workflow_context_payload.get("message"):
        prompt = str(workflow_context_payload["message"])
    try:
        sandbox_task_id = int(task.id)
    except (TypeError, ValueError):
        sandbox_task_id = int(execution.id)
    timeout = min(
        7200,
        max(
            60,
            int(
                (execution.actor_snapshot or {}).get("timeoutSeconds")
                or (execution.actor_snapshot or {}).get("timeout_seconds")
                or 3600
            ),
        ),
    )
    client = get_executor_runtime_client()
    sandbox, error = await client.create_sandbox(
        shell_type=str(bot_configs[0].get("shell_type") or "codex"),
        user_id=creator.id,
        user_name=creator.user_name,
        timeout=timeout,
        workspace_ref=repository.repository_url if repository else None,
        bot_config=bot_configs[0].get("agent_config") or {},
        metadata={
            "task_id": sandbox_task_id,
            "subtask_id": execution.id,
            "loop_item_id": task.id,
            "workflow_run_id": execution.workflow_run_id,
            "stage_run_id": execution.stage_run_id,
            "workflow_context": workflow_context_payload.get("additionalContext", {}),
        },
    )
    if sandbox is None:
        raise RobotQueueInfraError(error or "Managed container creation failed")
    result, error = await client.execute_sandbox(
        sandbox.sandbox_id,
        prompt=prompt,
        timeout=timeout,
        metadata={
            "subtask_id": execution.id,
            "bot_config": bot_configs,
            "loop_item_id": task.id,
            "workflow_run_id": execution.workflow_run_id,
            "stage_run_id": execution.stage_run_id,
            "workflow_context": workflow_context_payload.get("additionalContext", {}),
        },
    )
    if result is None:
        raise RobotQueueInfraError(error or "Managed container execution failed")
    runtime_task_id = str(result.get("execution_id") or execution.id)
    loop_item_execution_service.heartbeat(
        db,
        execution_id=execution.id,
        runtime_device_id=sandbox.sandbox_id,
        runtime_task_id=runtime_task_id,
    )
    stage = db.get(TaskStageRun, execution.stage_run_id)
    if stage:
        stage.runtime_instance_id = sandbox.sandbox_id
        stage.runtime_task_id = runtime_task_id
        stage.status = "running"
        stage.version += 1
        db.commit()
    logger.info(
        "[RobotQueue] Managed container dispatched execution=%s sandbox=%s "
        "runtime_task=%s actor=%s/%s",
        execution.id,
        sandbox.sandbox_id,
        runtime_task_id,
        execution.actor_type,
        execution.actor_id,
    )


async def dispatch_queues_background() -> None:
    """Trigger queue dispatch from the request path (dev-friendly).

    Production keeps the Celery scan as the retry/fallback; this entry point
    makes assign/approve push immediately without requiring a Celery worker.
    """

    from app.db.session import get_db_session

    try:
        with get_db_session() as db:
            await _dispatch_queued_executions(db)
    except Exception:
        logger.exception("[RobotQueue] Background queue dispatch failed")


def _robot_queue_internal_url() -> str:
    """Backend-internal API base for robot queue RPC emits.

    ``BACKEND_INTERNAL_URL`` carries the ``/api`` suffix in some environments
    (for example a gateway URL) and a bare host in others, so normalize before
    appending the internal route. The worker and the API server may run in
    different pods, so ``localhost`` must never be assumed.
    """

    base = (
        (settings.BACKEND_INTERNAL_URL or "http://localhost:8000").strip().rstrip("/")
    )
    if base.endswith("/api"):
        return base
    return f"{base}/api"


def emit_runtime_cancels(executions: list) -> None:
    """Best-effort tell devices to stop runs the backend just cancelled.

    Reassign/unassign and explicit cancel only mark the DB row cancelled;
    without this RPC the executor keeps running the old task (zombie run) and
    occupies the device slot. Fire-and-forget through the same internal emit
    endpoint the queue dispatcher uses, so it works from both request and
    worker contexts.
    """

    import httpx

    from app.db.session import get_db_session

    backend_url = _robot_queue_internal_url()
    with get_db_session() as db:
        for execution in executions:
            runtime_task_id = getattr(execution, "runtime_task_id", "") or ""
            runtime_device_id = getattr(execution, "runtime_device_id", "") or ""
            if not runtime_task_id or not runtime_device_id:
                continue
            creator_id = None
            agent_id = getattr(execution, "agent_id", None)
            if agent_id:
                agent = db.get(ProjectChatAgent, agent_id)
                creator_id = agent.created_by_user_id if agent else None
            user_id = _device_owner_user_id(
                db, runtime_device_id, preferred_user_id=creator_id
            )
            if user_id is None:
                # Cloud devices owned by another account still route by owner.
                user_id = _device_owner_user_id(db, runtime_device_id)
            if user_id is None:
                continue
            try:
                with httpx.Client(
                    base_url=backend_url, timeout=5, trust_env=False
                ) as client:
                    response = client.post(
                        "/internal/robot-queue/emit-runtime-rpc",
                        json={
                            "user_id": user_id,
                            "device_id": runtime_device_id,
                            "method": "runtime.tasks.cancel",
                            "payload": {
                                "taskId": runtime_task_id,
                                "deviceId": runtime_device_id,
                            },
                        },
                    )
                    if response.status_code != 200:
                        logger.warning(
                            "[RobotQueue] Runtime cancel emit failed status=%s execution=%s",
                            response.status_code,
                            getattr(execution, "id", None),
                        )
            except Exception:
                logger.exception(
                    "[RobotQueue] Runtime cancel emit failed execution=%s",
                    getattr(execution, "id", None),
                )


def publish_run_event(device_id: str, runtime_task_id: str, event_name: str) -> None:
    """Broadcast one matched robot-run runtime event for dispatch verification.

    The dispatcher subscribes to this channel before emitting
    `runtime.tasks.create`; the first matching event is the executor's
    confirmation that a codex session was really started, so the backend only
    marks the run visible (streaming comment) after that point.
    """

    import json

    from redis import Redis

    from app.core.config import settings

    try:
        client = Redis.from_url(
            settings.CELERY_BROKER_URL or settings.REDIS_URL,
            decode_responses=True,
        )
        try:
            client.publish(
                RUN_EVENT_CHANNEL,
                json.dumps(
                    {
                        "device_id": device_id,
                        "runtime_task_id": runtime_task_id,
                        "event_name": event_name,
                    }
                ),
            )
        finally:
            client.close()
    except Exception:
        logger.exception(
            "[RobotQueue] Run event publish failed device=%s task=%s event=%s",
            device_id,
            runtime_task_id,
            event_name,
        )


def wait_for_run_event(
    runtime_task_id: str, timeout_seconds: int = DISPATCH_START_TIMEOUT_SECONDS
) -> str | None:
    """Wait for the first robot-run event of a dispatched task.

    Returns the event name once the executor confirms the session started, or
    None when the timeout expires. Subscribe-before-emit eliminates the race
    between the executor's first event and this subscriber.
    """

    import json
    import time

    from redis import Redis

    from app.core.config import settings

    client = Redis.from_url(
        settings.CELERY_BROKER_URL or settings.REDIS_URL,
        decode_responses=True,
    )
    pubsub = client.pubsub()
    try:
        pubsub.subscribe(RUN_EVENT_CHANNEL)
        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            message = pubsub.get_message(timeout=1)
            if message is None or message.get("type") != "message":
                continue
            try:
                data = json.loads(message.get("data") or "{}")
            except (TypeError, ValueError):
                continue
            if data.get("runtime_task_id") == runtime_task_id:
                return str(data.get("event_name") or "")
    finally:
        try:
            pubsub.unsubscribe(RUN_EVENT_CHANNEL)
        except Exception:
            pass
        pubsub.close()
        client.close()
    return None


async def _consumer_pass(db: Session) -> int:
    """One consumer pass: claim queued runs per device and hand them to the
    execution subtask. Device locks distribute devices across workers, so
    multiple consumers scale without a global scan lock."""

    handled = 0
    for device_id, environment in _queued_devices(db):
        if environment == "local" and device_id == "local-device":
            logger.debug(
                "[RobotQueue] Background consumer left local compatibility "
                "device for App claim device=%s",
                device_id,
            )
            continue
        with distributed_lock.acquire_context(
            f"robot_exec:{device_id}",
            expire_seconds=ROBOT_DEVICE_LOCK_TIMEOUT,
        ) as acquired:
            if not acquired:
                continue
            routing_user_id = await _routing_user_for_device(db, device_id, environment)
            if routing_user_id is None:
                # Device offline or no identity online; leave runs queued.
                continue
            capacity = (
                settings.ROBOT_CLOUD_DEVICE_SLOTS
                if environment == "cloud"
                else settings.ROBOT_LOCAL_DEVICE_SLOTS
            )
            executions = loop_item_execution_service.claim_batch_for_device(
                db,
                execution_device_id=device_id,
                environment=environment,
                device_capacity=capacity,
                batch_size=ROBOT_CONSUMER_BATCH_SIZE,
            )
            for execution in executions:
                execute_robot_task.apply_async(args=[execution.id])
            handled += len(executions)
    return handled


def _run_robot_consumer() -> None:
    """Long-running consumer loop started per Celery worker process."""

    import time

    from app.db.session import get_db_session

    # The process-global `_robot_queue_loop()` is shared by Celery task
    # threads (scan/execute); a second thread cannot run_until_complete on it
    # while a task is using it ("event loop is already running"). The consumer
    # owns its own loop and never touches the socketio singleton (it only
    # claims and enqueues subtasks).
    consumer_loop = asyncio.new_event_loop()
    asyncio.set_event_loop(consumer_loop)

    backoff = ROBOT_CONSUMER_INTERVAL_SECONDS
    while True:
        try:
            with get_db_session() as db:
                handled = consumer_loop.run_until_complete(_consumer_pass(db))
            backoff = (
                ROBOT_CONSUMER_INTERVAL_SECONDS
                if handled
                else min(backoff + 1.0, ROBOT_CONSUMER_BACKOFF_MAX_SECONDS)
            )
        except Exception:
            logger.exception("[RobotQueue] Consumer pass failed")
            backoff = min(backoff + 1.0, ROBOT_CONSUMER_BACKOFF_MAX_SECONDS)
        time.sleep(backoff)


@celery.signals.worker_ready.connect
def _start_robot_consumer(**kwargs: object) -> None:
    """Spawn one consumer thread per Celery worker process."""

    if not settings.ROBOT_QUEUE_SCHEDULER_ENABLED:
        return
    import threading

    thread = threading.Thread(
        target=_run_robot_consumer,
        name="robot-queue-consumer",
        daemon=True,
    )
    thread.start()
    logger.info("[RobotQueue] Consumer thread started")


async def _online_local_device(db: Session, user_id: int) -> Optional[str]:
    """Resolve an online local/app device for the creator."""

    from app.models.kind import Kind
    from app.schemas.device import DeviceType
    from app.services.device_service import device_service

    rows = (
        db.query(Kind)
        .filter(
            Kind.kind == "Device",
            Kind.user_id == user_id,
            Kind.namespace == "default",
            Kind.is_active == True,
        )
        .all()
    )
    for row in rows:
        spec = (row.json or {}).get("spec", {})
        if spec.get("deviceType") not in {
            DeviceType.LOCAL.value,
            DeviceType.APP.value,
        }:
            continue
        try:
            if await device_service.get_device_online_info(user_id, row.name):
                return row.name
        except Exception:
            continue
    return None


def _build_wegent_team_runtime_payload(
    db: Session,
    *,
    execution: LoopItemExecution,
    task: object,
    creator: User,
) -> tuple[str, dict]:
    """Build a device runtime request from an exact Wegent Team snapshot."""

    from app.models.kind import Kind
    from app.services.execution.request_builder import TaskRequestBuilder

    snapshot = execution.actor_snapshot or {}
    team = (
        db.query(Kind)
        .filter(
            Kind.id == int(execution.actor_id),
            Kind.kind == "Team",
            Kind.namespace == snapshot.get("namespace"),
            Kind.name == snapshot.get("name"),
            Kind.user_id == snapshot.get("userId"),
            Kind.is_active.is_(True),
        )
        .first()
    )
    if team is None:
        raise RuntimeError(
            f"Execution {execution.id} lost Wegent Team {execution.actor_id}"
        )
    bot_configs = TaskRequestBuilder(db).build_team_bot_configs(team, creator.id)
    if not bot_configs:
        raise RuntimeError(f"Execution {execution.id} has no runnable Bot")
    title = getattr(task, "title", None) or getattr(task, "name", None) or ""
    task_id = f"codex-robot-{getattr(task, 'id', '')}"
    prompt = (
        f"You are Wegent Team {team.namespace}/{team.name}. Read the bound "
        "project task and existing workflow artifacts, complete this stage, "
        "submit every required structured artifact, run real verification, "
        "and report unfinished work and risks."
    )
    execution_request = {
        "task_id": task_id,
        "subtask_id": f"{task_id}-assistant",
        "team_id": team.id,
        "team_name": team.name,
        "team_namespace": team.namespace,
        "task_title": title,
        "subtask_title": f"{title} - Assistant",
        "user_id": creator.id,
        "user_name": creator.user_name,
        "user": {
            "id": creator.id,
            "name": creator.user_name,
            "user_name": creator.user_name,
        },
        "bot": bot_configs,
        "system_prompt": prompt,
        "prompt": prompt,
        "standalone_chat_workspace": True,
        "enable_tools": True,
        "enable_web_search": False,
        "enable_deep_thinking": True,
    }
    return prompt, {
        "taskId": task_id,
        "teamId": team.id,
        "runtime": "codex",
        "message": prompt,
        "title": title,
        "ephemeral": True,
        "continuable": True,
        "cloudProjectId": str(getattr(task, "cloud_project_id", "")),
        "executionRequest": execution_request,
        "additionalContext": {
            "projectWorkflow": {
                "kind": "application",
                "value": (
                    f"Workflow run {execution.workflow_run_id}, stage "
                    f"{execution.stage_run_id}, task cloud://projects/"
                    f"{getattr(task, 'cloud_project_id', '')}/todos/"
                    f"{getattr(task, 'id', '')}."
                ),
            }
        },
    }


async def _dispatch_execution(
    db: Session,
    execution: LoopItemExecution,
    *,
    routing_user_id: Optional[int] = None,
) -> None:
    """Start one claimed run on its bound device via the App's codex channel.

    `runtime.tasks.create` is the same RPC the App uses to submit codex tasks,
    so local and cloud devices are handled uniformly. The executor runs the
    task and its runtime events update the execution record.
    """

    creator = _execution_initiator(db, execution)
    if creator is None or not execution.execution_device_id:
        raise RuntimeError(f"Execution {execution.id} has no creator or bound device")
    task = loop_item_execution_service.resolve_task_context(
        db, execution=execution, user_id=creator.id
    )
    if task is None:
        raise RuntimeError(f"Execution {execution.id} lost its task")
    if routing_user_id is None:
        candidates = _resolve_routing_user_ids(
            db,
            execution.execution_device_id,
            creator.id,
            execution.execution_environment,
        )
        routing_user_id = candidates[0] if candidates else None
    if routing_user_id is None:
        raise RuntimeError(f"Execution {execution.id} has no routable device owner")

    online = await device_service.get_device_online_info(
        routing_user_id, execution.execution_device_id
    )
    logger.info(
        "[RobotQueue] Dispatch online check execution=%s device=%s "
        "routing_user=%s online=%s",
        execution.id,
        execution.execution_device_id,
        routing_user_id,
        bool(online),
    )
    if not online:
        raise DeviceOfflineError("Device went offline before dispatch")

    actor_type = execution.actor_type or ("project_agent" if execution.agent_id else "")
    if actor_type == "project_agent":
        agent = db.get(
            ProjectChatAgent,
            execution.actor_id or execution.agent_id,
        )
        if agent is None:
            raise RuntimeError(
                f"Execution {execution.id} lost project Agent "
                f"{execution.actor_id or execution.agent_id}"
            )
        prompt = loop_item_execution_service.build_robot_prompt(agent)
        payload = loop_item_execution_service.build_runtime_payload(
            db,
            execution=execution,
            task=task,
        )
        if payload is None:
            raise RuntimeError(f"Execution {execution.id} payload cannot be built")
    elif actor_type == "wegent_team":
        prompt, payload = _build_wegent_team_runtime_payload(
            db,
            execution=execution,
            task=task,
            creator=creator,
        )
    else:
        raise RuntimeError(
            f"Execution {execution.id} has unsupported actor {actor_type}"
        )
    await _apply_workflow_runtime_context(
        db,
        execution=execution,
        payload=payload,
        user_id=routing_user_id,
    )
    # The canonical runtime task id is bound at claim time; keep the same
    # identity here so events always map back to this execution.
    task_id = execution.runtime_task_id or f"codex-queue-{execution.id}"
    payload["taskId"] = task_id
    execution_request = payload.get("executionRequest")
    if isinstance(execution_request, dict):
        execution_request["task_id"] = task_id
        execution_request["subtask_id"] = f"{task_id}-assistant"
    # Write the runtime ids first so the executor's first event matches this
    # execution, then emit through the uvicorn process (the worker's Socket.IO
    # singleton is bound to a foreign loop). The Socket.IO ACK routing through
    # the Redis manager is unreliable, so acceptance is verified by waiting for
    # the executor's first runtime event (subscribe-before-emit): only a real
    # codex session produces one. A run whose executor never starts the session
    # fails/requeues here instead of showing a fake "AI 执行" comment.
    loop_item_execution_service.heartbeat(
        db,
        execution_id=execution.id,
        runtime_device_id=execution.execution_device_id,
        runtime_task_id=task_id,
    )
    import asyncio

    # Start the subscriber before emitting so the executor's first event can
    # never slip in between emit and subscribe.
    wait_task = asyncio.create_task(
        asyncio.to_thread(
            wait_for_run_event,
            task_id,
            DISPATCH_START_TIMEOUT_SECONDS,
        )
    )
    ack = await _emit_runtime_rpc(
        user_id=routing_user_id,
        device_id=execution.execution_device_id,
        method="runtime.tasks.create",
        payload=payload,
    )
    if not ack.get("emitted"):
        wait_task.cancel()
        raise DeviceEmitRejectedError("Device did not accept the runtime RPC")
    event_name = await wait_task
    if not event_name:
        raise ExecutorSessionStartError(
            f"Executor did not start a codex session for {task_id} within "
            f"{DISPATCH_START_TIMEOUT_SECONDS}s"
        )
    logger.info(
        "[RobotQueue] Runtime create confirmed execution=%s task=%s device=%s "
        "user=%s runtime_task=%s first_event=%s",
        execution.id,
        getattr(task, "id", ""),
        execution.execution_device_id,
        routing_user_id,
        task_id,
        event_name,
    )
    if actor_type == "project_agent":
        try:
            loop_item_execution_service.open_execution_activity(
                db,
                execution=execution,
                prompt=prompt,
            )
        except Exception:
            logger.exception(
                "[RobotQueue] Failed to open activity comment for execution=%s",
                execution.id,
            )
    logger.info(
        "[RobotQueue] Dispatched execution=%s task=%s actor=%s/%s "
        "device=%s runtime_task=%s",
        execution.id,
        task.id,
        actor_type,
        execution.actor_id or execution.agent_id,
        execution.execution_device_id,
        task_id,
    )


async def _apply_workflow_runtime_context(
    db: Session,
    *,
    execution: LoopItemExecution,
    payload: dict,
    user_id: int,
    prepare_workspace: bool = True,
    include_workspace: bool = True,
) -> None:
    """Prepare and inject the persisted workflow workspace and stage contract."""

    if not execution.workflow_run_id or not execution.stage_run_id:
        return
    from app.models.project_workflow import (
        ProjectRepositoryBinding,
        TaskStageRun,
        TaskWorkflowArtifact,
        TaskWorkflowRun,
        TaskWorkspace,
    )

    run = db.get(TaskWorkflowRun, execution.workflow_run_id)
    stage = db.get(TaskStageRun, execution.stage_run_id)
    if run is None or stage is None:
        raise RuntimeError(f"Execution {execution.id} lost its workflow stage")
    workspace = (
        db.get(TaskWorkspace, stage.workspace_id) if stage.workspace_id else None
    )
    repository = (
        db.get(ProjectRepositoryBinding, run.repository_binding_id)
        if run.repository_binding_id
        else None
    )
    if (
        workspace
        and workspace.workspace_kind == "git_worktree"
        and workspace.status != "ready"
        and prepare_workspace
    ):
        if repository is None or not repository.local_project_id:
            raise RuntimeError(
                f"Execution {execution.id} requires a local project for Git worktree preparation"
            )
        from app.services import project_service

        prepared = await project_service.prepare_git_worktree_for_task(
            db=db,
            user_id=user_id,
            project_id=repository.local_project_id,
            client_origin="wework",
            task_id=execution.id,
            base_branch=workspace.base_branch or repository.default_branch,
        )
        workspace.workspace_path = prepared["path"]
        workspace.workspace_kind = prepared["source"]
        workspace.status = "ready"
        workspace.version += 1
        db.commit()
    if workspace and include_workspace and not workspace.workspace_path:
        raise RuntimeError(f"Execution {execution.id} has no usable workspace path")

    node = stage.input_snapshot.get("workflowNode") or {}
    artifacts = (
        db.query(TaskWorkflowArtifact)
        .filter(TaskWorkflowArtifact.workflow_run_id == run.id)
        .order_by(TaskWorkflowArtifact.created_at.asc())
        .all()
    )
    artifact_context = [
        {
            "type": artifact.artifact_type,
            "schemaVersion": artifact.schema_version,
            "content": artifact.content_json,
            "objectKey": artifact.object_key or None,
            "sha256": artifact.sha256 or None,
        }
        for artifact in artifacts
    ]
    stage_contract = {
        "workflowRunId": run.id,
        "stageRunId": stage.id,
        "groupKey": stage.group_key,
        "nodeKey": stage.node_key,
        "nodeType": stage.node_type,
        "promptTemplate": node.get("prompt_template") or "",
        "requiredOutputs": stage.input_snapshot.get("requiredOutputs") or [],
        "inputArtifacts": stage.input_snapshot.get("inputArtifacts") or [],
        "artifacts": artifact_context,
        "branchName": workspace.branch_name if workspace else None,
        "baseBranch": workspace.base_branch if workspace else None,
    }
    execution_request = payload.setdefault("executionRequest", {})
    if workspace and include_workspace:
        execution_request.update(
            {
                "standalone_chat_workspace": False,
                "workspace_source": workspace.workspace_kind,
                "project_workspace_path": workspace.workspace_path,
                "workspace": {
                    "project": {
                        "source": workspace.workspace_kind,
                        "path": workspace.workspace_path,
                    }
                },
            }
        )
        payload["workspacePath"] = workspace.workspace_path
        payload["execution"] = {
            "workspace": {
                "source": workspace.workspace_kind,
                "path": workspace.workspace_path,
            }
        }
    if repository:
        execution_request["git_url"] = repository.repository_url
        execution_request["runtime_project_name"] = repository.repository_identity
    directive = (
        "Execute the persisted workflow stage contract below. Work only in the "
        "provided workspace. If branchName is present, create or switch to that "
        "branch before changing files. Produce every required output as a "
        "structured workflow artifact and report real verification results.\n"
        f"{stage_contract}"
    )
    execution_request["prompt"] = directive
    payload["message"] = directive
    payload.setdefault("additionalContext", {})["projectWorkflowStage"] = {
        "kind": "application",
        "value": stage_contract,
    }


async def _emit_runtime_rpc(
    *,
    user_id: int,
    device_id: str,
    method: str,
    payload: dict,
    wait_ack: bool = False,
    ack_timeout_seconds: int = 15,
) -> dict:
    """Call the internal emit endpoint in the uvicorn process."""

    import httpx

    backend_url = _robot_queue_internal_url()
    try:
        async with httpx.AsyncClient(
            base_url=backend_url, timeout=30, trust_env=False
        ) as client:
            response = await client.post(
                "/internal/robot-queue/emit-runtime-rpc",
                json={
                    "user_id": user_id,
                    "device_id": device_id,
                    "method": method,
                    "payload": payload,
                    "wait_ack": wait_ack,
                    "ack_timeout_seconds": ack_timeout_seconds,
                },
            )
            if response.status_code != 200:
                logger.error(
                    "[RobotQueue] Internal emit failed status=%s body=%s",
                    response.status_code,
                    response.text[:500],
                )
                return {"emitted": False}
            return response.json()
    except Exception as exc:
        logger.exception(
            "[RobotQueue] Internal emit request failed user=%s device=%s method=%s",
            user_id,
            device_id,
            method,
        )
        return {"emitted": False}


async def _device_online(user_id: int, device_id: str) -> bool:
    """Return whether a cloud device is currently connected."""

    try:
        return bool(await device_service.get_device_online_info(user_id, device_id))
    except Exception:
        logger.exception(
            "[RobotQueue] Failed to check device online user=%s device=%s",
            user_id,
            device_id,
        )
        return False
