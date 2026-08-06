# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Background jobs for the application.
This module contains all background jobs that run periodically.

Note: Subscription scheduling has been migrated to Celery. See:
- app/core/celery_app.py - Celery configuration
- app/tasks/subscription_tasks.py - Subscription execution tasks
"""

import asyncio
import logging
import threading
import time
from datetime import datetime

from app.core.cache import cache_manager
from app.core.config import settings
from app.core.distributed_lock import distributed_lock
from app.db.session import AsyncSessionLocal
from app.services.adapters.executor_job import job_service
from app.services.executor_cleanup_cursor_service import EXECUTOR_CLEANUP_CURSOR_KEY
from app.services.repository_job import repository_job_service

logger = logging.getLogger(__name__)

# Redis lock key name and expiration time for repository update job
REPO_UPDATE_LOCK_KEY = "repository_update_lock"
REPO_UPDATE_LOCK_KEY_INTERVAL = settings.REPO_UPDATE_INTERVAL_SECONDS - 10
if REPO_UPDATE_LOCK_KEY_INTERVAL < 10:
    REPO_UPDATE_LOCK_KEY_INTERVAL = 10

EXECUTOR_CLEANUP_LOCK_KEY = "executor_cleanup_lock"


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


async def _cleanup_recently_executed() -> bool:
    """Check if executor cleanup was recently executed by any pod."""
    try:
        payload = await cache_manager.get(EXECUTOR_CLEANUP_CURSOR_KEY)
        if not isinstance(payload, dict):
            return False
        updated_at_str = payload.get("updated_at")
        if not updated_at_str:
            return False
        updated_at = datetime.fromisoformat(updated_at_str)
        elapsed = (datetime.now() - updated_at).total_seconds()
        if elapsed < settings.TASK_EXECUTOR_CLEANUP_INTERVAL_SECONDS:
            logger.info(
                "[job] Executor cleanup recently executed %.0fs ago, skipping",
                elapsed,
            )
            return True
    except Exception as e:
        logger.warning(f"[job] Failed to check cleanup cursor: {e}")
    return False


async def cleanup_worker(stop_event: asyncio.Event):
    """
    Async background worker for cleaning up stale executors.

    Args:
        stop_event: Event to signal the worker to stop
    """
    while not stop_event.is_set():
        try:
            if await _cleanup_recently_executed():
                pass
            else:
                async with distributed_lock.acquire_watchdog_context_async(
                    EXECUTOR_CLEANUP_LOCK_KEY,
                    expire_seconds=300,
                    extend_interval_seconds=60,
                ) as acquired:
                    if not acquired:
                        logger.info(
                            "[job] Another instance is executing executor cleanup, skipping this execution"
                        )
                    else:
                        async with AsyncSessionLocal() as db:
                            await job_service.cleanup_stale_executors(db)
        except Exception as e:
            logger.error(f"[job] cleanup stale executors error: {e}")

        try:
            await asyncio.wait_for(
                stop_event.wait(),
                timeout=settings.TASK_EXECUTOR_CLEANUP_INTERVAL_SECONDS,
            )
        except asyncio.TimeoutError:
            pass


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

                    # Run the repository update job asynchronously
                    loop.run_until_complete(
                        repository_job_service.update_repositories_for_all_users()
                    )

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


def start_background_jobs(app):
    """
    Start all background jobs

    Args:
        app: FastAPI application instance
    """
    # Start cleanup async task
    app.state.cleanup_stop_event = asyncio.Event()
    app.state.cleanup_task = asyncio.create_task(
        cleanup_worker(app.state.cleanup_stop_event)
    )
    logger.info("[job] cleanup stale executors worker started (async)")

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

    # Note: Subscription scheduler is now handled by Celery Beat
    # Start celery worker and beat separately:
    # - celery -A app.core.celery_app worker --loglevel=info
    # - celery -A app.core.celery_app beat --loglevel=info


async def stop_background_jobs(app):
    """
    Stop all background jobs

    Args:
        app: FastAPI application instance
    """
    # Stop cleanup async task
    stop_event = getattr(app.state, "cleanup_stop_event", None)
    cleanup_task = getattr(app.state, "cleanup_task", None)
    if stop_event:
        stop_event.set()
    if cleanup_task:
        cleanup_task.cancel()
        try:
            await cleanup_task
        except asyncio.CancelledError:
            pass
    logger.info("[job] cleanup stale executors worker stopped")

    # Stop repository update thread gracefully
    repo_stop_event = getattr(app.state, "repo_update_stop_event", None)
    repo_thread = getattr(app.state, "repo_update_thread", None)
    if repo_stop_event:
        repo_stop_event.set()
    if repo_thread:
        repo_thread.join(timeout=5.0)
    logger.info("[job] repository update worker stopped")

    # Note: Subscription scheduler is now handled by Celery Beat
    # Celery worker/beat are managed separately
