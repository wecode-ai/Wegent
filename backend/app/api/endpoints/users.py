# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.schemas.user import UserCreate, UserInDB, UserUpdate
from app.services.user import user_service

router = APIRouter()


@router.get("/me", response_model=UserInDB)
async def read_current_user(current_user: User = Depends(security.get_current_user)):
    """Get current user information"""
    return current_user


@router.put("/me", response_model=UserInDB)
async def update_current_user_endpoint(
    user_update: UserUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Update current user information"""
    try:
        user = user_service.update_current_user(
            db=db,
            user=current_user,
            obj_in=user_update,
        )
        return user
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.delete("/me/git-token/{git_domain:path}", response_model=UserInDB)
async def delete_git_token(
    git_domain: str,
    git_info_id: Optional[str] = Query(
        None, description="Unique ID of the git_info entry to delete"
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Delete a specific git token

    Args:
        git_domain: Git domain (required for backward compatibility)
        git_info_id: Unique ID of the git_info entry (preferred, for precise deletion)

    If git_info_id is provided, it will be used for precise deletion.
    Otherwise, falls back to deleting by domain (may delete multiple tokens).
    """
    try:
        user = user_service.delete_git_token(
            db=db, user=current_user, git_info_id=git_info_id, git_domain=git_domain
        )
        return user
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.post("", response_model=UserInDB, status_code=status.HTTP_201_CREATED)
def create_user(
    user_create: UserCreate,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """Create new user"""
    return user_service.create_user(
        db=db, obj_in=user_create, background_tasks=background_tasks
    )
