# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.subtask import Subtask
from app.models.user import User
from app.schemas.subtask import SubtaskInDB, SubtaskListResponse, SubtaskUpdate
from app.services.subtask import subtask_service

router = APIRouter()


@router.get("", response_model=SubtaskListResponse)
def list_subtasks(
    task_id: int = Query(..., description="Task ID"),
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(10, ge=1, le=100, description="Items per page"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Get subtasks for a specific task (paginated)"""
    skip = (page - 1) * limit
    items = subtask_service.get_by_task(
        db=db, task_id=task_id, user_id=current_user.id, skip=skip, limit=limit
    )
    total = (
        db.query(Subtask)
        .filter(Subtask.task_id == task_id, Subtask.user_id == current_user.id)
        .count()
    )
    return {"total": total, "items": items}


@router.get("/{subtask_id}", response_model=SubtaskInDB)
def get_subtask(
    subtask_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Get specified subtask details"""
    return subtask_service.get_subtask_by_id(
        db=db, subtask_id=subtask_id, user_id=current_user.id
    )


@router.put("/{subtask_id}", response_model=SubtaskInDB)
def update_subtask(
    subtask_id: int,
    subtask_update: SubtaskUpdate,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Update subtask information"""
    return subtask_service.update_subtask(
        db=db, subtask_id=subtask_id, obj_in=subtask_update, user_id=current_user.id
    )


@router.delete("/{subtask_id}")
def delete_subtask(
    subtask_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Delete subtask"""
    subtask_service.delete_subtask(
        db=db, subtask_id=subtask_id, user_id=current_user.id
    )
    return {"message": "Subtask deleted successfully"}
