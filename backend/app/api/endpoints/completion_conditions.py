# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Completion Conditions API endpoints
"""
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.schemas.completion_condition import (
    CompletionConditionCreate,
    CompletionConditionInDB,
    CompletionConditionListResponse,
    TaskCompletionStatus,
)
from app.services.completion_condition import completion_condition_service

router = APIRouter()


@router.get("", response_model=CompletionConditionListResponse)
def list_completion_conditions(
    subtask_id: Optional[int] = Query(None, description="Filter by subtask ID"),
    task_id: Optional[int] = Query(None, description="Filter by task ID"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    List completion conditions with optional filters.
    At least one of subtask_id or task_id must be provided.
    """
    if subtask_id is None and task_id is None:
        raise HTTPException(
            status_code=400,
            detail="At least one of subtask_id or task_id must be provided",
        )

    if subtask_id:
        conditions = completion_condition_service.get_by_subtask_id(
            db, subtask_id=subtask_id, user_id=current_user.id
        )
    else:
        conditions = completion_condition_service.get_by_task_id(
            db, task_id=task_id, user_id=current_user.id
        )

    return CompletionConditionListResponse(total=len(conditions), items=conditions)


@router.get("/{condition_id}", response_model=CompletionConditionInDB)
def get_completion_condition(
    condition_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Get a specific completion condition by ID"""
    condition = completion_condition_service.get_by_id(
        db, condition_id=condition_id, user_id=current_user.id
    )
    if not condition:
        raise HTTPException(status_code=404, detail="Completion condition not found")
    return condition


@router.post("", response_model=CompletionConditionInDB)
def create_completion_condition(
    condition_in: CompletionConditionCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Create a new completion condition"""
    condition = completion_condition_service.create_condition(
        db, obj_in=condition_in, user_id=current_user.id
    )
    return condition


@router.delete("/{condition_id}/cancel")
def cancel_completion_condition(
    condition_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Cancel a completion condition"""
    from app.models.completion_condition import ConditionStatus

    condition = completion_condition_service.get_by_id(
        db, condition_id=condition_id, user_id=current_user.id
    )
    if not condition:
        raise HTTPException(status_code=404, detail="Completion condition not found")

    if condition.status in [ConditionStatus.SATISFIED, ConditionStatus.FAILED]:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot cancel condition in {condition.status} status",
        )

    condition = completion_condition_service.update_status(
        db, condition_id=condition_id, status=ConditionStatus.CANCELLED
    )
    return {"status": "cancelled", "id": condition_id}


@router.get("/tasks/{task_id}/completion-status", response_model=TaskCompletionStatus)
def get_task_completion_status(
    task_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get the overall completion status for a task,
    including all completion conditions and their status.
    """
    status = completion_condition_service.get_task_completion_status(
        db, task_id=task_id, user_id=current_user.id
    )

    # Convert conditions to schema objects
    from app.schemas.completion_condition import CompletionConditionInDB

    conditions_in_db = [
        CompletionConditionInDB.model_validate(c) for c in status["conditions"]
    ]

    return TaskCompletionStatus(
        task_id=task_id,
        subtask_completed=True,  # This would need to be checked from subtask status
        all_conditions_satisfied=status["all_conditions_satisfied"],
        pending_conditions=status["pending_conditions"],
        in_progress_conditions=status["in_progress_conditions"],
        satisfied_conditions=status["satisfied_conditions"],
        failed_conditions=status["failed_conditions"],
        conditions=conditions_in_db,
    )
