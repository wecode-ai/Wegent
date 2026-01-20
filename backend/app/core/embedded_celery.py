# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Embedded Celery Worker and Beat for running within the Backend process.

This module allows running Celery Worker and Beat as background threads
within the FastAPI application, eliminating the need for separate processes.

Usage:
    In FastAPI lifespan:
        from app.core.embedded_celery import start_embedded_celery, stop_embedded_celery

        @asynccontextmanager
        async def lifespan(app: FastAPI):
            start_embedded_celery()
            yield
            stop_embedded_celery()
"""

import logging
import threading
from typing import Optional

from celery import Celery

logger = logging.getLogger(__name__)

# Global references to threads and beat instance
_worker_thread: Optional[threading.Thread] = None
_beat_thread: Optional[threading.Thread] = None
_beat_instance = None  # Store Beat instance for graceful shutdown
_shutdown_event = threading.Event()


def _run_worker(app: Celery) -> None:
    """Run Celery worker in a thread."""
    try:
        logger.info("[EmbeddedCelery] Starting worker thread...")
        # Use solo pool for thread-based execution
        # concurrency=1 to avoid issues in embedded mode
        app.worker_main(
            argv=[
                "worker",
                "--loglevel=info",
                "--pool=solo",
                "--concurrency=1",
                "--without-heartbeat",
                "--without-gossip",
                "--without-mingle",
            ]
        )
    except Exception as e:
        if not _shutdown_event.is_set():
            logger.error(f"[EmbeddedCelery] Worker error: {e}")


def _run_beat(app: Celery) -> None:
    """Run Celery beat scheduler in a thread."""
    global _beat_instance
    try:
        logger.info("[EmbeddedCelery] Starting beat thread...")
        from celery.apps.beat import Beat

        beat = Beat(app=app, loglevel="INFO")
        _beat_instance = beat
        beat.run()
    except Exception as e:
        if not _shutdown_event.is_set():
            logger.error(f"[EmbeddedCelery] Beat error: {e}")
    finally:
        _beat_instance = None


def start_embedded_celery() -> None:
    """Start embedded Celery worker and beat as daemon threads."""
    global _worker_thread, _beat_thread

    from app.core.celery_app import celery_app

    _shutdown_event.clear()

    # Start worker thread
    _worker_thread = threading.Thread(
        target=_run_worker,
        args=(celery_app,),
        daemon=True,
        name="celery-worker",
    )
    _worker_thread.start()
    logger.info("[EmbeddedCelery] Worker thread started")

    # Start beat thread
    _beat_thread = threading.Thread(
        target=_run_beat,
        args=(celery_app,),
        daemon=True,
        name="celery-beat",
    )
    _beat_thread.start()
    logger.info("[EmbeddedCelery] Beat thread started")


def stop_embedded_celery(timeout: float = 10.0) -> None:
    """
    Gracefully stop embedded Celery worker and beat.

    This ensures that:
    1. Beat scheduler releases its Redis lock properly
    2. Worker completes current tasks before shutdown

    Args:
        timeout: Maximum seconds to wait for graceful shutdown
    """
    global _worker_thread, _beat_thread, _beat_instance

    logger.info("[EmbeddedCelery] Stopping embedded Celery...")
    _shutdown_event.set()

    # Step 1: Gracefully stop Beat scheduler to release Redis lock
    if _beat_instance is not None:
        try:
            logger.info("[EmbeddedCelery] Stopping beat scheduler gracefully...")
            # Access the service (scheduler) from Beat instance
            if hasattr(_beat_instance, "service") and _beat_instance.service:
                scheduler = _beat_instance.service.scheduler
                if scheduler and hasattr(scheduler, "lock"):
                    # Release the RedBeat lock before shutdown
                    try:
                        scheduler.lock.release()
                        logger.info("[EmbeddedCelery] Released RedBeat lock")
                    except Exception as e:
                        logger.warning(f"[EmbeddedCelery] Failed to release lock: {e}")
        except Exception as e:
            logger.warning(f"[EmbeddedCelery] Error during beat shutdown: {e}")

    # Step 2: Wait for threads to finish (with timeout)
    if _beat_thread and _beat_thread.is_alive():
        logger.info("[EmbeddedCelery] Waiting for beat thread to stop...")
        _beat_thread.join(timeout=timeout / 2)
        if _beat_thread.is_alive():
            logger.warning("[EmbeddedCelery] Beat thread did not stop gracefully")

    if _worker_thread and _worker_thread.is_alive():
        logger.info("[EmbeddedCelery] Waiting for worker thread to stop...")
        _worker_thread.join(timeout=timeout / 2)
        if _worker_thread.is_alive():
            logger.warning("[EmbeddedCelery] Worker thread did not stop gracefully")

    _worker_thread = None
    _beat_thread = None
    _beat_instance = None
    logger.info("[EmbeddedCelery] Embedded Celery stopped")


def is_celery_running() -> bool:
    """Check if embedded Celery is running."""
    return (
        _worker_thread is not None
        and _worker_thread.is_alive()
        and _beat_thread is not None
        and _beat_thread.is_alive()
    )
