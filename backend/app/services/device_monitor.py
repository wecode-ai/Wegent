# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Device heartbeat monitor service.

This module provides a background task that monitors device heartbeats
and marks running subtasks as failed when the device's Redis key expires.

With the CRD-based device model:
- Device registration is stored in kinds table
- Online status is managed via Redis with TTL (90s)
- When Redis key expires, device is considered offline
- This monitor checks for orphaned running subtasks and marks them failed
"""

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Optional

from app.core.distributed_lock import distributed_lock
from app.db.session import SessionLocal
from app.services.device_service import device_service
from app.services.execution.dispatcher import execution_dispatcher
from app.services.execution.emitters import WebSocketResultEmitter
from app.stores.tasks import subtask_store
from shared.models import ExecutionRequest
from shared.models.db.subtask import SubtaskStatus

logger = logging.getLogger(__name__)

# Monitor configuration
MONITOR_INTERVAL_SECONDS = 60  # Check every 60 seconds
LOCK_EXPIRE_SECONDS = 30  # Distributed lock expiration

# Global flag to control the monitor loop
_monitor_running = False
_monitor_task: Optional[asyncio.Task] = None


@dataclass(frozen=True)
class _RunningDeviceSubtask:
    subtask_id: int
    task_id: int
    message_id: int
    user_id: int
    device_id: str


def _list_running_device_subtasks() -> list[_RunningDeviceSubtask]:
    """Load device subtask metadata in a worker thread."""
    db = SessionLocal()
    try:
        candidates: list[_RunningDeviceSubtask] = []
        for subtask in subtask_store.list_running_device_subtasks(db):
            executor_name = subtask.executor_name or ""
            executor_namespace = subtask.executor_namespace or ""
            if not executor_name.startswith("device-"):
                continue
            if not executor_namespace.startswith("user-"):
                continue
            try:
                user_id = int(executor_namespace[5:])
            except ValueError:
                continue
            candidates.append(
                _RunningDeviceSubtask(
                    subtask_id=subtask.id,
                    task_id=subtask.task_id,
                    message_id=subtask.message_id,
                    user_id=user_id,
                    device_id=executor_name[7:],
                )
            )
        return candidates
    finally:
        db.close()


def _mark_subtasks_failed(
    candidates: list[_RunningDeviceSubtask],
) -> set[int]:
    """Persist device-timeout failures in a worker thread."""
    db = SessionLocal()
    marked_ids: set[int] = set()
    try:
        for candidate in candidates:
            subtask = subtask_store.get_basic_by_id(
                db,
                subtask_id=candidate.subtask_id,
                owner_user_id=candidate.user_id,
            )
            if subtask is None or subtask.status != SubtaskStatus.RUNNING:
                continue
            subtask_store.update_fields(
                db,
                subtask=subtask,
                status=SubtaskStatus.FAILED,
                error_message="Device connection lost (heartbeat timeout)",
                completed_at=datetime.now(),
            )
            marked_ids.add(candidate.subtask_id)
        if marked_ids:
            db.commit()
        return marked_ids
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


async def _emit_device_timeout(candidate: _RunningDeviceSubtask) -> None:
    """Notify clients after a device subtask is marked failed."""
    request = ExecutionRequest(
        task_id=candidate.task_id,
        subtask_id=candidate.subtask_id,
        prompt="",
        user_id=candidate.user_id,
        message_id=candidate.message_id,
    )
    emitter = WebSocketResultEmitter(
        task_id=candidate.task_id,
        subtask_id=candidate.subtask_id,
        user_id=candidate.user_id,
    )
    await execution_dispatcher.error(
        request=request,
        error_message="Device connection lost",
        emitter=emitter,
    )


async def check_and_mark_failed_subtasks() -> int:
    """
    Check for running subtasks on devices that are no longer online.

    With Redis-based online status, a device is offline when its Redis key
    has expired. This function finds subtasks that are still RUNNING but
    their device is no longer in Redis.

    Returns:
        Number of subtasks marked as failed
    """
    try:
        candidates = await asyncio.to_thread(_list_running_device_subtasks)
        offline_candidates = [
            candidate
            for candidate in candidates
            if not await device_service.is_device_online(
                candidate.user_id, candidate.device_id
            )
        ]
        if not offline_candidates:
            return 0
        marked_ids = await asyncio.to_thread(
            _mark_subtasks_failed,
            offline_candidates,
        )

    except Exception as e:
        logger.error(f"[DeviceMonitor] Error checking subtasks: {e}")
        return 0

    for candidate in offline_candidates:
        if candidate.subtask_id not in marked_ids:
            continue
        logger.warning(
            "[DeviceMonitor] Device offline, failing subtask: "
            "user_id=%s, device_id=%s, subtask_id=%s",
            candidate.user_id,
            candidate.device_id,
            candidate.subtask_id,
        )
        try:
            await _emit_device_timeout(candidate)
        except Exception as e:
            logger.error(
                "[DeviceMonitor] Failed to emit error for subtask %s: %s",
                candidate.subtask_id,
                e,
            )

    marked_count = len(marked_ids)
    if marked_count:
        logger.info(
            "[DeviceMonitor] Marked %s subtasks as failed due to device timeout",
            marked_count,
        )
    return marked_count


async def monitor_device_heartbeat() -> None:
    """
    Background task to monitor device heartbeats.

    Uses distributed lock to ensure only one instance runs this task.
    Runs continuously until stopped.
    """
    global _monitor_running

    logger.info("[DeviceMonitor] Starting device heartbeat monitor")

    while _monitor_running:
        try:
            async with distributed_lock.acquire_watchdog_context_async(
                "device_heartbeat_monitor",
                expire_seconds=LOCK_EXPIRE_SECONDS,
                extend_interval_seconds=10,
            ) as acquired:
                if acquired:
                    await check_and_mark_failed_subtasks()
                else:
                    logger.debug(
                        "[DeviceMonitor] Another instance is running the monitor"
                    )

        except Exception as e:
            logger.error(f"[DeviceMonitor] Unexpected error in monitor loop: {e}")

        # Wait before next check
        await asyncio.sleep(MONITOR_INTERVAL_SECONDS)

    logger.info("[DeviceMonitor] Device heartbeat monitor stopped")


def start_device_monitor() -> None:
    """Start the device heartbeat monitor as a background task."""
    global _monitor_running, _monitor_task

    if _monitor_running:
        logger.warning("[DeviceMonitor] Monitor already running")
        return

    _monitor_running = True
    _monitor_task = asyncio.create_task(monitor_device_heartbeat())
    logger.info("[DeviceMonitor] Device heartbeat monitor started")


def stop_device_monitor() -> None:
    """Stop the device heartbeat monitor."""
    global _monitor_running, _monitor_task

    if not _monitor_running:
        logger.warning("[DeviceMonitor] Monitor not running")
        return

    _monitor_running = False

    if _monitor_task:
        _monitor_task.cancel()
        try:
            # Don't await in sync context
            pass
        except Exception:
            pass
        _monitor_task = None

    logger.info("[DeviceMonitor] Device heartbeat monitor stopping")


async def stop_device_monitor_async() -> None:
    """Async version of stop_device_monitor for graceful shutdown."""
    global _monitor_running, _monitor_task

    if not _monitor_running:
        return

    _monitor_running = False

    if _monitor_task:
        _monitor_task.cancel()
        try:
            await _monitor_task
        except asyncio.CancelledError:
            pass
        _monitor_task = None

    logger.info("[DeviceMonitor] Device heartbeat monitor stopped (async)")
