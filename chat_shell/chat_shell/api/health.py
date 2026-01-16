# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Health check endpoints for Kubernetes deployments.

During graceful shutdown:
- /health returns 200 (app is still alive)
- /ready returns 503 (stop sending new traffic)
- /startup returns 200 (startup is complete)
- /shutdown/initiate (POST) triggers graceful shutdown manually
- /shutdown/wait (POST) waits for streams to complete (for preStop hook)
- /shutdown/reset (POST) resets shutdown state to restore 200
"""

import logging

from fastapi import APIRouter, Response

from chat_shell.core.config import settings
from chat_shell.core.shutdown import shutdown_manager

router = APIRouter(tags=["health"])
logger = logging.getLogger(__name__)


@router.get("/health")
async def health_check():
    """
    Liveness probe endpoint.

    This endpoint checks if the application is alive and responding.
    It should return 200 even during graceful shutdown (app is still alive,
    just not accepting new traffic).

    Returns:
        dict: Health status with details
    """
    from chat_shell import __version__

    return {
        "status": "healthy",
        "version": __version__,
        "shutting_down": shutdown_manager.is_shutting_down,
        "active_streams": shutdown_manager.get_active_stream_count(),
    }


@router.get("/ready")
async def readiness_check(response: Response):
    """
    Readiness probe endpoint.

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

    return {
        "status": "ready",
        "active_streams": shutdown_manager.get_active_stream_count(),
    }


@router.get("/startup")
async def startup_check():
    """
    Startup probe endpoint.

    This endpoint indicates that the application has started successfully.

    Returns:
        dict: Startup status
    """
    return {"status": "started"}


@router.post("/shutdown/initiate")
async def initiate_shutdown():
    """
    Manually initiate graceful shutdown.

    This endpoint can be called to trigger graceful shutdown before
    the pod is terminated.

    After calling this endpoint:
    - /ready will return 503 (stop receiving new traffic)
    - /health will still return 200 (app is alive)
    - Active streaming requests will be allowed to complete

    Returns:
        dict: Shutdown initiation status
    """
    if shutdown_manager.is_shutting_down:
        return {
            "status": "already_shutting_down",
            "message": "Shutdown was already initiated",
            "active_streams": shutdown_manager.get_active_stream_count(),
            "shutdown_duration": shutdown_manager.shutdown_duration,
        }

    await shutdown_manager.initiate_shutdown()

    return {
        "status": "shutdown_initiated",
        "message": "Graceful shutdown initiated. /ready will now return 503.",
        "active_streams": shutdown_manager.get_active_stream_count(),
    }


@router.get("/shutdown/status")
async def shutdown_status(response: Response):
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
            "active_streams": shutdown_manager.get_active_stream_count(),
            "shutdown_duration": shutdown_manager.shutdown_duration,
        }

    return {
        "is_shutting_down": False,
        "active_streams": shutdown_manager.get_active_stream_count(),
    }


@router.post("/shutdown/wait")
async def wait_for_shutdown():
    """
    Wait for all active streams to complete during graceful shutdown.

    This endpoint is designed for Kubernetes preStop hooks. It will:
    1. Initiate shutdown if not already initiated
    2. Wait for all active streams to complete (up to GRACEFUL_SHUTDOWN_TIMEOUT)
    3. Return when all streams are done or timeout is reached

    Usage in Kubernetes preStop hook:
    ```yaml
    preStop:
      exec:
        command:
          - /bin/sh
          - -c
          - curl -X POST http://localhost:8001/shutdown/wait || true
    ```

    Returns:
        dict: Shutdown completion status
    """
    # Import here to avoid circular imports
    from chat_shell.api.v1.response import _active_streams

    # Initiate shutdown if not already
    if not shutdown_manager.is_shutting_down:
        await shutdown_manager.initiate_shutdown()

    active_streams = shutdown_manager.get_active_stream_count()

    if active_streams == 0:
        return {
            "status": "completed",
            "message": "No active streams, shutdown can proceed immediately",
            "active_streams": 0,
            "waited_seconds": 0,
        }

    # Wait for streams to complete
    timeout = settings.GRACEFUL_SHUTDOWN_TIMEOUT
    streams_completed = await shutdown_manager.wait_for_streams(timeout=timeout)

    if streams_completed:
        return {
            "status": "completed",
            "message": "All streams completed successfully",
            "active_streams": 0,
            "waited_seconds": shutdown_manager.shutdown_duration,
        }
    else:
        # Timeout reached, cancel remaining streams
        remaining = shutdown_manager.get_active_stream_count()
        cancelled = await shutdown_manager.cancel_all_streams(_active_streams)

        return {
            "status": "timeout",
            "message": f"Timeout reached after {timeout}s. Cancelled {cancelled} remaining streams.",
            "active_streams": remaining,
            "cancelled_streams": cancelled,
            "waited_seconds": shutdown_manager.shutdown_duration,
        }


@router.post("/shutdown/reset")
async def reset_shutdown():
    """
    Reset shutdown state to restore normal operation.

    This endpoint resets the shutdown flag, allowing /ready to return 200 again.
    Useful for testing or recovering from an accidental shutdown initiation.

    WARNING: This should only be used for testing or emergency recovery.
    In production, a pod in shutdown state should be terminated and replaced.

    Returns:
        dict: Reset status
    """
    was_shutting_down = shutdown_manager.is_shutting_down
    shutdown_manager.reset()

    return {
        "status": "reset_complete",
        "message": "Shutdown state reset. /ready will now return 200.",
        "was_shutting_down": was_shutting_down,
    }
