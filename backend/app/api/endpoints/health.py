# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
During graceful shutdown:
- /health returns 200 (app is still alive)
- /ready returns 503 (stop sending new traffic)
- /startup returns 200 (startup is complete)

Shutdown is process-owned and can only be initiated by the application
lifecycle. Public HTTP routes never mutate shutdown state.
"""

import asyncio

from fastapi import APIRouter, Response
from sqlalchemy import text

from app.core.event_loop_monitor import event_loop_lag_monitor
from app.core.shutdown import shutdown_manager
from app.db.session import SessionLocal
from app.services.channels.worker_client import channel_worker_client
from app.services.chat.storage.db import run_sync_in_executor
from app.services.execution.stream_client import stream_execution_client

router = APIRouter()

_STREAM_READINESS_TIMEOUT_SECONDS = 1.0


def _check_database_readiness_sync() -> None:
    """Check storage from a worker-owned session and release it immediately."""

    db = SessionLocal()
    try:
        db.execute(text("SELECT 1"))
    finally:
        db.close()


@router.get("/health")
def health_check():
    """
    This endpoint checks if the application is alive and responding.
    It should return 200 even during graceful shutdown (app is still alive,
    just not accepting new traffic).
    Returns:
        dict: Health status with details
    """
    lag = event_loop_lag_monitor.snapshot()
    return {
        "status": "healthy",
        "shutting_down": shutdown_manager.is_shutting_down,
        "event_loop_lag_seconds": round(lag.last_seconds, 6),
        "max_event_loop_lag_seconds": round(lag.max_seconds, 6),
        "event_loop_lag_threshold_breaches": lag.threshold_breaches,
    }


@router.get("/ready")
async def readiness_check(response: Response):
    """
    This endpoint checks if the application is ready to receive traffic.
    Returns 503 during graceful shutdown to stop receiving new requests.
    Returns:
        dict: Readiness status
    """
    # During shutdown, return 503 to stop receiving new traffic
    if shutdown_manager.is_shutting_down:
        response.status_code = 503
        return {
            "status": "shutting_down",
            "message": "Service is shutting down, not accepting new traffic",
            "active_streams": shutdown_manager.get_active_stream_count(),
            "shutdown_duration": shutdown_manager.shutdown_duration,
        }

    try:
        await run_sync_in_executor(_check_database_readiness_sync)
        await asyncio.wait_for(
            stream_execution_client.ping(),
            timeout=_STREAM_READINESS_TIMEOUT_SECONDS,
        )
        await asyncio.wait_for(
            channel_worker_client.ping(),
            timeout=_STREAM_READINESS_TIMEOUT_SECONDS,
        )
        return {
            "status": "ready",
        }
    except Exception as e:
        response.status_code = 503
        return {
            "status": "not_ready",
            "message": f"Service not ready: {str(e)}",
        }


@router.get("/startup")
def startup_check():
    return {"status": "started"}


@router.get("/shutdown/status")
def shutdown_status(response: Response):
    """
    Get current shutdown status.

    Returns:
        dict: Current shutdown state information
    """
    if shutdown_manager.is_shutting_down:
        response.status_code = 503
        return {
            "status": "shutting_down",
            "message": "Service is shutting down, not accepting new traffic",
        }
    return {"is_shutting_down": shutdown_manager.is_shutting_down}
