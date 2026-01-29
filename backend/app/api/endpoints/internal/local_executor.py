# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Internal API endpoints for testing local executor mode.

These endpoints are intended for development and debugging purposes only.
"""

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.api.ws.local_executor_namespace import get_local_executor_namespace

logger = logging.getLogger(__name__)
router = APIRouter()


class TestTaskRequest(BaseModel):
    """Request model for dispatching a test task."""

    prompt: str
    anthropic_api_key: Optional[str] = None


class TestTaskResponse(BaseModel):
    """Response model for test task dispatch."""

    success: bool
    task_id: Optional[int] = None
    subtask_id: Optional[int] = None
    executor_sid: Optional[str] = None
    message: Optional[str] = None
    error: Optional[str] = None
    pending_tasks: Optional[int] = None


class ExecutorInfo(BaseModel):
    """Information about a connected executor."""

    sid: str
    executor_type: str
    platform: Optional[str] = None
    arch: Optional[str] = None
    version: Optional[str] = None
    capabilities: list = []
    hostname: Optional[str] = None
    workspace_root: Optional[str] = None
    registered_at: Optional[str] = None
    last_heartbeat: Optional[str] = None


class ExecutorsResponse(BaseModel):
    """Response model for listing connected executors."""

    count: int
    executors: list


@router.get("/executors", response_model=ExecutorsResponse)
async def list_executors():
    """
    List all connected local executors.

    Returns information about each connected executor including:
    - Socket ID
    - Platform and architecture
    - Capabilities
    - Last heartbeat time
    """
    namespace = get_local_executor_namespace()
    if not namespace:
        raise HTTPException(
            status_code=503, detail="Local executor namespace not initialized"
        )

    executors = namespace.get_connected_executors()
    return ExecutorsResponse(count=len(executors), executors=executors)


@router.post("/dispatch-test", response_model=TestTaskResponse)
async def dispatch_test_task(request: TestTaskRequest):
    """
    Dispatch a test task to a connected local executor.

    This endpoint is for testing the local executor flow. It creates a minimal
    task with the provided prompt and dispatches it to an available executor.

    Args:
        request: TestTaskRequest containing the prompt and optional API key

    Returns:
        TestTaskResponse with task ID and dispatch status
    """
    namespace = get_local_executor_namespace()
    if not namespace:
        raise HTTPException(
            status_code=503, detail="Local executor namespace not initialized"
        )

    # Build model environment if API key provided
    model_env = {}
    if request.anthropic_api_key:
        model_env["ANTHROPIC_API_KEY"] = request.anthropic_api_key

    # Dispatch the test task
    result = await namespace.dispatch_test_task(
        prompt=request.prompt, model_env=model_env
    )

    return TestTaskResponse(**result)


@router.get("/status")
async def get_status():
    """
    Get the status of the local executor system.

    Returns:
        Status information including namespace initialization and executor count.
    """
    namespace = get_local_executor_namespace()
    if not namespace:
        return {
            "initialized": False,
            "message": "Local executor namespace not initialized",
        }

    executors = namespace.get_connected_executors()
    pending_count = len(namespace._pending_tasks)

    return {
        "initialized": True,
        "executor_count": len(executors),
        "pending_task_count": pending_count,
        "executors": [
            {
                "sid": e.get("sid"),
                "executor_type": e.get("executor_type"),
                "hostname": e.get("hostname"),
                "capabilities": e.get("capabilities", []),
                "last_heartbeat": e.get("last_heartbeat"),
            }
            for e in executors
        ],
    }


@router.delete("/executors")
async def clear_all_executors():
    """
    Clear all registered executors (for development/debugging).

    This is useful when testing and there are stale executor entries
    from previous sessions that haven't properly disconnected.

    Returns:
        Number of executors cleared.
    """
    namespace = get_local_executor_namespace()
    if not namespace:
        raise HTTPException(
            status_code=503, detail="Local executor namespace not initialized"
        )

    count = len(namespace._executors)
    namespace._executors.clear()
    logger.info(f"Cleared {count} executor entries")

    return {"cleared": count, "message": f"Cleared {count} executor entries"}
