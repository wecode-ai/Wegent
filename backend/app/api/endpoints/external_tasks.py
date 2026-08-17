# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""External task APIs for API-key based integrations."""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.schemas.shared_task import TaskShareResponse
from app.services.shared_task import shared_task_service
from app.services.task_member_service import task_member_service

router = APIRouter()


@router.post("/{task_id}/share", response_model=TaskShareResponse)
def share_task_with_api_key(
    task_id: int,
    current_user: User = Depends(security.get_current_user_jwt_apikey_tasktoken),
    db: Session = Depends(get_db),
) -> TaskShareResponse:
    """Generate a task share link for the task owner."""
    if not task_member_service.is_task_owner(
        db=db,
        task_id=task_id,
        user_id=current_user.id,
    ):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Task not found or you don't have permission",
        )

    return shared_task_service.share_task(
        db=db,
        task_id=task_id,
        user_id=current_user.id,
    )
