# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.schemas.subtask import SubtaskExecutorUpdate
from app.services.adapters.executor_kinds import executor_kinds_service
from app.services.streaming.executor_streaming import executor_streaming_service

router = APIRouter()


@router.post("/tasks/dispatch")
async def dispatch_tasks(
    task_status: str = Query(
        default="PENDING", description="Subtask status to filter by"
    ),
    limit: int = Query(
        default=1, ge=1, description="Maximum number of subtasks to return"
    ),
    task_ids: Optional[str] = Query(
        default=None, description="Optional task IDs to filter by, comma separated"
    ),
    type: str = Query(default="online", description="online or offline"),
    db: Session = Depends(get_db),
):
    """Task dispatch interface with subtask support using kinds table

    Args:
        status: Subtask status to filter by (PENDING, RUNNING, COMPLETED, FAILED, CANCELLED, DELETE)
        limit: Maximum number of subtasks to return
        task_ids: Optional task IDs to filter by, comma separated. If not provided, will search across all tasks
        type: Task type to filter by (default: "online")

    Returns:
        List of subtasks with aggregated context from previous subtasks
    """
    # Process task_ids parameter, convert comma-separated string to integer list
    task_id_list = None
    if task_ids:
        try:
            task_id_list = [int(tid.strip()) for tid in task_ids.split(",")]
        except ValueError:
            task_id_list = None

    return await executor_kinds_service.dispatch_tasks(
        db=db, status=task_status, limit=limit, task_ids=task_id_list, type=type
    )


@router.put("/tasks")
async def update_subtask(
    subtask_update: SubtaskExecutorUpdate, db: Session = Depends(get_db)
):
    """Update subtask status and automatically update associated task using kinds table

    Args:
        subtask_update: Subtask update information including status, progress, result, etc.

    Returns:
        Updated subtask information and task status
    """
    return await executor_kinds_service.update_subtask(
        db=db, subtask_update=subtask_update
    )


# ============================================================
# Chunk Callback Endpoint (Incremental Callback Mode)
# ============================================================


class ChunkUpdateRequest(BaseModel):
    """Request model for incremental chunk updates from executor manager."""

    task_id: int = Field(..., description="Task ID")
    subtask_id: int = Field(..., description="Subtask ID")
    chunk_type: str = Field(
        ..., description="Chunk type: chunk, thinking, reasoning, workbench_delta, status"
    )
    data: Dict[str, Any] = Field(..., description="Chunk data payload")
    executor_name: Optional[str] = Field(default=None, description="Executor name")
    executor_namespace: Optional[str] = Field(
        default=None, description="Executor namespace"
    )
    timestamp: Optional[str] = Field(default=None, description="ISO timestamp")


@router.post("/tasks/chunk")
async def receive_chunk(
    request: ChunkUpdateRequest,
    db: Session = Depends(get_db),
):
    """Receive incremental chunk updates from executor manager.

    This endpoint receives streaming updates from executors and:
    1. Caches content in Redis for fast recovery
    2. Broadcasts updates via WebSocket to connected clients
    3. Periodically persists to database

    Args:
        request: ChunkUpdateRequest containing chunk type and data

    Returns:
        Processing result
    """
    return await executor_streaming_service.process_chunk(
        db=db,
        task_id=request.task_id,
        subtask_id=request.subtask_id,
        chunk_type=request.chunk_type,
        data=request.data,
        executor_name=request.executor_name,
        timestamp=request.timestamp,
    )
