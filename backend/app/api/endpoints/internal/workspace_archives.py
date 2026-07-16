# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Internal workspace archive endpoints."""

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.models.task import TaskResource
from app.schemas.kind import ArchiveInfo
from app.services.workspace_archive import archive_service
from app.services.workspace_archive.storage import archive_storage_service
from app.stores.tasks import subtask_store, task_store

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/workspace-archives", tags=["internal-workspace-archives"])


class ManualArchiveResponse(BaseModel):
    """Response model for manually triggered workspace archive."""

    success: bool = True
    task_id: int
    archive: ArchiveInfo


class SandboxArchiveRequest(BaseModel):
    """Request model for sandbox archive and restore operations."""

    executor_name: str
    executor_namespace: str = ""


class SandboxRestoreResponse(BaseModel):
    """Response model for sandbox restore operations."""

    success: bool
    task_id: int


class ArchiveDownloadUrlResponse(BaseModel):
    """Response model for direct workspace archive downloads."""

    task_id: int
    storage_key: str
    download_url: str


def _get_active_task(db: Session, task_id: int) -> TaskResource:
    """Load an active task resource for internal archive operations."""
    task = task_store.get_task_by_states(
        db,
        task_id=task_id,
        states=[TaskResource.STATE_ACTIVE],
    )
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    return task


@router.post("/{task_id}/archive", response_model=ManualArchiveResponse)
async def archive_task_workspace(
    task_id: int,
    db: Session = Depends(get_db),
):
    """Archive the current task workspace and persist archive metadata."""
    task = _get_active_task(db, task_id)

    subtask = subtask_store.get_latest_active_executor_for_task(
        db,
        task_id=task_id,
        owner_user_id=task.user_id,
    )

    if not subtask:
        raise HTTPException(status_code=404, detail="No active executor found for task")

    archive_info = await archive_service.archive_workspace(
        db=db,
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


@router.post("/{task_id}/archive-sandbox", response_model=ManualArchiveResponse)
async def archive_sandbox_workspace(
    task_id: int,
    request: SandboxArchiveRequest,
    db: Session = Depends(get_db),
):
    """Archive sandbox runtime files and persist archive metadata."""
    task = _get_active_task(db, task_id)

    archive_info = await archive_service.archive_workspace(
        db=db,
        task=task,
        executor_name=request.executor_name,
        executor_namespace=request.executor_namespace,
        runtime_type="sandbox",
    )

    if not archive_info:
        raise HTTPException(status_code=500, detail="Failed to archive sandbox")

    db.commit()
    db.refresh(task)

    logger.info(
        "Archived sandbox workspace for task %s via executor %s/%s",
        task_id,
        request.executor_namespace,
        request.executor_name,
    )

    return ManualArchiveResponse(task_id=task_id, archive=archive_info)


@router.post("/{task_id}/restore-sandbox", response_model=SandboxRestoreResponse)
async def restore_sandbox_workspace(
    task_id: int,
    request: SandboxArchiveRequest,
    db: Session = Depends(get_db),
):
    """Restore sandbox runtime files from the latest task archive."""
    task = _get_active_task(db, task_id)

    restored = await archive_service.restore_workspace(
        db=db,
        task=task,
        executor_name=request.executor_name,
        executor_namespace=request.executor_namespace,
        runtime_type="sandbox",
    )

    return SandboxRestoreResponse(success=restored, task_id=task_id)


@router.get("/{task_id}/download-url", response_model=ArchiveDownloadUrlResponse)
async def get_workspace_archive_download_url(
    task_id: int,
    storage_key: str | None = None,
    db: Session = Depends(get_db),
):
    """Generate a presigned download URL for a task workspace archive."""
    task = _get_active_task(db, task_id)
    task_json = task.json if isinstance(task.json, dict) else {}
    status = (
        task_json.get("status") if isinstance(task_json.get("status"), dict) else {}
    )
    archive = status.get("archive") if isinstance(status.get("archive"), dict) else {}
    archived_storage_key = archive.get("storageKey")
    if not isinstance(archived_storage_key, str) or not archived_storage_key.strip():
        raise HTTPException(status_code=404, detail="archive_not_found")

    archived_storage_key = archived_storage_key.strip()
    if storage_key and storage_key != archived_storage_key:
        raise HTTPException(status_code=403, detail="archive_storage_key_mismatch")

    return ArchiveDownloadUrlResponse(
        task_id=task_id,
        storage_key=archived_storage_key,
        download_url=archive_storage_service.generate_download_url(
            archived_storage_key
        ),
    )
