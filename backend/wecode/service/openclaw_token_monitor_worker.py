# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
OpenClaw token usage monitor background worker.

This module provides a background worker that periodically checks
token usage and sends daily reports and threshold alerts.
"""

import asyncio
import logging
import threading
from datetime import datetime, timedelta, timezone

from redis.asyncio import Redis

from app.core.config import settings

logger = logging.getLogger(__name__)

# Constants
MONITOR_INTERVAL_SECONDS = 600  # 10 minutes for threshold checks
DAILY_REPORT_HOUR = 9  # 9 AM
DAILY_REPORT_MINUTE = 0
MONITOR_LOCK_KEY = "openclaw_token_monitor:lock"
MONITOR_LOCK_EXPIRE_SECONDS = 600  # 10 minutes, same as interval

# Beijing timezone
BEIJING_TZ = timezone(timedelta(hours=8))


async def acquire_monitor_lock(redis_client: Redis) -> bool:
    """
    Try to acquire distributed lock for OpenClaw token monitor.

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
            logger.info("[openclaw-token-monitor] Acquired distributed lock")
        else:
            logger.debug(
                "[openclaw-token-monitor] Lock held by another instance, skipping"
            )
        return bool(acquired)
    except Exception as e:
        logger.error(f"[openclaw-token-monitor] Error acquiring lock: {e}")
        return False


async def release_monitor_lock(redis_client: Redis) -> bool:
    """
    Release distributed lock for OpenClaw token monitor.

    Args:
        redis_client: Redis client instance

    Returns:
        bool: Whether lock was successfully released
    """
    try:
        await redis_client.delete(MONITOR_LOCK_KEY)
        logger.info("[openclaw-token-monitor] Released distributed lock")
        return True
    except Exception as e:
        logger.error(f"[openclaw-token-monitor] Error releasing lock: {e}")
        return False


def _get_beijing_now() -> datetime:
    """Get current datetime in Beijing timezone."""
    return datetime.now(BEIJING_TZ)


def _should_send_daily_report() -> bool:
    """Check if it's time to send daily report (9:00 AM Beijing time)."""
    now = _get_beijing_now()
    return now.hour == DAILY_REPORT_HOUR and now.minute < 10


def openclaw_token_monitor_worker(stop_event: threading.Event):
    """
    Background worker that monitors OpenClaw token usage.

    - Every 10 minutes: Check threshold alerts (today's cumulative usage)
    - At 9:00 AM: Check and send yesterday's daily report (only once per day)

    Args:
        stop_event: Threading event to signal shutdown
    """
    logger.info("[openclaw-token-monitor] Worker started")

    # Track when we last checked daily report to avoid duplicate sends
    last_daily_report_check_hour: int = -1

    while not stop_event.is_set():
        try:
            # Run the async monitoring logic
            asyncio.run(_run_monitor_check(last_daily_report_check_hour))

            # Update last check hour if we checked at 9 AM
            now = _get_beijing_now()
            if now.hour == DAILY_REPORT_HOUR:
                last_daily_report_check_hour = now.hour
            elif now.hour == 0:
                # Reset at midnight
                last_daily_report_check_hour = -1

        except Exception as e:
            logger.exception(f"[openclaw-token-monitor] Error during check: {e}")

        # Wait for next interval or until stopped
        stop_event.wait(timeout=MONITOR_INTERVAL_SECONDS)

    logger.info("[openclaw-token-monitor] Worker stopped")


async def _run_monitor_check(last_daily_report_check_hour: int):
    """Run a single monitoring check."""
    from wecode.service.dingtalk_webhook import (
        DINGTALK_WEBHOOK_SECRET,
        DINGTALK_WEBHOOK_URL,
        DingTalkWebhookSender,
    )
    from wecode.service.openclaw_token_monitor_service import (
        check_and_send_daily_report,
        check_threshold_alerts,
    )

    # Check if OpenClaw token alert is enabled
    if not settings.OPENCLAW_TOKEN_ALERT_ENABLED:
        logger.debug("[openclaw-token-monitor] Alert is disabled, skipping check")
        return

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
            # Check webhook configuration
            if DINGTALK_WEBHOOK_URL.endswith("YOUR_TOKEN"):
                logger.warning(
                    "[openclaw-token-monitor] DingTalk webhook URL not configured. "
                    "Please update DINGTALK_WEBHOOK_URL in wecode/service/dingtalk_webhook.py"
                )
                return

            webhook_sender = DingTalkWebhookSender(
                webhook_url=DINGTALK_WEBHOOK_URL,
                secret=DINGTALK_WEBHOOK_SECRET,
            )

            # Check threshold alerts (always check every 10 minutes)
            threshold_sent = await check_threshold_alerts(redis_client, webhook_sender)
            if threshold_sent:
                logger.info("[openclaw-token-monitor] Threshold alerts sent")
            else:
                logger.debug("[openclaw-token-monitor] No threshold alerts needed")

            # Check daily report (only at 9 AM, once per day)
            now = _get_beijing_now()
            if _should_send_daily_report() and now.hour != last_daily_report_check_hour:
                report_sent = await check_and_send_daily_report(
                    redis_client, webhook_sender
                )
                if report_sent:
                    logger.info("[openclaw-token-monitor] Daily report sent")
                else:
                    logger.debug("[openclaw-token-monitor] Daily report not needed")
            else:
                logger.debug("[openclaw-token-monitor] Not time for daily report yet")

        finally:
            # Release the lock
            await release_monitor_lock(redis_client)

    finally:
        if redis_client:
            await redis_client.aclose()
