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
from typing import Optional

from prometheus_client import Counter, Gauge
from sqlalchemy.orm import Session

from app.core.celery_app import celery_app
from app.core.config import settings
from app.core.distributed_lock import distributed_lock
from app.models.delivery import LoopItem, ProjectChatAgent
from app.models.loop_item_execution import LoopItemExecution
from app.models.user import User
from app.services.device_service import device_service
from app.services.loop_item_executions.service import (
    loop_item_execution_service,
)
from app.services.project_chat.service import bot_config, project_chat_service

logger = logging.getLogger(__name__)

ROBOT_QUEUE_SCAN_LOCK_TIMEOUT = 120
ROBOT_DEVICE_LOCK_TIMEOUT = 120

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

# The Socket.IO server is a process singleton bound to the event loop that
# first created it. Celery runs each task on a fresh loop via asyncio.run, so
# reuse ONE loop for all queue dispatch to keep the singleton consistent.
_ROBOT_QUEUE_LOOP: Optional[asyncio.AbstractEventLoop] = None


def _robot_queue_loop() -> asyncio.AbstractEventLoop:
    global _ROBOT_QUEUE_LOOP
    if _ROBOT_QUEUE_LOOP is None or _ROBOT_QUEUE_LOOP.is_closed():
        _ROBOT_QUEUE_LOOP = asyncio.new_event_loop()
        # Celery prefork children inherit the Socket.IO singleton bound to the
        # parent's (dead) event loop. Recreate it lazily so the next
        # get_sio() binds to OUR loop instead of failing with
        # "attached to a different loop".
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
                requeued, failed = loop_item_execution_service.recovery_scan(db)
                ROBOT_QUEUE_RECOVERED_TOTAL.labels(action="requeued").inc(requeued)
                ROBOT_QUEUE_RECOVERED_TOTAL.labels(action="failed").inc(failed)
                dispatched = _robot_queue_loop().run_until_complete(
                    _dispatch_queued_executions(db)
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
                    "dispatched": dispatched,
                    "requeued": requeued,
                    "failed": failed,
                }
            except Exception:
                logger.exception("[RobotQueue] scan_robot_queue failed")
                raise


def _queued_devices(db: Session) -> list[tuple[str, str]]:
    """Distinct bound devices with queued runs, for both execution environments."""

    from sqlalchemy import select

    rows = db.execute(
        select(
            LoopItemExecution.execution_device_id,
            LoopItemExecution.execution_environment,
        )
        .where(
            LoopItemExecution.status == "queued",
            LoopItemExecution.execution_device_id.is_not(None),
            LoopItemExecution.execution_device_id != "",
        )
        .distinct()
    ).all()
    return [(str(row[0]), str(row[1])) for row in rows if row[0]]


def _device_owner_user_id(db: Session, device_id: str) -> Optional[int]:
    """Resolve the user who owns a device.

    The executor's device socket registers under the user who owns the device
    (its online key is `device:online:{owner}:{device_id}`), which may differ
    from the robot creator in mixed dev environments.
    """

    from app.models.kind import Kind

    row = (
        db.query(Kind)
        .filter(
            Kind.kind == "Device",
            Kind.name == device_id,
            Kind.is_active == True,
        )
        .first()
    )
    return row.user_id if row and row.user_id else None


async def _dispatch_queued_executions(db: Session) -> int:
    """Dispatch queued robot runs to their bound devices.

    Local and cloud devices are the same kind of executor, so every run is
    claimed by the backend and pushed over the device WebSocket with the same
    `runtime.tasks.create` RPC the App uses to submit codex tasks. The payload
    carries the complete model configuration (same as an App send), so devices
    do not need an App to start a run. Offline devices stay queued and are
    retried on the next scan.
    """

    dispatched = 0
    for device_id, environment in _queued_devices(db):
        with distributed_lock.acquire_context(
            f"robot_exec:{device_id}",
            expire_seconds=ROBOT_DEVICE_LOCK_TIMEOUT,
        ) as device_acquired:
            if not device_acquired:
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
            sample_agent = db.get(ProjectChatAgent, sample.agent_id)
            sample_creator = (
                db.get(User, sample_agent.created_by_user_id)
                if sample_agent and sample_agent.created_by_user_id
                else None
            )
            device_owner = _device_owner_user_id(db, device_id)
            candidate_users = {
                user_id
                for user_id in (
                    device_owner,
                    sample_creator.id if sample_creator else None,
                )
                if user_id
            }
            routing_user_id = None
            for candidate in candidate_users:
                if await _device_online(candidate, device_id):
                    routing_user_id = candidate
                    break
            if routing_user_id is None:
                # Leave runs queued; no identity with this device is online.
                continue
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
                    break
                try:
                    await _dispatch_execution(
                        db, execution, routing_user_id=routing_user_id
                    )
                    dispatched += 1
                    ROBOT_QUEUE_DISPATCHED_TOTAL.inc()
                except Exception as exc:
                    logger.exception(
                        "[RobotQueue] Dispatch failed execution=%s", execution.id
                    )
                    loop_item_execution_service.fail(
                        db,
                        execution_id=execution.id,
                        error=str(exc)[:2000],
                        requeue=True,
                    )
                    ROBOT_QUEUE_FAILED_TOTAL.inc()

    # Robots created before device binding have no bound device; they run on
    # any online local device of the creator.
    unbound = (
        db.query(LoopItemExecution)
        .join(ProjectChatAgent, ProjectChatAgent.id == LoopItemExecution.agent_id)
        .filter(
            LoopItemExecution.execution_environment == "local",
            LoopItemExecution.status == "queued",
            LoopItemExecution.execution_device_id.is_(None),
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
            logger.exception(
                "[RobotQueue] Unbound local dispatch failed execution=%s",
                claimed.id,
            )
            loop_item_execution_service.fail(
                db,
                execution_id=claimed.id,
                error=str(exc)[:2000],
                requeue=True,
            )
            ROBOT_QUEUE_FAILED_TOTAL.inc()
    return dispatched


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

    item = db.get(LoopItem, execution.loop_item_id)
    agent = db.get(ProjectChatAgent, execution.agent_id)
    if item is None or agent is None:
        raise RuntimeError(f"Execution {execution.id} lost its task or robot")
    creator = (
        db.get(User, agent.created_by_user_id) if agent.created_by_user_id else None
    )
    if creator is None or not execution.execution_device_id:
        raise RuntimeError(f"Execution {execution.id} has no creator or bound device")
    routing_user_id = routing_user_id or (
        _device_owner_user_id(db, execution.execution_device_id) or creator.id
    )

    online = await device_service.get_device_online_info(
        routing_user_id, execution.execution_device_id
    )
    if not online:
        raise RuntimeError("Device went offline before dispatch")

    prompt = loop_item_execution_service.build_robot_prompt(item, agent)
    payload = loop_item_execution_service.build_runtime_payload(db, execution=execution)
    if payload is None:
        raise RuntimeError(f"Execution {execution.id} payload cannot be built")
    # Give every run a unique runtime task id so its events map back to this
    # execution and repeated runs of the same task never collide.
    task_id = f"codex-queue-{execution.id}"
    payload["taskId"] = task_id
    execution_request = payload.get("executionRequest")
    if isinstance(execution_request, dict):
        execution_request["task_id"] = task_id
        execution_request["subtask_id"] = f"{task_id}-assistant"
    # Emit through the uvicorn process (the worker's Socket.IO singleton is
    # bound to a foreign loop), then optimistically record the runtime task id
    # (we set it above) so the executor's runtime events map back to this run.
    ack = await _emit_runtime_rpc(
        user_id=routing_user_id,
        device_id=execution.execution_device_id,
        method="runtime.tasks.create",
        payload=payload,
    )
    if not ack.get("emitted"):
        raise RuntimeError("Device did not accept the runtime RPC")
    # The internal endpoint emits without waiting for an ACK (the Socket.IO
    # Redis manager can lose or misroute concurrent ACKs), so the runtime task
    # id is written optimistically here. Runtime events carry the same id and
    # write back the real terminal status.
    runtime_task_id = task_id

    loop_item_execution_service.heartbeat(
        db,
        execution_id=execution.id,
        runtime_device_id=execution.execution_device_id,
        runtime_task_id=runtime_task_id,
    )
    try:
        from app.schemas.project_chat import ProjectChatAgentStart

        start_request = ProjectChatAgentStart(
            project_id=str(item.cloud_project_id),
            task_id=item.id,
            trigger_message_id=None,
            agent_id=agent.id,
            runtime_device_id=execution.execution_device_id,
            runtime_task_id=runtime_task_id,
            prompt=prompt,
            auto_retry=True,
            model=bot_config(agent).get("model"),
        )
        project_chat_service.start_agent_response(
            db,
            user_id=creator.id,
            request=start_request,
        )
    except Exception:
        logger.exception(
            "[RobotQueue] Failed to start project chat agent response for execution=%s",
            execution.id,
        )
    logger.info(
        "[RobotQueue] Dispatched execution=%s task=%s agent=%s device=%s runtime_task=%s",
        execution.id,
        item.id,
        agent.id,
        execution.execution_device_id,
        runtime_task_id,
    )


async def _emit_runtime_rpc(
    *,
    user_id: int,
    device_id: str,
    method: str,
    payload: dict,
) -> dict:
    """Call the internal emit endpoint in the uvicorn process."""

    import httpx

    backend_url = "http://localhost:8000"
    try:
        async with httpx.AsyncClient(
            base_url=backend_url, timeout=30, trust_env=False
        ) as client:
            response = await client.post(
                "/api/internal/robot-queue/emit-runtime-rpc",
                json={
                    "user_id": user_id,
                    "device_id": device_id,
                    "method": method,
                    "payload": payload,
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
