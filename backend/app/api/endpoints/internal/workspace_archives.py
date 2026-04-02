# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Internal workspace archive endpoints."""

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.models.subtask import Subtask
from app.models.task import TaskResource
from app.schemas.kind import ArchiveInfo
from app.services.workspace_archive import archive_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/workspace-archives", tags=["internal-workspace-archives"])


class ManualArchiveResponse(BaseModel):
    """Response model for manually triggered workspace archive."""

    success: bool = True
    task_id: int
    archive: ArchiveInfo


@router.post("/{task_id}/archive", response_model=ManualArchiveResponse)
async def archive_task_workspace(
    task_id: int,
    db: Session = Depends(get_db),
):
    """Archive the current task workspace and persist archive metadata."""
    task = (
        db.query(TaskResource)
        .filter(
            TaskResource.id == task_id,
            TaskResource.kind == "Task",
            TaskResource.is_active == TaskResource.STATE_ACTIVE,
        )
        .first()
    )

    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    subtask = (
        db.query(Subtask)
        .filter(
            Subtask.task_id == task_id,
            Subtask.executor_name.isnot(None),
            Subtask.executor_name != "",
            Subtask.executor_deleted_at == False,
        )
        .order_by(Subtask.id.desc())
        .first()
    )

    if not subtask:
        raise HTTPException(status_code=404, detail="No active executor found for task")

    archive_info = await archive_service.archive_workspace(
        db=db,
        subtask=subtask,
        task=task,
        executor_name=subtask.executor_name,
        executor_namespace=subtask.executor_namespace or "",
    )

    if not archive_info:
        raise HTTPException(status_code=500, detail="Failed to archive workspace")

    db.commit()
    db.refresh(task)

    logger.info(
        "Manually archived workspace for task %s via executor %s/%s",
        task_id,
        subtask.executor_namespace or "",
        subtask.executor_name,
    )

    return ManualArchiveResponse(task_id=task_id, archive=archive_info)
