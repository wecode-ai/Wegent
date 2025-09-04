# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from fastapi import APIRouter, Depends, status, Query
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.schemas.task import TaskCreate, TaskUpdate, TaskInDB, TaskDetail, TaskListResponse
from app.services.task import task_service

router = APIRouter()

@router.post("", response_model=TaskInDB, status_code=status.HTTP_201_CREATED)
def create_task(
    task_create: TaskCreate,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db)
):
    """Create new task"""
    return task_service.create_with_user(db=db, obj_in=task_create, user=current_user)

@router.get("", response_model=TaskListResponse)
def get_tasks(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(10, ge=1, le=100, description="Items per page"),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db)
):
    """Get current user's task list (paginated), excluding DELETE status tasks"""
    skip = (page - 1) * limit
    items, total = task_service.get_user_tasks_with_pagination(
        db=db,
        user_id=current_user.id,
        skip=skip,
        limit=limit
    )
    return {"total": total, "items": items}

@router.get("/{task_id}", response_model=TaskDetail)
def get_task(
    task_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db)
):
    """Get specified task details with related entities"""
    return task_service.get_task_detail(db=db, task_id=task_id, user_id=current_user.id)

@router.put("/{task_id}", response_model=TaskInDB)
def update_task(
    task_id: int,
    task_update: TaskUpdate,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db)
):
    """Update task information"""
    return task_service.update_with_user(
        db=db,
        task_id=task_id,
        obj_in=task_update,
        user_id=current_user.id
    )

@router.delete("/{task_id}")
def delete_task(
    task_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db)
):
    """Delete task"""
    task_service.delete_with_user(db=db, task_id=task_id, user_id=current_user.id)
    return {"message": "Task deleted successfully"}