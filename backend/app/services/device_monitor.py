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
from datetime import datetime
from typing import Optional

from app.core.distributed_lock import distributed_lock
from app.db.session import SessionLocal
from app.services.chat.ws_emitter import get_ws_emitter
from app.services.device_service import device_service
from shared.models.db.subtask import Subtask, SubtaskStatus

logger = logging.getLogger(__name__)

# Monitor configuration
MONITOR_INTERVAL_SECONDS = 60  # Check every 60 seconds
LOCK_EXPIRE_SECONDS = 30  # Distributed lock expiration

# Global flag to control the monitor loop
_monitor_running = False
_monitor_task: Optional[asyncio.Task] = None


async def check_and_mark_failed_subtasks() -> int:
    """
    Check for running subtasks on devices that are no longer online.

    With Redis-based online status, a device is offline when its Redis key
    has expired. This function finds subtasks that are still RUNNING but
    their device is no longer in Redis.

    Returns:
        Number of subtasks marked as failed
    """
    db = SessionLocal()
    marked_count = 0

    try:
        # Find all running subtasks that are on local devices
        running_subtasks = (
            db.query(Subtask)
            .filter(
                Subtask.status == SubtaskStatus.RUNNING,
                Subtask.executor_name.like("device-%"),
            )
            .all()
        )

        # Group subtasks by user and device
        # executor_name format: "device-{device_id}"
        # executor_namespace format: "user-{user_id}"
        for subtask in running_subtasks:
            # Extract device_id from executor_name
            if not subtask.executor_name or not subtask.executor_name.startswith(
                "device-"
            ):
                continue

            device_id = subtask.executor_name[7:]  # Remove "device-" prefix

            # Extract user_id from executor_namespace
            if (
                not subtask.executor_namespace
                or not subtask.executor_namespace.startswith("user-")
            ):
                continue

            try:
                user_id = int(subtask.executor_namespace[5:])  # Remove "user-" prefix
            except ValueError:
                continue

            # Check if device is still online via Redis
            is_online = await device_service.is_device_online(user_id, device_id)

            if not is_online:
                logger.warning(
                    f"[DeviceMonitor] Device offline, failing subtask: "
                    f"user_id={user_id}, device_id={device_id}, subtask_id={subtask.id}"
                )

                # Mark subtask as failed
                subtask.status = SubtaskStatus.FAILED
                subtask.error_message = "Device connection lost (heartbeat timeout)"
                subtask.completed_at = datetime.now()

                # Emit error to task room
                ws_emitter = get_ws_emitter()
                if ws_emitter:
                    try:
                        await ws_emitter.emit_chat_error(
                            task_id=subtask.task_id,
                            subtask_id=subtask.id,
                            error="Device connection lost",
                            message_id=subtask.message_id,
                        )
                    except Exception as e:
                        logger.error(
                            f"[DeviceMonitor] Failed to emit chat:error for subtask {subtask.id}: {e}"
                        )

                marked_count += 1

        if marked_count > 0:
            db.commit()
            logger.info(
                f"[DeviceMonitor] Marked {marked_count} subtasks as failed due to device timeout"
            )

    except Exception as e:
        logger.error(f"[DeviceMonitor] Error checking subtasks: {e}")
        db.rollback()
    finally:
        db.close()

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
            # Use distributed lock to ensure only one instance runs
            with distributed_lock.acquire_context(
                "device_heartbeat_monitor", expire_seconds=LOCK_EXPIRE_SECONDS
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
