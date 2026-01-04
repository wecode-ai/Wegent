# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Preview API endpoints for Workbench live preview functionality.
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.schemas.preview import (
    PreviewConfigResponse,
    PreviewStartRequest,
    PreviewStartResponse,
    PreviewStopResponse,
)
from app.services.preview_service import preview_service

router = APIRouter()
logger = logging.getLogger(__name__)


@router.get("/{task_id}/config", response_model=PreviewConfigResponse)
async def get_preview_config(
    task_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Get preview configuration for a task.

    Returns the preview configuration from .wegent.yaml and current status.
    """
    return await preview_service.get_preview_config(
        db=db, task_id=task_id, user_id=current_user.id
    )


@router.post("/{task_id}/start", response_model=PreviewStartResponse)
async def start_preview(
    task_id: int,
    request: Optional[PreviewStartRequest] = None,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Start the preview service for a task.

    This triggers the dev server to start inside the task's container.
    """
    force = request.force if request else False
    return await preview_service.start_preview(
        db=db, task_id=task_id, user_id=current_user.id, force=force
    )


@router.post("/{task_id}/stop", response_model=PreviewStopResponse)
async def stop_preview(
    task_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Stop the preview service for a task.
    """
    return await preview_service.stop_preview(
        db=db, task_id=task_id, user_id=current_user.id
    )
