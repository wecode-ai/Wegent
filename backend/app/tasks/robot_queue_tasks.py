# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Maintenance and notifications for the durable robot execution queue.

Executors pull cloud work through their current Socket.IO connection. Celery
only repairs durable leases, detects stalls, and publishes queue metrics.
"""

import logging

import socketio
from prometheus_client import Counter, Gauge
from sqlalchemy import func, select

from app.core.celery_app import celery_app
from app.core.config import settings
from app.core.distributed_lock import distributed_lock
from app.models.kind import Kind
from app.models.loop_item_execution import LoopItemExecution
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.services.device.runtime_route import runtime_device_route_id
from app.services.device_service import device_service
from app.services.loop_item_executions.service import loop_item_execution_service

logger = logging.getLogger(__name__)

ROBOT_QUEUE_SCAN_LOCK_TIMEOUT = 120

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


@celery_app.task(bind=True, name="app.tasks.robot_queue_tasks.scan_robot_queue")
def scan_robot_queue(self) -> dict:
    """Repair durable state and metrics without dispatching Runtime work."""

    if not settings.ROBOT_QUEUE_SCHEDULER_ENABLED:
        return {"status": "skipped", "reason": "scheduler_disabled"}
    from app.db.session import get_db_session

    with distributed_lock.acquire_context(
        "scan_robot_queue",
        expire_seconds=ROBOT_QUEUE_SCAN_LOCK_TIMEOUT,
    ) as acquired:
        if not acquired:
            return {"status": "skipped", "reason": "lock_held_by_another_instance"}
        with get_db_session() as db:
            requeued, unknown = loop_item_execution_service.recovery_scan(db)
            ROBOT_QUEUE_RECOVERED_TOTAL.labels(action="requeued").inc(requeued)
            ROBOT_QUEUE_RECOVERED_TOTAL.labels(action="unknown").inc(unknown)
            stalled = loop_item_execution_service.stall_scan(db)
            if stalled:
                logger.warning(
                    "[RobotQueue] Stall scan stopped %s run(s): %s",
                    len(stalled),
                    [run.id for run in stalled],
                )
                emit_runtime_cancels(stalled)
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
            _publish_work_availability(_queued_devices(db))
            return {
                "status": "ok",
                "requeued": requeued,
                "unknown": unknown,
                "reconciled": 0,
                "stalled": len(stalled),
            }


def _queued_devices(db) -> list[tuple[int, str]]:
    bound_rows = db.execute(
        select(
            LoopItemExecution.executor_owner_user_id,
            LoopItemExecution.execution_device_id,
        )
        .where(
            LoopItemExecution.status == "queued",
            LoopItemExecution.execution_environment.in_(("local", "cloud")),
            LoopItemExecution.execution_device_id.is_not(None),
            LoopItemExecution.execution_device_id != "",
        )
        .distinct()
    ).all()
    devices = {(int(row[0]), str(row[1])) for row in bound_rows if row[0] and row[1]}
    devices.update(_unbound_queue_devices(db))
    from app.services.workspace_cleanup_intents import due_execution_targets

    devices.update(due_execution_targets(db))
    return sorted(devices)


def _unbound_queue_devices(db) -> set[tuple[int, str]]:
    """Resolve project-authorized devices without cross-collation joins."""

    queued_projects = db.execute(
        select(
            LoopItemExecution.executor_owner_user_id,
            LoopItemExecution.cloud_project_id,
        )
        .where(
            LoopItemExecution.status == "queued",
            LoopItemExecution.execution_environment.in_(("local", "cloud")),
            LoopItemExecution.execution_device_id == "",
        )
        .distinct()
    ).all()
    if not queued_projects:
        return set()
    project_ids = {str(project_id) for _, project_id in queued_projects if project_id}
    grants = (
        db.query(ResourceMember.entity_id, ResourceMember.resource_id)
        .filter(
            ResourceMember.resource_type == ResourceType.DEVICE.value,
            ResourceMember.entity_type == "project",
            ResourceMember.entity_id.in_(project_ids),
            ResourceMember.status == MemberStatus.APPROVED.value,
        )
        .all()
    )
    granted_device_ids_by_project: dict[str, set[int]] = {}
    for project_id, device_id in grants:
        if project_id and device_id:
            granted_device_ids_by_project.setdefault(str(project_id), set()).add(
                int(device_id)
            )
    device_ids = {
        device_id
        for granted_ids in granted_device_ids_by_project.values()
        for device_id in granted_ids
    }
    if not device_ids:
        return set()
    active_devices = (
        db.query(Kind)
        .filter(
            Kind.id.in_(device_ids),
            Kind.kind == "Device",
            Kind.is_active.is_(True),
        )
        .all()
    )
    devices_by_id = {int(device.id): device for device in active_devices}
    return {
        (int(owner_user_id), runtime_device_route_id(device))
        for owner_user_id, project_id in queued_projects
        for device_id in granted_device_ids_by_project.get(str(project_id), set())
        if owner_user_id
        and (device := devices_by_id.get(device_id)) is not None
        and int(device.user_id) == int(owner_user_id)
        and runtime_device_route_id(device)
    }


def _publish_work_availability(devices: list[tuple[int, str]]) -> None:
    """Publish from Celery without borrowing the uvicorn event loop."""

    if not devices:
        return
    logger.info(
        "[RobotQueue] Publishing work availability source=celery targets=%s",
        devices,
    )
    manager = socketio.RedisManager(settings.REDIS_URL, write_only=True)
    for owner_user_id, device_id in devices:
        manager.emit(
            "runtime.tasks.available",
            {},
            room=f"execution-target:{owner_user_id}:{device_id}",
            namespace="/local-executor",
        )


async def consume_queues_background() -> None:
    """Notify connected Executors; the notification never carries work."""

    from app.core.socketio import get_sio
    from app.db.session import get_db_session

    try:
        with get_db_session() as db:
            devices = _queued_devices(db)
        if devices:
            logger.info(
                "[RobotQueue] Publishing work availability source=api targets=%s",
                devices,
            )
        for owner_user_id, device_id in devices:
            await get_sio().emit(
                "runtime.tasks.available",
                {},
                room=f"execution-target:{owner_user_id}:{device_id}",
                namespace="/local-executor",
            )
    except Exception:
        logger.exception("[RobotQueue] Work availability notification failed")


def _robot_queue_internal_url() -> str:
    base = (
        (settings.BACKEND_INTERNAL_URL or "http://localhost:8000").strip().rstrip("/")
    )
    return base if base.endswith("/api") else f"{base}/api"


def emit_runtime_cancels(executions: list[LoopItemExecution]) -> set[int]:
    """Stop Runtime tasks and commit cancellation only after its ACK."""

    import httpx

    confirmed_execution_ids: set[int] = set()
    for execution in executions:
        runtime_task_id = execution.runtime_task_id or ""
        runtime_device_id = execution.runtime_device_id or ""
        execution_target_id = (
            execution.execution_device_id or execution.runtime_device_id or ""
        )
        owner_user_id = execution.executor_owner_user_id
        if not runtime_task_id or not execution_target_id or not owner_user_id:
            continue
        try:
            with httpx.Client(
                base_url=_robot_queue_internal_url(),
                timeout=5,
                trust_env=False,
            ) as client:
                response = client.post(
                    "/internal/robot-queue/emit-runtime-rpc",
                    headers={
                        "Authorization": f"Bearer {settings.INTERNAL_SERVICE_TOKEN}"
                    },
                    json={
                        "user_id": owner_user_id,
                        "device_id": execution_target_id,
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
                "[RobotQueue] Runtime cancel failed execution=%s",
                execution.id,
            )
    return confirmed_execution_ids


async def reconcile_device_executions(
    *,
    user_id: int,
    device_id: str,
    needs_confirmation_only: bool = False,
) -> int:
    """Reconcile active runs through the Executor's current local socket."""

    from app.core.socketio import get_sio
    from app.db.session import get_db_session

    with get_db_session() as db:
        executions = loop_item_execution_service.active_for_device_reconciliation(
            db,
            owner_user_id=user_id,
            runtime_device_id=device_id,
            needs_confirmation_only=needs_confirmation_only,
        )
        execution_refs = [
            (execution.id, execution.runtime_task_id) for execution in executions
        ]
    if not execution_refs:
        return 0

    online = await device_service.get_device_online_info(user_id, device_id)
    socket_id = (online or {}).get("socket_id") if online else None
    if not socket_id:
        return 0
    try:
        response = await get_sio().call(
            "runtime:rpc",
            {"method": "runtime.tasks.list", "payload": {}},
            to=socket_id,
            namespace="/local-executor",
            timeout=15,
        )
    except Exception:
        logger.exception(
            "[RobotQueue] Device reconciliation failed user=%s device=%s",
            user_id,
            device_id,
        )
        return 0
    if not isinstance(response, dict) or not response.get("success"):
        return 0

    snapshots: dict[str, dict] = {}
    for workspace in response.get("workspaces", []):
        if not isinstance(workspace, dict):
            continue
        for task in workspace.get("tasks", []):
            if not isinstance(task, dict):
                continue
            task_id = str(task.get("taskId") or task.get("task_id") or "")
            if task_id:
                snapshots[task_id] = task

    reconciled = 0
    with get_db_session() as db:
        for execution_id, runtime_task_id in execution_refs:
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
    return reconciled
