# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Optional
from fastapi import APIRouter, Depends, status, Query
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.schemas.task import TaskCreate, TaskUpdate, TaskInDB, TaskDetail, TaskListResponse
from app.services.adapters.task_kinds import task_kinds_service

router = APIRouter()


@router.post("", response_model=dict)
def create_task_id(
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db)
):
    """Create new task with session id and return task_id"""
    return {"task_id": task_kinds_service.create_task_id(db=db, user_id=current_user.id)}

@router.post("/create", response_model=TaskInDB, status_code=status.HTTP_201_CREATED)
def create_task_with_optional_id(
    task_create: TaskCreate,
    task_id: Optional[int] = None,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db)
):
    """Create new task with optional task_id in parameters"""
    return task_kinds_service.create_task_or_append(db=db, obj_in=task_create, user=current_user, task_id=task_id)

@router.post("/{task_id}", response_model=TaskInDB, status_code=status.HTTP_201_CREATED)
def create_task_with_id(
    task_id: int,
    task_create: TaskCreate,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db)
):
    """Create new task with specified task_id"""
    return task_kinds_service.create_task_or_append(db=db, obj_in=task_create, user=current_user, task_id=task_id)

@router.get("", response_model=TaskListResponse)
def get_tasks(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(10, ge=1, le=100, description="Items per page"),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db)
):
    """Get current user's task list (paginated), excluding DELETE status tasks"""
    skip = (page - 1) * limit
    items, total = task_kinds_service.get_user_tasks_with_pagination(
        db=db,
        user_id=current_user.id,
        skip=skip,
        limit=limit
    )
    return {"total": total, "items": items}

@router.get("/search", response_model=TaskListResponse)
def search_tasks_by_title(
    title: str = Query(..., min_length=1, description="Search by task title keywords"),
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(10, ge=1, le=100, description="Items per page"),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db)
):
    """Fuzzy search tasks by title for current user (pagination), excluding DELETE status"""
    skip = (page - 1) * limit
    items, total = task_kinds_service.get_user_tasks_by_title_with_pagination(
        db=db,
        user_id=current_user.id,
        title=title,
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
    return task_kinds_service.get_task_detail(db=db, task_id=task_id, user_id=current_user.id)

@router.put("/{task_id}", response_model=TaskInDB)
def update_task(
    task_id: int,
    task_update: TaskUpdate,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db)
):
    """Update task information"""
    return task_kinds_service.update_task(
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
    task_kinds_service.delete_task(db=db, task_id=task_id, user_id=current_user.id)
    return {"message": "Task deleted successfully"}