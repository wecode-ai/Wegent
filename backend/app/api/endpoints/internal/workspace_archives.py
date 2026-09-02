# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Internal workspace archive endpoints."""

import logging
from copy import deepcopy
from dataclasses import dataclass

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


@dataclass(frozen=True)
class _ArchiveTaskSnapshot:
    task_id: int
    task_json: dict
    executor_name: str = ""
    executor_namespace: str = ""


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


def _load_archive_task_snapshot(
    task_id: int,
    require_executor: bool,
) -> _ArchiveTaskSnapshot:
    """Load all archive metadata in a worker-owned transaction."""

    from app.services.chat.storage.db import get_db_session

    with get_db_session() as db:
        task = _get_active_task(db, task_id)
        executor_name = ""
        executor_namespace = ""
        if require_executor:
            subtask = subtask_store.get_latest_active_executor_for_task(
                db,
                task_id=task_id,
                owner_user_id=task.user_id,
            )
            if not subtask:
                raise HTTPException(
                    status_code=404,
                    detail="No active executor found for task",
                )
            executor_name = str(subtask.executor_name or "")
            executor_namespace = str(subtask.executor_namespace or "")
        return _ArchiveTaskSnapshot(
            task_id=task.id,
            task_json=deepcopy(task.json) if isinstance(task.json, dict) else {},
            executor_name=executor_name,
            executor_namespace=executor_namespace,
        )


async def _archive_task_snapshot(
    task_id: int,
    *,
    require_executor: bool,
) -> _ArchiveTaskSnapshot:
    from app.services.chat.storage.db import run_sync_in_executor

    return await run_sync_in_executor(
        _load_archive_task_snapshot,
        task_id,
        require_executor,
    )


@router.post("/{task_id}/archive", response_model=ManualArchiveResponse)
async def archive_task_workspace(
    task_id: int,
):
    """Archive the current task workspace and persist archive metadata."""
    snapshot = await _archive_task_snapshot(task_id, require_executor=True)

    archive_info = await archive_service.archive_workspace(
        task_id=snapshot.task_id,
        executor_name=snapshot.executor_name,
        executor_namespace=snapshot.executor_namespace,
    )

    if not archive_info:
        raise HTTPException(status_code=500, detail="Failed to archive workspace")

    logger.info(
        "Manually archived workspace for task %s via executor %s/%s",
        task_id,
        snapshot.executor_namespace,
        snapshot.executor_name,
    )

    return ManualArchiveResponse(task_id=task_id, archive=archive_info)


@router.post("/{task_id}/archive-sandbox", response_model=ManualArchiveResponse)
async def archive_sandbox_workspace(
    task_id: int,
    request: SandboxArchiveRequest,
):
    """Archive sandbox runtime files and persist archive metadata."""
    snapshot = await _archive_task_snapshot(task_id, require_executor=False)

    archive_info = await archive_service.archive_workspace(
        task_id=snapshot.task_id,
        executor_name=request.executor_name,
        executor_namespace=request.executor_namespace,
        runtime_type="sandbox",
    )

    if not archive_info:
        raise HTTPException(status_code=500, detail="Failed to archive sandbox")

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
):
    """Restore sandbox runtime files from the latest task archive."""
    snapshot = await _archive_task_snapshot(task_id, require_executor=False)

    restored = await archive_service.restore_workspace_snapshot(
        task_id=snapshot.task_id,
        task_json=snapshot.task_json,
        executor_name=request.executor_name,
        executor_namespace=request.executor_namespace,
        runtime_type="sandbox",
    )

    return SandboxRestoreResponse(success=bool(restored), task_id=task_id)


@router.get("/{task_id}/download-url", response_model=ArchiveDownloadUrlResponse)
def get_workspace_archive_download_url(
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
