# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Private background jobs registration.

Auto-applies on import. Registers notification and evaluation grading
monitor workers with the background jobs system via monkey-patching.
"""

import asyncio
import logging
import threading
from datetime import datetime, timedelta

logger = logging.getLogger(__name__)

_patch_applied = False

# Redis lock keys for notification jobs
HOURLY_NOTIFICATION_LOCK_KEY = "hourly_notification_lock"
DAILY_NOTIFICATION_LOCK_KEY = "daily_notification_lock"


def _calculate_seconds_until_next_hour() -> float:
    """Calculate seconds until the next hour starts."""
    now = datetime.now()
    next_hour = now.replace(minute=0, second=0, microsecond=0)
    if now.minute > 0 or now.second > 0:
        next_hour = next_hour + timedelta(hours=1)
    return (next_hour - now).total_seconds()


def _calculate_seconds_until_daily_summary() -> tuple[float, int]:
    """
    Calculate seconds until the next summary time (9:00 or 18:00).

    Returns:
        Tuple of (seconds_until_next_run, hours_to_look_back)
        - hours_to_look_back: 9 for morning run (9:00, looking back to previous 18:00)
                               15 for evening run (18:00, looking back to 9:00)
    """
    from app.core.config import settings

    now = datetime.now()
    morning_hour = settings.MORNING_SUMMARY_HOUR  # default 9
    evening_hour = settings.DAILY_SUMMARY_HOUR  # default 18

    morning_time = now.replace(hour=morning_hour, minute=0, second=0, microsecond=0)
    evening_time = now.replace(hour=evening_hour, minute=0, second=0, microsecond=0)

    if now < morning_time:
        return (morning_time - now).total_seconds(), 15
    elif now < evening_time:
        return (evening_time - now).total_seconds(), 9
    else:
        tomorrow_morning = morning_time + timedelta(days=1)
        return (tomorrow_morning - now).total_seconds(), 15


async def _acquire_notification_lock(lock_key: str, expire: int = 3600) -> bool:
    """Try to acquire distributed lock for notification job."""
    from app.core.cache import cache_manager

    try:
        acquired = await cache_manager.setnx(lock_key, True, expire=expire)
        if acquired:
            logger.info(f"[job] Successfully acquired notification lock: {lock_key}")
        else:
            logger.info(
                f"[job] Failed to acquire notification lock, held by another instance: {lock_key}"
            )
        return acquired
    except Exception as e:
        logger.error(f"[job] Error acquiring notification lock {lock_key}: {str(e)}")
        return False


async def _release_notification_lock(lock_key: str) -> bool:
    """Release notification distributed lock."""
    from app.core.cache import cache_manager

    try:
        return await cache_manager.delete(lock_key)
    except Exception as e:
        logger.error(f"[job] Error releasing notification lock {lock_key}: {str(e)}")
        return False


def _hourly_notification_worker(stop_event: threading.Event):
    """
    Background worker for sending hourly Dingtalk notifications.
    Runs at the beginning of each hour.
    """
    from app.core.config import settings
    from app.db.session import SessionLocal
    from app.services.notification.unread_notification import (
        get_unread_notification_service,
    )

    # Wait until the next hour to start
    initial_wait = _calculate_seconds_until_next_hour()
    logger.info(
        f"[job] Hourly notification worker waiting {initial_wait:.0f} seconds until next hour"
    )
    if stop_event.wait(timeout=initial_wait):
        return

    while not stop_event.is_set():
        try:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)

            lock_acquired = loop.run_until_complete(
                _acquire_notification_lock(HOURLY_NOTIFICATION_LOCK_KEY, expire=3600)
            )

            if not lock_acquired:
                logger.info(
                    "[job] Another instance is handling hourly notifications, skipping"
                )
            else:
                try:
                    logger.info("[job] Starting hourly notification task")
                    notification_service = get_unread_notification_service()

                    db = SessionLocal()
                    try:
                        count = loop.run_until_complete(
                            notification_service.send_hourly_dingtalk_notifications(db)
                        )
                        logger.info(
                            f"[job] Hourly notification task completed, sent {count} notifications"
                        )
                    finally:
                        db.close()
                except Exception as e:
                    logger.error(f"[job] Error in hourly notification task: {str(e)}")
                finally:
                    try:
                        loop.run_until_complete(
                            _release_notification_lock(HOURLY_NOTIFICATION_LOCK_KEY)
                        )
                    except Exception as e:
                        logger.error(f"[job] Error releasing hourly lock: {str(e)}")

            loop.close()
        except Exception as e:
            logger.error(f"[job] Hourly notification worker error: {e}")

        wait_time = _calculate_seconds_until_next_hour()
        logger.info(
            f"[job] Hourly notification will run again in {wait_time:.0f} seconds"
        )
        stop_event.wait(timeout=wait_time)


def _daily_notification_worker(stop_event: threading.Event):
    """
    Background worker for sending daily group chat summary email.
    Runs at 9:00 and 18:00.
    """
    from app.core.config import settings
    from app.db.session import SessionLocal
    from app.services.notification.group_chat_summary import (
        get_group_chat_summary_service,
    )

    while not stop_event.is_set():
        initial_wait, hours_back = _calculate_seconds_until_daily_summary()
        next_run_time = datetime.now().replace(microsecond=0) + timedelta(
            seconds=initial_wait
        )
        logger.info(
            f"[job] Daily notification worker waiting {initial_wait:.0f} seconds until {next_run_time.strftime('%Y-%m-%d %H:%M')}"
        )
        if stop_event.wait(timeout=initial_wait):
            return

        now = datetime.now()
        morning_hour = settings.MORNING_SUMMARY_HOUR
        evening_hour = settings.DAILY_SUMMARY_HOUR
        if now.hour == morning_hour:
            hours_back = 15
        else:
            hours_back = 9

        try:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)

            lock_acquired = loop.run_until_complete(
                _acquire_notification_lock(DAILY_NOTIFICATION_LOCK_KEY, expire=3600)
            )

            if not lock_acquired:
                logger.info(
                    "[job] Another instance is handling daily summary, skipping"
                )
            else:
                try:
                    logger.info(
                        f"[job] Starting daily group chat summary task, looking back {hours_back} hours"
                    )
                    summary_service = get_group_chat_summary_service()

                    db = SessionLocal()
                    try:
                        count = loop.run_until_complete(
                            summary_service.send_daily_summary(
                                db, hours_back=hours_back
                            )
                        )
                        logger.info(
                            f"[job] Daily group chat summary completed, sent {count} emails"
                        )
                    finally:
                        db.close()
                except Exception as e:
                    logger.error(f"[job] Error in daily summary task: {str(e)}")

            loop.close()
        except Exception as e:
            logger.error(f"[job] Daily notification worker error: {e}")


def _evaluation_grading_monitor_worker(stop_event: threading.Event):
    """
    Background worker for monitoring and recovering stuck evaluation grading tasks.
    """
    from app.core.config import settings
    from app.db.session import SessionLocal
    from wecode.service.evaluation.grading_monitor import GradingTaskMonitor

    monitor = GradingTaskMonitor(
        stuck_timeout_minutes=settings.EVAL_GRADING_STUCK_TIMEOUT_MINUTES
    )

    while not stop_event.is_set():
        try:
            db = SessionLocal()
            try:
                recovered_count = monitor.run_check(db)
                if recovered_count > 0:
                    db.commit()
                    logger.info(
                        f"[job] Evaluation grading monitor recovered {recovered_count} stuck tasks"
                    )
            finally:
                db.close()
        except Exception as e:
            logger.error(f"[job] Evaluation grading monitor error: {e}")

        stop_event.wait(timeout=settings.EVAL_GRADING_MONITOR_INTERVAL_SECONDS)


def apply_patch():
    """Register notification and evaluation grading monitor workers."""
    global _patch_applied

    if _patch_applied:
        return

    try:
        from app.core.config import settings
        from app.services import jobs

        original_start = jobs.start_background_jobs
        original_stop = jobs.stop_background_jobs

        def patched_start(app):
            original_start(app)

            # Start hourly Dingtalk notification worker (if enabled)
            if settings.HOURLY_DINGTALK_NOTIFICATION_ENABLED:
                app.state.hourly_notification_stop_event = threading.Event()
                app.state.hourly_notification_thread = threading.Thread(
                    target=_hourly_notification_worker,
                    args=(app.state.hourly_notification_stop_event,),
                    name="hourly-notification-worker",
                    daemon=True,
                )
                app.state.hourly_notification_thread.start()
                logger.info("[job] hourly Dingtalk notification worker started")
            else:
                logger.info(
                    "[job] hourly Dingtalk notification worker disabled by configuration"
                )

            # Start daily email summary worker (if enabled)
            if settings.DAILY_EMAIL_SUMMARY_ENABLED:
                app.state.daily_notification_stop_event = threading.Event()
                app.state.daily_notification_thread = threading.Thread(
                    target=_daily_notification_worker,
                    args=(app.state.daily_notification_stop_event,),
                    name="daily-notification-worker",
                    daemon=True,
                )
                app.state.daily_notification_thread.start()
                logger.info("[job] daily email summary worker started")
            else:
                logger.info(
                    "[job] daily email summary worker disabled by configuration"
                )

            # Start evaluation grading task monitor (if enabled)
            if settings.EVAL_GRADING_MONITOR_ENABLED:
                app.state.eval_grading_monitor_stop_event = threading.Event()
                app.state.eval_grading_monitor_thread = threading.Thread(
                    target=_evaluation_grading_monitor_worker,
                    args=(app.state.eval_grading_monitor_stop_event,),
                    name="eval-grading-monitor-worker",
                    daemon=True,
                )
                app.state.eval_grading_monitor_thread.start()
                logger.info(
                    f"[job] evaluation grading monitor started "
                    f"(interval: {settings.EVAL_GRADING_MONITOR_INTERVAL_SECONDS}s, "
                    f"timeout: {settings.EVAL_GRADING_STUCK_TIMEOUT_MINUTES}min)"
                )
            else:
                logger.info(
                    "[job] evaluation grading monitor disabled by configuration"
                )

        async def patched_stop(app):
            # Stop hourly notification thread gracefully
            hourly_stop_event = getattr(
                app.state, "hourly_notification_stop_event", None
            )
            hourly_thread = getattr(app.state, "hourly_notification_thread", None)
            if hourly_stop_event:
                hourly_stop_event.set()
            if hourly_thread:
                hourly_thread.join(timeout=5.0)
                logger.info("[job] hourly notification worker stopped")

            # Stop daily notification thread gracefully
            daily_stop_event = getattr(app.state, "daily_notification_stop_event", None)
            daily_thread = getattr(app.state, "daily_notification_thread", None)
            if daily_stop_event:
                daily_stop_event.set()
            if daily_thread:
                daily_thread.join(timeout=5.0)
                logger.info("[job] daily notification worker stopped")

            # Stop evaluation grading monitor thread gracefully
            eval_stop = getattr(app.state, "eval_grading_monitor_stop_event", None)
            eval_thread = getattr(app.state, "eval_grading_monitor_thread", None)
            if eval_stop:
                eval_stop.set()
            if eval_thread:
                eval_thread.join(timeout=5.0)
                logger.info("[job] evaluation grading monitor worker stopped")

            # Call original stop (which is async)
            await original_stop(app)

        jobs.start_background_jobs = patched_start
        jobs.stop_background_jobs = patched_stop

        _patch_applied = True
        logger.info("[JobsPatch] Successfully applied")

    except Exception as e:
        logger.error(f"[JobsPatch] Failed to apply: {e}")


# Auto-apply on import
apply_patch()
