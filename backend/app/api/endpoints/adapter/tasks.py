# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging
from typing import Optional

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.core.config import settings
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.user import User
from app.schemas.task import (
    TaskCreate,
    TaskDetail,
    TaskInDB,
    TaskListResponse,
    TaskLiteListResponse,
    TaskUpdate,
)
from app.services.adapters.task_kinds import task_kinds_service

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


async def call_chat_shell_cancel(subtask_id: int, partial_content: str = ""):
    """Background task to cancel Chat Shell streaming via session manager"""
    try:
        from app.services.chat.session_manager import session_manager
        
        success = await session_manager.cancel_stream(subtask_id)
        if success:
            logger.info(f"Chat Shell stream cancelled successfully for subtask {subtask_id}")
        else:
            logger.warning(f"Failed to cancel Chat Shell stream for subtask {subtask_id}")
    except Exception as e:
        logger.error(
            f"Error cancelling Chat Shell stream for subtask {subtask_id}: {str(e)}"
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
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Get current user's task list (paginated), excluding DELETE status tasks"""
    skip = (page - 1) * limit
    items, total = task_kinds_service.get_user_tasks_with_pagination(
        db=db, user_id=current_user.id, skip=skip, limit=limit
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
    """Cancel a running task by calling executor_manager or Chat Shell cancel"""
    from app.models.kind import Kind
    from app.schemas.kind import Task
    
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

    # Check if this is a Chat Shell task by looking at the source label
    is_chat_shell = False
    task_kind = (
        db.query(Kind)
        .filter(
            Kind.id == task_id,
            Kind.user_id == current_user.id,
            Kind.kind == "Task",
            Kind.is_active == True,
        )
        .first()
    )
    
    if task_kind and task_kind.json:
        task_crd = Task.model_validate(task_kind.json)
        if task_crd.metadata.labels:
            source = task_crd.metadata.labels.get("source", "")
            is_chat_shell = source == "chat_shell"
    
    logger.info(f"Task {task_id} is_chat_shell={is_chat_shell}")

    if is_chat_shell:
        # For Chat Shell tasks, find the running subtask and cancel via session manager
        running_subtask = (
            db.query(Subtask)
            .filter(
                Subtask.task_id == task_id,
                Subtask.user_id == current_user.id,
                Subtask.role == SubtaskRole.ASSISTANT,
                Subtask.status == SubtaskStatus.RUNNING,
            )
            .first()
        )
        
        if running_subtask:
            # Cancel the Chat Shell stream
            background_tasks.add_task(call_chat_shell_cancel, running_subtask.id)
            
            # Update subtask status to COMPLETED (not CANCELLED, to show partial content)
            from datetime import datetime
            running_subtask.status = SubtaskStatus.COMPLETED
            running_subtask.progress = 100
            running_subtask.completed_at = datetime.now()
            running_subtask.updated_at = datetime.now()
            running_subtask.error_message = ""
            db.commit()
            
            # Update task status to COMPLETED (not CANCELLING, for Chat Shell)
            try:
                task_kinds_service.update_task(
                    db=db,
                    task_id=task_id,
                    obj_in=TaskUpdate(status="COMPLETED"),
                    user_id=current_user.id,
                )
                logger.info(
                    f"Chat Shell task {task_id} cancelled and marked as COMPLETED"
                )
            except Exception as e:
                logger.error(f"Failed to update Chat Shell task {task_id} status: {str(e)}")
            
            return {"message": "Chat stopped successfully", "status": "COMPLETED"}
        else:
            # No running subtask found, just mark task as completed
            try:
                task_kinds_service.update_task(
                    db=db,
                    task_id=task_id,
                    obj_in=TaskUpdate(status="COMPLETED"),
                    user_id=current_user.id,
                )
            except Exception as e:
                logger.error(f"Failed to update task {task_id} status: {str(e)}")
            
            return {"message": "No running stream to cancel", "status": "COMPLETED"}
    else:
        # For non-Chat Shell tasks, use executor_manager
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
