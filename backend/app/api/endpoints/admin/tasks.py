# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Admin task management and token generation endpoints."""

from typing import Optional

from fastapi import APIRouter, Depends, Path, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import create_access_token, get_admin_user
from app.models.user import User
from app.schemas.task import TaskCreate, TaskInDB
from app.schemas.user import Token
from app.services.adapters.task_kinds import task_kinds_service
from app.services.user import user_service

router = APIRouter()


@router.post(
    "/users/{user_id}/tasks",
    response_model=TaskInDB,
    status_code=status.HTTP_201_CREATED,
)
async def create_task_for_user_id(
    task: TaskCreate,
    task_id: Optional[int] = None,
    user_id: int = Path(..., description="User ID"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Create task for specified user ID
    """
    # Verify user exists
    target_user = user_service.get_user_by_id(db, user_id)

    # Create task
    return task_kinds_service.create_task_or_append(
        db=db, obj_in=task, user=target_user, task_id=task_id
    )


@router.post(
    "/users/username/{user_name}/tasks",
    response_model=TaskInDB,
    status_code=status.HTTP_201_CREATED,
)
async def create_task_for_user_by_username(
    task: TaskCreate,
    task_id: Optional[int] = None,
    user_name: str = Path(..., description="User name"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Create task for specified user name
    """
    # Verify user exists
    target_user = user_service.get_user_by_name(db, user_name)

    # Create task
    return task_kinds_service.create_task_or_append(
        db=db, obj_in=task, user=target_user, task_id=task_id
    )


@router.post("/generate-admin-token", response_model=Token)
async def generate_admin_token(
    db: Session = Depends(get_db), current_user: User = Depends(get_admin_user)
):
    """
    Generate a permanent admin token (pseudo-permanent for 500 years)
    """
    # Create a permanent token (set very long expiration time)
    access_token = create_access_token(
        data={"sub": current_user.user_name, "user_id": current_user.id},
        expires_delta=262800000,  # 500 years
    )

    return Token(access_token=access_token, token_type="bearer")
