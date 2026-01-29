# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Device heartbeat monitor service.

This module provides a background task that monitors device heartbeats
and marks offline devices when heartbeat timeout occurs.

Uses distributed lock to ensure only one instance runs the monitor.
"""

import asyncio
import logging
from datetime import datetime, timedelta
from typing import Optional

from app.core.distributed_lock import distributed_lock
from app.db.session import SessionLocal
from app.services.chat.ws_emitter import get_ws_emitter
from shared.models.db.device import Device
from shared.models.db.enums import DeviceStatus
from shared.models.db.subtask import Subtask, SubtaskStatus

logger = logging.getLogger(__name__)

# Monitor configuration
MONITOR_INTERVAL_SECONDS = 60  # Check every 60 seconds
HEARTBEAT_TIMEOUT_SECONDS = 90  # Mark offline after 90 seconds without heartbeat
LOCK_EXPIRE_SECONDS = 30  # Distributed lock expiration

# Global flag to control the monitor loop
_monitor_running = False
_monitor_task: Optional[asyncio.Task] = None


async def check_and_mark_offline_devices() -> int:
    """
    Check for devices with expired heartbeats and mark them as offline.

    Also marks any running tasks on those devices as failed.

    Returns:
        Number of devices marked offline
    """
    db = SessionLocal()
    marked_count = 0

    try:
        timeout_threshold = datetime.now() - timedelta(
            seconds=HEARTBEAT_TIMEOUT_SECONDS
        )

        # Find devices that are online but haven't sent heartbeat
        timeout_devices = (
            db.query(Device)
            .filter(
                Device.status.in_([DeviceStatus.ONLINE, DeviceStatus.BUSY]),
                Device.last_heartbeat < timeout_threshold,
            )
            .all()
        )

        for device in timeout_devices:
            logger.warning(
                f"[DeviceMonitor] Device timeout: user_id={device.user_id}, "
                f"device_id={device.device_id}, last_heartbeat={device.last_heartbeat}"
            )

            # Mark device as offline
            device.status = DeviceStatus.OFFLINE
            device.updated_at = datetime.now()

            # Mark running tasks on this device as failed
            executor_name = f"device-{device.device_id}"
            running_subtasks = (
                db.query(Subtask)
                .filter(
                    Subtask.executor_name == executor_name,
                    Subtask.status == SubtaskStatus.RUNNING,
                )
                .all()
            )

            for subtask in running_subtasks:
                subtask.status = SubtaskStatus.FAILED
                subtask.error_message = "Device heartbeat timeout"
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

                logger.warning(
                    f"[DeviceMonitor] Marked subtask {subtask.id} as FAILED due to device timeout"
                )

            # Broadcast device offline event
            try:
                from app.core.socketio import get_sio

                sio = get_sio()
                await sio.emit(
                    "device:offline",
                    {"device_id": device.device_id},
                    room=f"user:{device.user_id}",
                    namespace="/chat",
                )
            except Exception as e:
                logger.error(f"[DeviceMonitor] Failed to broadcast device:offline: {e}")

            marked_count += 1

        if marked_count > 0:
            db.commit()
            logger.info(f"[DeviceMonitor] Marked {marked_count} devices as offline")

    except Exception as e:
        logger.error(f"[DeviceMonitor] Error checking device heartbeats: {e}")
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
                    await check_and_mark_offline_devices()
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
