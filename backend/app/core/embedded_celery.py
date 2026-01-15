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

# Global references to threads
_worker_thread: Optional[threading.Thread] = None
_beat_thread: Optional[threading.Thread] = None
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
    try:
        logger.info("[EmbeddedCelery] Starting beat thread...")
        from celery.apps.beat import Beat

        beat = Beat(app=app, loglevel="INFO")
        beat.run()
    except Exception as e:
        if not _shutdown_event.is_set():
            logger.error(f"[EmbeddedCelery] Beat error: {e}")


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


def stop_embedded_celery() -> None:
    """Signal embedded Celery to stop."""
    global _worker_thread, _beat_thread

    logger.info("[EmbeddedCelery] Stopping embedded Celery...")
    _shutdown_event.set()

    # The threads are daemon threads, so they will be killed when the main process exits
    # We don't need to explicitly join them

    _worker_thread = None
    _beat_thread = None
    logger.info("[EmbeddedCelery] Embedded Celery stopped")


def is_celery_running() -> bool:
    """Check if embedded Celery is running."""
    return (
        _worker_thread is not None
        and _worker_thread.is_alive()
        and _beat_thread is not None
        and _beat_thread.is_alive()
    )
