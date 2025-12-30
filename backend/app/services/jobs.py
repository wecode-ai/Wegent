# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Background jobs for the application.
This module contains all background jobs that run periodically.
"""

import asyncio
import logging
import threading
from datetime import datetime, timedelta

from app.core.cache import cache_manager
from app.core.config import settings
from app.db.session import SessionLocal
from app.services.adapters.executor_job import job_service
from app.services.repository_job import repository_job_service

logger = logging.getLogger(__name__)

# Redis lock key name and expiration time for repository update job
REPO_UPDATE_LOCK_KEY = "repository_update_lock"
REPO_UPDATE_LOCK_KEY_INTERVAL = settings.REPO_UPDATE_INTERVAL_SECONDS - 10
if REPO_UPDATE_LOCK_KEY_INTERVAL < 10:
    REPO_UPDATE_LOCK_KEY_INTERVAL = 10

# Redis lock keys for unread notification jobs
HOURLY_NOTIFICATION_LOCK_KEY = "hourly_notification_lock"
DAILY_NOTIFICATION_LOCK_KEY = "daily_notification_lock"


async def acquire_repo_update_lock() -> bool:
    """
    Try to acquire distributed lock to ensure only one instance executes the task
    Use Redis SETNX command to implement distributed lock

    Returns:
        bool: Whether lock was successfully acquired
    """
    try:
        acquired = await cache_manager.setnx(
            REPO_UPDATE_LOCK_KEY, True, expire=REPO_UPDATE_LOCK_KEY_INTERVAL
        )
        if acquired:
            logger.info(
                f"[job] Successfully acquired distributed lock: {REPO_UPDATE_LOCK_KEY}"
            )
        else:
            logger.info(
                f"[job] Failed to acquire distributed lock, lock is held by another instance: {REPO_UPDATE_LOCK_KEY}"
            )
        return acquired
    except Exception as e:
        logger.error(f"[job] Error acquiring distributed lock: {str(e)}")
        return False


async def release_repo_update_lock() -> bool:
    """
    Release distributed lock

    Returns:
        bool: Whether lock was successfully released
    """
    try:
        return await cache_manager.delete(REPO_UPDATE_LOCK_KEY)
    except Exception as e:
        logger.error(f"[job] Error releasing lock: {str(e)}")
        return False


def cleanup_worker(stop_event: threading.Event):
    """
    Background worker for cleaning up stale executors

    Args:
        stop_event: Event to signal the worker to stop
    """
    # Periodically scan and cleanup stale executors for subtasks
    while not stop_event.is_set():
        try:
            db = SessionLocal()
            try:
                job_service.cleanup_stale_executors(db)
            finally:
                db.close()
        except Exception as e:
            # Log and continue loop
            logger.error(f"[job] cleanup stale executors error: {e}")
        # Wait with wake-up capability
        stop_event.wait(timeout=settings.TASK_EXECUTOR_CLEANUP_INTERVAL_SECONDS)


def repo_update_worker(stop_event: threading.Event):
    """
    Background worker for updating git repositories cache

    Args:
        stop_event: Event to signal the worker to stop
    """
    # Periodically update git repositories cache for all users
    while not stop_event.is_set():
        try:
            # Create async runtime
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)

            # Try to acquire distributed lock
            lock_acquired = loop.run_until_complete(acquire_repo_update_lock())

            if not lock_acquired:
                logger.info(
                    "[job] Another instance is executing repository cache update task, skipping this execution"
                )
            else:
                try:
                    logger.info("[job] Starting repository cache update task")

                    db = SessionLocal()
                    try:
                        # Run the repository update job asynchronously
                        loop.run_until_complete(
                            repository_job_service.update_repositories_for_all_users(db)
                        )
                    finally:
                        db.close()

                    logger.info(
                        "[job] Repository cache update task execution completed"
                    )
                except Exception as e:
                    # Log error but continue loop
                    logger.error(
                        f"[job] Error executing repository cache update task: {str(e)}"
                    )
                finally:
                    # Release lock
                    try:
                        loop.run_until_complete(release_repo_update_lock())
                        logger.info("[job] Distributed lock released")
                    except Exception as e:
                        logger.error(f"[job] Error releasing lock: {str(e)}")

            # Close async runtime
            loop.close()
        except Exception as e:
            # Log and continue loop
            logger.error(f"[job] repository update worker error: {e}")
        # Wait with wake-up capability
        logger.info(
            f"[job] Repository cache update task will execute again after {settings.REPO_UPDATE_INTERVAL_SECONDS} seconds"
        )
        stop_event.wait(timeout=settings.REPO_UPDATE_INTERVAL_SECONDS)


def _calculate_seconds_until_next_hour() -> float:
    """Calculate seconds until the next hour starts."""
    now = datetime.now()
    next_hour = now.replace(minute=0, second=0, microsecond=0)
    if now.minute > 0 or now.second > 0:
        from datetime import timedelta

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
    from datetime import timedelta

    now = datetime.now()
    morning_hour = settings.MORNING_SUMMARY_HOUR  # default 9
    evening_hour = settings.DAILY_SUMMARY_HOUR  # default 18

    morning_time = now.replace(hour=morning_hour, minute=0, second=0, microsecond=0)
    evening_time = now.replace(hour=evening_hour, minute=0, second=0, microsecond=0)

    # Determine next run time and hours to look back
    if now < morning_time:
        # Before 9:00 today, next run is 9:00 today
        # Look back 15 hours (from previous day 18:00 to today 9:00)
        return (morning_time - now).total_seconds(), 15
    elif now < evening_time:
        # Between 9:00 and 18:00, next run is 18:00 today
        # Look back 9 hours (from 9:00 to 18:00)
        return (evening_time - now).total_seconds(), 9
    else:
        # After 18:00 today, next run is 9:00 tomorrow
        # Look back 15 hours (from today 18:00 to tomorrow 9:00)
        tomorrow_morning = morning_time + timedelta(days=1)
        return (tomorrow_morning - now).total_seconds(), 15


async def acquire_notification_lock(lock_key: str, expire: int = 3600) -> bool:
    """
    Try to acquire distributed lock for notification job.

    Args:
        lock_key: Lock key name
        expire: Lock expiration time in seconds

    Returns:
        bool: Whether lock was successfully acquired
    """
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


async def release_notification_lock(lock_key: str) -> bool:
    """Release notification distributed lock."""
    try:
        return await cache_manager.delete(lock_key)
    except Exception as e:
        logger.error(f"[job] Error releasing notification lock {lock_key}: {str(e)}")
        return False


def hourly_notification_worker(stop_event: threading.Event):
    """
    Background worker for sending hourly Dingtalk notifications.
    Runs at the beginning of each hour.

    Args:
        stop_event: Event to signal the worker to stop
    """
    from app.services.notification.unread_notification import (
        get_unread_notification_service,
    )

    # Wait until the next hour to start
    initial_wait = _calculate_seconds_until_next_hour()
    logger.info(
        f"[job] Hourly notification worker waiting {initial_wait:.0f} seconds until next hour"
    )
    if stop_event.wait(timeout=initial_wait):
        return  # Stop event was set

    while not stop_event.is_set():
        try:
            # Create async runtime
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)

            # Try to acquire distributed lock (expires in 1 hour)
            lock_acquired = loop.run_until_complete(
                acquire_notification_lock(HOURLY_NOTIFICATION_LOCK_KEY, expire=3600)
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
                            release_notification_lock(HOURLY_NOTIFICATION_LOCK_KEY)
                        )
                    except Exception as e:
                        logger.error(f"[job] Error releasing hourly lock: {str(e)}")

            loop.close()
        except Exception as e:
            logger.error(f"[job] Hourly notification worker error: {e}")

        # Wait until the next hour
        wait_time = _calculate_seconds_until_next_hour()
        logger.info(
            f"[job] Hourly notification will run again in {wait_time:.0f} seconds"
        )
        stop_event.wait(timeout=wait_time)


def daily_notification_worker(stop_event: threading.Event):
    """
    Background worker for sending daily group chat summary email.
    Runs at 9:00 and 18:00.

    Args:
        stop_event: Event to signal the worker to stop
    """
    from app.services.notification.group_chat_summary import (
        get_group_chat_summary_service,
    )

    while not stop_event.is_set():
        # Calculate wait time and hours to look back
        initial_wait, hours_back = _calculate_seconds_until_daily_summary()
        next_run_time = datetime.now().replace(microsecond=0) + timedelta(
            seconds=initial_wait
        )
        logger.info(
            f"[job] Daily notification worker waiting {initial_wait:.0f} seconds until {next_run_time.strftime('%Y-%m-%d %H:%M')}"
        )
        if stop_event.wait(timeout=initial_wait):
            return  # Stop event was set

        # Recalculate hours_back after waiting (in case we're now at the target time)
        now = datetime.now()
        morning_hour = settings.MORNING_SUMMARY_HOUR
        evening_hour = settings.DAILY_SUMMARY_HOUR
        if now.hour == morning_hour:
            hours_back = 15  # 18:00 yesterday to 9:00 today
        else:
            hours_back = 9  # 9:00 to 18:00 today

        try:
            # Create async runtime
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)

            # Try to acquire distributed lock (expires in 1 hour)
            lock_acquired = loop.run_until_complete(
                acquire_notification_lock(DAILY_NOTIFICATION_LOCK_KEY, expire=3600)
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
                finally:
                    try:
                        loop.run_until_complete(
                            release_notification_lock(DAILY_NOTIFICATION_LOCK_KEY)
                        )
                    except Exception as e:
                        logger.error(f"[job] Error releasing daily lock: {str(e)}")

            loop.close()
        except Exception as e:
            logger.error(f"[job] Daily notification worker error: {e}")


def start_background_jobs(app):
    """
    Start all background jobs

    Args:
        app: FastAPI application instance
    """
    # Start cleanup thread
    app.state.cleanup_stop_event = threading.Event()
    app.state.cleanup_thread = threading.Thread(
        target=cleanup_worker,
        args=(app.state.cleanup_stop_event,),
        name="subtask-cleanup-worker",
        daemon=True,
    )
    app.state.cleanup_thread.start()
    logger.info("[job] cleanup stale executors worker started")

    # Start repository update thread
    app.state.repo_update_stop_event = threading.Event()
    app.state.repo_update_thread = threading.Thread(
        target=repo_update_worker,
        args=(app.state.repo_update_stop_event,),
        name="repository-update-worker",
        daemon=True,
    )
    app.state.repo_update_thread.start()
    logger.info("[job] repository update worker started")

    # Start hourly Dingtalk notification worker (if enabled)
    if settings.HOURLY_DINGTALK_NOTIFICATION_ENABLED:
        app.state.hourly_notification_stop_event = threading.Event()
        app.state.hourly_notification_thread = threading.Thread(
            target=hourly_notification_worker,
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
            target=daily_notification_worker,
            args=(app.state.daily_notification_stop_event,),
            name="daily-notification-worker",
            daemon=True,
        )
        app.state.daily_notification_thread.start()
        logger.info("[job] daily email summary worker started")
    else:
        logger.info("[job] daily email summary worker disabled by configuration")


def stop_background_jobs(app):
    """
    Stop all background jobs

    Args:
        app: FastAPI application instance
    """
    # Stop cleanup thread gracefully
    stop_event = getattr(app.state, "cleanup_stop_event", None)
    thread = getattr(app.state, "cleanup_thread", None)
    if stop_event:
        stop_event.set()
    if thread:
        thread.join(timeout=5.0)
    logger.info("[job] cleanup stale executors worker stopped")

    # Stop repository update thread gracefully
    repo_stop_event = getattr(app.state, "repo_update_stop_event", None)
    repo_thread = getattr(app.state, "repo_update_thread", None)
    if repo_stop_event:
        repo_stop_event.set()
    if repo_thread:
        repo_thread.join(timeout=5.0)
    logger.info("[job] repository update worker stopped")

    # Stop hourly notification thread gracefully
    hourly_stop_event = getattr(app.state, "hourly_notification_stop_event", None)
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
