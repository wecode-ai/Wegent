# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Cloud device monitor background worker.

This module provides a background worker that periodically checks
the online status of cloud devices and sends notifications.
"""

import asyncio
import logging
import threading
from datetime import datetime

logger = logging.getLogger(__name__)

MONITOR_INTERVAL_SECONDS = 600  # 10 minutes
MONITOR_LOCK_KEY = "cloud_device_monitor:lock"
MONITOR_LOCK_EXPIRE_SECONDS = 600  # 10 minutes, same as interval


async def acquire_monitor_lock(redis_client) -> bool:
    """
    Try to acquire distributed lock for cloud device monitor.

    Args:
        redis_client: Redis client instance

    Returns:
        bool: Whether lock was successfully acquired
    """
    try:
        acquired = await redis_client.set(
            MONITOR_LOCK_KEY, "1", nx=True, ex=MONITOR_LOCK_EXPIRE_SECONDS
        )
        if acquired:
            logger.info("[cloud-device-monitor] Acquired distributed lock")
        else:
            logger.info(
                "[cloud-device-monitor] Lock held by another instance, skipping"
            )
        return bool(acquired)
    except Exception as e:
        logger.error(f"[cloud-device-monitor] Error acquiring lock: {e}")
        return False


async def release_monitor_lock(redis_client) -> bool:
    """
    Release distributed lock for cloud device monitor.

    Args:
        redis_client: Redis client instance

    Returns:
        bool: Whether lock was successfully released
    """
    try:
        await redis_client.delete(MONITOR_LOCK_KEY)
        logger.info("[cloud-device-monitor] Released distributed lock")
        return True
    except Exception as e:
        logger.error(f"[cloud-device-monitor] Error releasing lock: {e}")
        return False


def cloud_device_monitor_worker(stop_event: threading.Event):
    """
    Background worker that monitors cloud device status every 10 minutes.

    Args:
        stop_event: Threading event to signal shutdown
    """
    logger.info("[cloud-device-monitor] Worker started")

    while not stop_event.is_set():
        try:
            # Run the async monitoring logic
            asyncio.run(_run_monitor_check())
        except Exception as e:
            logger.exception(f"[cloud-device-monitor] Error during check: {e}")

        # Wait for next interval or until stopped
        stop_event.wait(timeout=MONITOR_INTERVAL_SECONDS)

    logger.info("[cloud-device-monitor] Worker stopped")


async def _run_monitor_check():
    """Run a single monitoring check."""
    from redis.asyncio import Redis

    from app.core.config import settings
    from app.db.session import get_db_session
    from wecode.service.cloud_device_monitor_service import (
        check_cloud_devices_status,
        send_monitoring_report,
    )
    from wecode.service.dingtalk_webhook import (
        DINGTALK_WEBHOOK_URL,
        DINGTALK_WEBHOOK_SECRET,
        DingTalkWebhookSender,
    )

    redis_client = None
    try:
        redis_client = Redis.from_url(
            settings.REDIS_URL,
            encoding="utf-8",
            decode_responses=True,
        )

        # Try to acquire distributed lock
        lock_acquired = await acquire_monitor_lock(redis_client)
        if not lock_acquired:
            return  # Another instance is handling this check

        try:
            with get_db_session() as db:
                result = await check_cloud_devices_status(db, redis_client)

            logger.info(
                f"[cloud-device-monitor] Check completed: "
                f"total={result['total']}, online={result['online_count']}, "
                f"offline={result['offline_count']}, "
                f"new_offline={len(result['new_offline'])}, "
                f"recovered={len(result['recovered'])}"
            )

            # Send notification if there are offline devices or changes
            should_notify = (
                result["offline_count"] > 0
                or result["new_offline"]
                or result["recovered"]
            )

            if should_notify:
                # Check if webhook URL is configured
                if DINGTALK_WEBHOOK_URL.endswith("YOUR_TOKEN"):
                    logger.warning(
                        "[cloud-device-monitor] DingTalk webhook URL not configured. "
                        "Please update DINGTALK_WEBHOOK_URL in "
                        "wecode/service/dingtalk_webhook.py"
                    )
                else:
                    webhook_sender = DingTalkWebhookSender(
                        webhook_url=DINGTALK_WEBHOOK_URL,
                        secret=DINGTALK_WEBHOOK_SECRET,
                    )
                    success = await send_monitoring_report(
                        redis_client, result, webhook_sender
                    )
                    if success:
                        logger.info(
                            "[cloud-device-monitor] Monitoring report sent successfully"
                        )
                    else:
                        logger.error(
                            "[cloud-device-monitor] Failed to send monitoring report"
                        )
            else:
                logger.info(
                    "[cloud-device-monitor] No offline devices or changes, "
                    "skipping notification"
                )
        finally:
            # Release the distributed lock
            await release_monitor_lock(redis_client)

    finally:
        if redis_client:
            await redis_client.aclose()
