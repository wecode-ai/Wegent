# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging
from typing import Optional

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.core.config import settings
from app.models.user import User
from app.schemas.sse import StreamTaskCreate
from app.schemas.task import (
    TaskCreate,
    TaskDetail,
    TaskInDB,
    TaskListResponse,
    TaskLiteListResponse,
    TaskUpdate,
)
from app.services.adapters.task_kinds import task_kinds_service
from app.services.task_streaming import task_streaming_service

router = APIRouter()
logger = logging.getLogger(__name__)


async def call_executor_cancel(task_id: int):
    """Background task to call executor_manager cancel API"""
    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                settings.EXECUTOR_CANCEL_TASK_URL,
                json={"task_id": task_id},
                timeout=60.0,
            )
            response.raise_for_status()
            logger.info(f"Task {task_id} cancelled successfully via executor_manager")
    except Exception as e:
        logger.error(
            f"Error calling executor_manager to cancel task {task_id}: {str(e)}"
        )


@router.post("", response_model=dict)
def create_task_id(
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Create new task with session id and return task_id"""
    return {
        "task_id": task_kinds_service.create_task_id(db=db, user_id=current_user.id)
    }


@router.post("/create", response_model=TaskInDB, status_code=status.HTTP_201_CREATED)
def create_task_with_optional_id(
    task_create: TaskCreate,
    task_id: Optional[int] = None,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Create new task with optional task_id in parameters"""
    return task_kinds_service.create_task_or_append(
        db=db, obj_in=task_create, user=current_user, task_id=task_id
    )


@router.post("/stream")
async def create_and_stream_task(
    stream_request: StreamTaskCreate,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Create and execute a task with SSE streaming response.

    Returns a Server-Sent Events stream with real-time task execution progress.
    Compatible with Dify Workflow SSE event format.

    Event types:
    - workflow_started: Task execution started
    - node_started: Bot/Subtask started execution
    - node_finished: Bot/Subtask completed
    - workflow_finished: Task execution completed
    - error: Execution error occurred
    - ping: Keep-alive ping
    """
    # Convert StreamTaskCreate to TaskCreate
    task_create = TaskCreate(
        team_id=stream_request.team_id,
        team_name=stream_request.team_name,
        team_namespace=stream_request.team_namespace,
        prompt=stream_request.prompt,
        title=stream_request.title,
        type=stream_request.type,
        task_type=stream_request.task_type,
        model_id=stream_request.model_id,
        force_override_bot_model=stream_request.force_override_bot_model,
        git_url=stream_request.git_url,
        git_repo=stream_request.git_repo,
        git_repo_id=stream_request.git_repo_id,
        git_domain=stream_request.git_domain,
        branch_name=stream_request.branch_name,
    )

    # Create the task
    task_result = task_kinds_service.create_task_or_append(
        db=db, obj_in=task_create, user=current_user, task_id=None
    )
    task_id = task_result["id"]

    logger.info(f"Created streaming task {task_id} for user {current_user.id}")

    # Return SSE streaming response
    return StreamingResponse(
        task_streaming_service.stream_task_execution(
            db=db,
            task_id=task_id,
            user_id=current_user.id,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # Disable nginx buffering
        },
    )


@router.get("/stream/{task_id}")
async def stream_existing_task(
    task_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Stream execution progress for an existing task.

    Useful for reconnecting to a task stream after disconnection.
    """
    # Verify task exists and belongs to user
    task = task_kinds_service.get_task_by_id(
        db=db, task_id=task_id, user_id=current_user.id
    )
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    logger.info(f"Streaming existing task {task_id} for user {current_user.id}")

    return StreamingResponse(
        task_streaming_service.stream_task_execution(
            db=db,
            task_id=task_id,
            user_id=current_user.id,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/{task_id}", response_model=TaskInDB, status_code=status.HTTP_201_CREATED)
def create_task_with_id(
    task_id: int,
    task_create: TaskCreate,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Create new task with specified task_id"""
    return task_kinds_service.create_task_or_append(
        db=db, obj_in=task_create, user=current_user, task_id=task_id
    )


@router.get("", response_model=TaskListResponse)
def get_tasks(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(10, ge=1, le=100, description="Items per page"),
    team_id: Optional[int] = Query(None, description="Filter by team ID"),
    task_type: Optional[str] = Query(None, description="Filter by task type (chat/code)"),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Get current user's task list (paginated), excluding DELETE status tasks.

    Supports optional filtering by team_id and task_type.
    """
    skip = (page - 1) * limit
    items, total = task_kinds_service.get_user_tasks_with_pagination(
        db=db,
        user_id=current_user.id,
        skip=skip,
        limit=limit,
        team_id=team_id,
        task_type=task_type,
    )
    return {"total": total, "items": items}


@router.get("/lite", response_model=TaskLiteListResponse)
def get_tasks_lite(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(10, ge=1, le=100, description="Items per page"),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Get current user's lightweight task list (paginated) for fast loading, excluding DELETE status tasks"""
    skip = (page - 1) * limit
    items, total = task_kinds_service.get_user_tasks_lite(
        db=db, user_id=current_user.id, skip=skip, limit=limit
    )
    return {"total": total, "items": items}


@router.get("/search", response_model=TaskListResponse)
def search_tasks_by_title(
    title: str = Query(..., min_length=1, description="Search by task title keywords"),
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(10, ge=1, le=100, description="Items per page"),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Fuzzy search tasks by title for current user (pagination), excluding DELETE status"""
    skip = (page - 1) * limit
    items, total = task_kinds_service.get_user_tasks_by_title_with_pagination(
        db=db, user_id=current_user.id, title=title, skip=skip, limit=limit
    )
    return {"total": total, "items": items}


@router.get("/{task_id}", response_model=TaskDetail)
def get_task(
    task_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Get specified task details with related entities"""
    return task_kinds_service.get_task_detail(
        db=db, task_id=task_id, user_id=current_user.id
    )


@router.put("/{task_id}", response_model=TaskInDB)
def update_task(
    task_id: int,
    task_update: TaskUpdate,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Update task information"""
    return task_kinds_service.update_task(
        db=db, task_id=task_id, obj_in=task_update, user_id=current_user.id
    )


@router.delete("/{task_id}")
def delete_task(
    task_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Delete task"""
    task_kinds_service.delete_task(db=db, task_id=task_id, user_id=current_user.id)
    return {"message": "Task deleted successfully"}


@router.post("/{task_id}/cancel")
async def cancel_task(
    task_id: int,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Cancel a running task by calling executor_manager"""
    # Verify user owns this task
    task = task_kinds_service.get_task_detail(
        db=db, task_id=task_id, user_id=current_user.id
    )
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    # Check if task is already in a final state
    current_status = task.get("status", "")
    final_states = ["COMPLETED", "FAILED", "CANCELLED", "DELETE"]

    if current_status in final_states:
        logger.warning(
            f"Task {task_id} is already in final state {current_status}, cannot cancel"
        )
        raise HTTPException(
            status_code=400,
            detail=f"Task is already {current_status.lower()}, cannot cancel",
        )

    # Check if task is already being cancelled
    if current_status == "CANCELLING":
        logger.info(f"Task {task_id} is already being cancelled")
        return {"message": "Task is already being cancelled", "status": "CANCELLING"}

    # Update task status to CANCELLING immediately
    try:
        task_kinds_service.update_task(
            db=db,
            task_id=task_id,
            obj_in=TaskUpdate(status="CANCELLING"),
            user_id=current_user.id,
        )
        logger.info(
            f"Task {task_id} status updated to CANCELLING by user {current_user.id}"
        )
    except Exception as e:
        logger.error(f"Failed to update task {task_id} status to CANCELLING: {str(e)}")
        raise HTTPException(
            status_code=500, detail=f"Failed to update task status: {str(e)}"
        )

    # Call executor_manager in the background
    background_tasks.add_task(call_executor_cancel, task_id)

    return {"message": "Cancel request accepted", "status": "CANCELLING"}
