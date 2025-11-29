# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
CompletionCondition API endpoints
"""

import logging
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.core.security import get_current_user
from app.db.session import get_db
from app.models.subtask import Subtask, SubtaskStatus
from app.models.user import User
from app.schemas.completion_condition import (
    CompletionConditionCreate,
    CompletionConditionListResponse,
    CompletionConditionResponse,
    ConditionStatus,
    SubtaskCompletionStatus,
)
from app.services.completion_condition_service import get_completion_condition_service

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("", response_model=CompletionConditionListResponse)
async def list_completion_conditions(
    subtask_id: Optional[int] = Query(None, description="Filter by subtask ID"),
    task_id: Optional[int] = Query(None, description="Filter by task ID"),
    status: Optional[ConditionStatus] = Query(None, description="Filter by status"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List completion conditions with optional filters"""
    service = get_completion_condition_service(db)

    # Build query based on filters
    from app.models.completion_condition import CompletionCondition

    query = db.query(CompletionCondition).filter(
        CompletionCondition.user_id == current_user.id
    )

    if subtask_id:
        query = query.filter(CompletionCondition.subtask_id == subtask_id)
    if task_id:
        query = query.filter(CompletionCondition.task_id == task_id)
    if status:
        query = query.filter(CompletionCondition.status == status)

    conditions = query.order_by(CompletionCondition.created_at.desc()).all()

    return CompletionConditionListResponse(
        total=len(conditions),
        items=[CompletionConditionResponse.model_validate(c) for c in conditions],
    )


@router.get("/{condition_id}", response_model=CompletionConditionResponse)
async def get_completion_condition(
    condition_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get a specific completion condition by ID"""
    service = get_completion_condition_service(db)
    condition = service.get_by_id(condition_id)

    if not condition:
        raise HTTPException(status_code=404, detail="Completion condition not found")

    if condition.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="Access denied")

    return CompletionConditionResponse.model_validate(condition)


@router.post("", response_model=CompletionConditionResponse)
async def create_completion_condition(
    condition: CompletionConditionCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create a new completion condition"""
    # Verify subtask belongs to user
    subtask = db.query(Subtask).filter(
        Subtask.id == condition.subtask_id,
        Subtask.user_id == current_user.id,
    ).first()

    if not subtask:
        raise HTTPException(status_code=404, detail="Subtask not found")

    # Override user_id with current user
    condition_data = condition.model_copy(update={"user_id": current_user.id})

    service = get_completion_condition_service(db)
    created = service.create(condition_data)

    return CompletionConditionResponse.model_validate(created)


@router.delete("/{condition_id}")
async def cancel_completion_condition(
    condition_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Cancel a completion condition"""
    service = get_completion_condition_service(db)
    condition = service.get_by_id(condition_id)

    if not condition:
        raise HTTPException(status_code=404, detail="Completion condition not found")

    if condition.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="Access denied")

    from app.schemas.completion_condition import CompletionConditionUpdate

    service.update(
        condition_id,
        CompletionConditionUpdate(status=ConditionStatus.CANCELLED),
    )

    return {"status": "cancelled", "condition_id": condition_id}


@router.get("/subtask/{subtask_id}/status", response_model=SubtaskCompletionStatus)
async def get_subtask_completion_status(
    subtask_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get the complete status of a subtask including all its completion conditions"""
    # Verify subtask belongs to user
    subtask = db.query(Subtask).filter(
        Subtask.id == subtask_id,
        Subtask.user_id == current_user.id,
    ).first()

    if not subtask:
        raise HTTPException(status_code=404, detail="Subtask not found")

    service = get_completion_condition_service(db)
    conditions = service.get_by_subtask_id(subtask_id)

    # Calculate status counts
    pending_count = sum(1 for c in conditions if c.status == ConditionStatus.PENDING)
    in_progress_count = sum(
        1 for c in conditions if c.status == ConditionStatus.IN_PROGRESS
    )
    all_satisfied = all(
        c.status == ConditionStatus.SATISFIED for c in conditions
    ) if conditions else True
    has_failed = any(c.status == ConditionStatus.FAILED for c in conditions)

    return SubtaskCompletionStatus(
        subtask_id=subtask_id,
        subtask_status=subtask.status.value,
        conditions=[CompletionConditionResponse.model_validate(c) for c in conditions],
        all_satisfied=all_satisfied,
        has_failed=has_failed,
        pending_count=pending_count,
        in_progress_count=in_progress_count,
    )
