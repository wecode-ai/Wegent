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
import json
import logging
import os
from typing import Optional

import celery.signals
from prometheus_client import Counter, Gauge
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.celery_app import celery_app
from app.core.config import settings
from app.core.distributed_lock import distributed_lock
from app.models.loop_item_execution import LoopItemExecution
from app.models.user import User
from app.services.device.capacity import get_runtime_capacity
from app.services.device_service import device_service
from app.services.loop_item_executions.service import (
    WeworkRuntimeConfigurationError,
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

    if isinstance(exc, ExecutorSessionStartError):
        reason = _infra_reason(exc)
        logger.error(
            "[RobotQueue] Runtime start outcome is unknown execution=%s "
            "device=%s error=%s",
            execution.id,
            execution.execution_device_id,
            str(exc)[:300],
        )
        loop_item_execution_service.mark_dispatch_unknown(
            db,
            execution_id=execution.id,
            error=str(exc),
        )
        ROBOT_QUEUE_INFRA_FAILED_TOTAL.labels(reason=reason).inc()
        return
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
    if isinstance(exc, WeworkRuntimeConfigurationError):
        logger.error(
            "[RobotQueue] Runtime configuration unavailable execution=%s "
            "device=%s error=%s",
            execution.id,
            execution.execution_device_id,
            str(exc)[:300],
        )
        loop_item_execution_service.fail(
            db,
            execution_id=execution.id,
            error=str(exc)[:2000],
            note="runtime_configuration_unavailable",
            requeue=False,
        )
        ROBOT_QUEUE_FAILED_TOTAL.inc()
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
    """Recover stale queue state and publish queue metrics.

    Cloud dispatch has exactly one state machine: the owner-scoped consumer
    claims rows and hands them to ``execute_robot_task``. The periodic scan
    must never independently claim or dispatch the same rows.
    """

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
                requeued, unknown = loop_item_execution_service.recovery_scan(db)
                ROBOT_QUEUE_RECOVERED_TOTAL.labels(action="requeued").inc(requeued)
                ROBOT_QUEUE_RECOVERED_TOTAL.labels(action="unknown").inc(unknown)
                reconciled = _robot_queue_loop().run_until_complete(
                    _reconcile_stale_executions(db)
                )
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
                    "requeued": requeued,
                    "unknown": unknown,
                    "reconciled": reconciled,
                    "stalled": len(stalled),
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
    """Run one claimed cloud execution on its bound device.

    The consumer loop only claims (queued -> claimed) and hands the work here;
    this subtask records that Start may be delivered, performs the Runtime RPC,
    and waits for a Runtime event to prove the process actually started.
    """

    from app.db.session import get_db_session

    with get_db_session() as db:
        execution = db.get(LoopItemExecution, execution_id)
        if execution is None:
            return {"status": "missing", "execution_id": execution_id}
        if execution.execution_environment != "cloud":
            return {
                "status": "skipped",
                "reason": "local executions are claimed by the Wework App",
                "execution_id": execution_id,
            }
        if execution.status != "claimed":
            return {
                "status": "skipped",
                "reason": "execution is no longer claimed",
                "execution_id": execution_id,
            }
        try:
            _robot_queue_loop().run_until_complete(_dispatch_execution(db, execution))
            ROBOT_QUEUE_DISPATCHED_TOTAL.inc()
            return {"status": "dispatched", "execution_id": execution_id}
        except Exception as exc:
            _fail_dispatch(db, execution, exc)
            if isinstance(exc, RobotQueueInfraError):
                current = db.get(LoopItemExecution, execution_id)
                return {
                    "status": (
                        "unknown"
                        if current is not None and current.sync_state == "stale"
                        else "requeued"
                    ),
                    "reason": _infra_reason(exc),
                    "execution_id": execution_id,
                }
            return {"status": "failed", "execution_id": execution_id}


def _queued_devices(db: Session) -> list[tuple[int, str, str]]:
    """Distinct owner-scoped cloud devices with queued/claimed runs."""

    from sqlalchemy import select

    rows = db.execute(
        select(
            LoopItemExecution.executor_owner_user_id,
            LoopItemExecution.execution_device_id,
            LoopItemExecution.execution_environment,
        )
        .where(
            LoopItemExecution.status.in_(["queued", "claimed"]),
            LoopItemExecution.execution_environment == "cloud",
            LoopItemExecution.execution_device_id.is_not(None),
            LoopItemExecution.execution_device_id != "",
        )
        .distinct()
    ).all()
    return [
        (int(row[0]), str(row[1]), str(row[2])) for row in rows if row[0] and row[1]
    ]


def _owner_has_device(db: Session, owner_user_id: int, device_id: str) -> bool:
    """Return whether the exact owner has an active device with this id."""

    from app.models.kind import Kind

    return (
        db.query(Kind.id)
        .filter(
            Kind.kind == "Device",
            Kind.namespace == "default",
            Kind.name == device_id,
            Kind.user_id == owner_user_id,
            Kind.is_active == True,
        )
        .first()
        is not None
    )


async def _routing_user_for_device(
    db: Session, owner_user_id: int, device_id: str, environment: str
) -> Optional[int]:
    """Return the exact online owner for one cloud queue identity."""

    if environment != "cloud" or not _owner_has_device(db, owner_user_id, device_id):
        return None
    return owner_user_id if await _device_online(owner_user_id, device_id) else None


async def consume_queues_background() -> None:
    """Wake the canonical cloud consumer from a request path."""

    from app.db.session import get_db_session

    try:
        with get_db_session() as db:
            await _consumer_pass(db)
    except Exception:
        logger.exception("[RobotQueue] Background queue consume failed")


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


def emit_runtime_cancels(executions: list[LoopItemExecution]) -> set[int]:
    """Stop Runtime tasks and commit cancellation only after its ACK."""

    import httpx

    backend_url = _robot_queue_internal_url()
    confirmed_execution_ids: set[int] = set()
    for execution in executions:
        runtime_task_id = execution.runtime_task_id or ""
        runtime_device_id = execution.runtime_device_id or ""
        owner_user_id = execution.executor_owner_user_id
        if not runtime_task_id or not runtime_device_id or not owner_user_id:
            continue
        try:
            with httpx.Client(
                base_url=backend_url, timeout=5, trust_env=False
            ) as client:
                response = client.post(
                    "/internal/robot-queue/emit-runtime-rpc",
                    headers={
                        "Authorization": f"Bearer {settings.INTERNAL_SERVICE_TOKEN}"
                    },
                    json={
                        "user_id": owner_user_id,
                        "device_id": runtime_device_id,
                        "method": "runtime.tasks.cancel",
                        "payload": {
                            "taskId": runtime_task_id,
                            "deviceId": runtime_device_id,
                        },
                        "wait_ack": True,
                        "ack_timeout_seconds": 15,
                    },
                )
                result = response.json() if response.status_code == 200 else {}
                if response.status_code != 200 or not result.get("accepted"):
                    logger.warning(
                        "[RobotQueue] Runtime cancel was not confirmed status=%s "
                        "execution=%s result=%s",
                        response.status_code,
                        execution.id,
                        str(result)[:500],
                    )
                    continue
            from app.db.session import get_db_session

            with get_db_session() as db:
                loop_item_execution_service.confirm_runtime_cancelled(
                    db,
                    execution_id=execution.id,
                    note="Runtime confirmed cancellation",
                )
            confirmed_execution_ids.add(execution.id)
        except Exception:
            logger.exception(
                "[RobotQueue] Runtime cancel emit failed execution=%s",
                execution.id,
            )
    return confirmed_execution_ids


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


async def _reconcile_stale_executions(db: Session) -> int:
    """Query Runtime for stale attempts without guessing from lease expiry."""

    executions = loop_item_execution_service.stale_for_reconciliation(db)
    execution_refs = [
        (
            execution.id,
            execution.executor_owner_user_id,
            execution.runtime_device_id,
            execution.runtime_task_id,
        )
        for execution in executions
    ]
    db.rollback()
    reconciled = 0
    for (
        execution_id,
        owner_user_id,
        runtime_device_id,
        runtime_task_id,
    ) in execution_refs:
        result = await _emit_runtime_rpc(
            user_id=owner_user_id,
            device_id=runtime_device_id,
            method="runtime.tasks.list",
            payload={},
            wait_ack=True,
        )
        response = result.get("response")
        if not result.get("accepted") or not isinstance(response, dict):
            continue
        task_snapshot: Optional[dict] = None
        for workspace in response.get("workspaces", []):
            if not isinstance(workspace, dict):
                continue
            for task in workspace.get("tasks", []):
                if (
                    isinstance(task, dict)
                    and str(task.get("taskId") or task.get("task_id") or "")
                    == runtime_task_id
                ):
                    task_snapshot = task
                    break
            if task_snapshot is not None:
                break
        if task_snapshot is None:
            loop_item_execution_service.reconcile_runtime_snapshot(
                db,
                execution_id=execution_id,
                runtime_status="missing",
                running=False,
            )
            reconciled += 1
            continue
        loop_item_execution_service.reconcile_runtime_snapshot(
            db,
            execution_id=execution_id,
            runtime_status=str(task_snapshot.get("status") or ""),
            running=bool(task_snapshot.get("running")),
            turn_status=str(
                task_snapshot.get("turnStatus")
                or task_snapshot.get("turn_status")
                or ""
            ),
        )
        reconciled += 1
    return reconciled


async def reconcile_device_executions(*, user_id: int, device_id: str) -> int:
    """Reconcile active runs after a device reconnects.

    The database session is released before the Runtime RPC so reconnect
    recovery never holds a SQL transaction across network I/O.
    """

    from app.db.session import get_db_session

    with get_db_session() as db:
        executions = loop_item_execution_service.active_for_device_reconciliation(
            db,
            owner_user_id=user_id,
            runtime_device_id=device_id,
        )
        execution_refs = [
            (execution.id, execution.runtime_task_id) for execution in executions
        ]
    if not execution_refs:
        return 0

    result = await _emit_runtime_rpc(
        user_id=user_id,
        device_id=device_id,
        method="runtime.tasks.list",
        payload={},
        wait_ack=True,
    )
    response = result.get("response")
    if not result.get("accepted") or not isinstance(response, dict):
        logger.warning(
            "[RobotQueue] Device reconnect reconciliation unavailable "
            "user=%s device=%s executions=%s",
            user_id,
            device_id,
            [execution_id for execution_id, _ in execution_refs],
        )
        return 0

    snapshots: dict[str, dict] = {}
    for workspace in response.get("workspaces", []):
        if not isinstance(workspace, dict):
            continue
        for task in workspace.get("tasks", []):
            if not isinstance(task, dict):
                continue
            runtime_task_id = str(task.get("taskId") or task.get("task_id") or "")
            if runtime_task_id:
                snapshots[runtime_task_id] = task

    reconciled = 0
    with get_db_session() as db:
        for execution_id, runtime_task_id in execution_refs:
            execution = db.get(LoopItemExecution, execution_id)
            if (
                execution is None
                or execution.executor_owner_user_id != user_id
                or execution.runtime_device_id != device_id
                or execution.runtime_task_id != runtime_task_id
            ):
                continue
            snapshot = snapshots.get(runtime_task_id)
            loop_item_execution_service.reconcile_runtime_snapshot(
                db,
                execution_id=execution_id,
                runtime_status=(
                    str(snapshot.get("status") or "") if snapshot else "missing"
                ),
                running=bool(snapshot.get("running")) if snapshot else False,
                turn_status=(
                    str(snapshot.get("turnStatus") or snapshot.get("turn_status") or "")
                    if snapshot
                    else None
                ),
            )
            reconciled += 1
    logger.info(
        "[RobotQueue] Reconciled active executions after device reconnect "
        "user=%s device=%s count=%s",
        user_id,
        device_id,
        reconciled,
    )
    return reconciled


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
    for owner_user_id, device_id, environment in _queued_devices(db):
        with distributed_lock.acquire_context(
            f"robot_exec_owner:{owner_user_id}",
            expire_seconds=ROBOT_DEVICE_LOCK_TIMEOUT,
        ) as owner_acquired:
            if not owner_acquired:
                continue
            capacity = await get_runtime_capacity(
                db,
                owner_user_id=owner_user_id,
                device_id=device_id,
            )
            if capacity is None:
                continue
            with distributed_lock.acquire_context(
                f"robot_exec:{owner_user_id}:runtime:{capacity.runtime_instance_id}",
                expire_seconds=ROBOT_DEVICE_LOCK_TIMEOUT,
            ) as device_acquired:
                if not device_acquired:
                    continue
                routing_user_id = await _routing_user_for_device(
                    db, owner_user_id, device_id, environment
                )
                if routing_user_id is None:
                    continue
                executions = loop_item_execution_service.claim_batch_for_device(
                    db,
                    execution_device_id=device_id,
                    environment=environment,
                    runtime_instance_id=capacity.runtime_instance_id,
                    device_capacity=capacity.limit,
                    runtime_active=capacity.active,
                    runtime_active_task_ids=capacity.active_task_ids,
                    batch_size=ROBOT_CONSUMER_BATCH_SIZE,
                    owner_user_id=owner_user_id,
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


async def _dispatch_execution(
    db: Session,
    execution: LoopItemExecution,
    *,
    routing_user_id: Optional[int] = None,
) -> None:
    """Start one claimed run on its bound device via the App's codex channel.

    The backend dispatches only cloud rows. Local rows are claimed and started
    by the Wework App, with both paths resolving current configuration only
    when the execution starts.
    """

    if execution.execution_environment != "cloud":
        raise RuntimeError(f"Execution {execution.id} is not a cloud execution")
    owner_user_id = execution.executor_owner_user_id
    creator = db.get(User, owner_user_id)
    if creator is None or not execution.execution_device_id:
        raise RuntimeError(f"Execution {execution.id} has no owner or bound device")
    if routing_user_id is not None and routing_user_id != owner_user_id:
        raise RuntimeError(
            f"Execution {execution.id} cannot route through another device owner"
        )
    if routing_user_id is None:
        if not _owner_has_device(db, owner_user_id, execution.execution_device_id):
            raise RuntimeError(
                f"Execution {execution.id} has no owner-scoped device binding"
            )
        routing_user_id = owner_user_id
    if routing_user_id is None:
        raise RuntimeError(f"Execution {execution.id} has no routable device owner")

    capacity = await get_runtime_capacity(
        db,
        owner_user_id=routing_user_id,
        device_id=execution.execution_device_id,
    )
    logger.info(
        "[RobotQueue] Dispatch online check execution=%s device=%s "
        "routing_user=%s online=%s",
        execution.id,
        execution.execution_device_id,
        routing_user_id,
        bool(capacity),
    )
    if capacity is None:
        raise DeviceOfflineError("Device capacity observation expired before dispatch")
    if capacity.runtime_instance_id != execution.runtime_instance_id:
        raise DeviceOfflineError("Runtime capacity identity changed before dispatch")

    payload = loop_item_execution_service.build_runtime_payload(
        db,
        execution=execution,
    )
    # The canonical runtime task id is bound at claim time; keep the same
    # identity here so events always map back to this execution.
    task_id = execution.runtime_task_id or f"codex-queue-{execution.id}"
    payload["taskId"] = task_id
    execution_request = payload.get("executionRequest")
    if isinstance(execution_request, dict):
        execution_request["task_id"] = task_id
        execution_request["subtask_id"] = f"{task_id}-assistant"
    advanced = loop_item_execution_service.mark_start_requested(
        db, execution_ids=[execution.id]
    )
    if advanced != 1:
        raise RuntimeError(f"Execution {execution.id} is no longer dispatchable")
    db.expire_all()
    execution = db.get(LoopItemExecution, execution.id)
    if execution is None:
        raise RuntimeError("Execution disappeared before Runtime dispatch")
    # Write the runtime ids first so the executor's first event matches this
    # execution, then emit through the uvicorn process (the worker's Socket.IO
    # singleton is bound to a foreign loop). The Socket.IO ACK routing through
    # the Redis manager is unreliable, so acceptance is verified by waiting for
    # the executor's first runtime event (subscribe-before-emit): only a real
    # codex session produces one. A run whose executor never starts the session
    # fails/requeues here instead of showing a fake "AI 执行" comment.
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
        if ack.get("outcome_unknown"):
            raise ExecutorSessionStartError(
                "Runtime RPC delivery outcome is unknown after Start was fenced"
            )
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
        execution.loop_item_id,
        execution.execution_device_id,
        routing_user_id,
        task_id,
        event_name,
    )
    logger.info(
        "[RobotQueue] Dispatched execution=%s task=%s executor=%s agent=%s "
        "device=%s runtime_task=%s",
        execution.id,
        execution.loop_item_id,
        execution.executor_type,
        execution.agent_id,
        execution.execution_device_id,
        task_id,
    )


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
                headers={"Authorization": f"Bearer {settings.INTERNAL_SERVICE_TOKEN}"},
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
                return {
                    "emitted": False,
                    "outcome_unknown": response.status_code >= 500,
                }
            return response.json()
    except Exception as exc:
        logger.exception(
            "[RobotQueue] Internal emit request failed user=%s device=%s method=%s",
            user_id,
            device_id,
            method,
        )
        return {"emitted": False, "outcome_unknown": True}


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
