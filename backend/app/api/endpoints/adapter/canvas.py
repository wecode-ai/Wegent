# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Canvas API endpoints for collaborative document editing.

Provides REST API endpoints for creating, updating, and managing canvas documents.
Supports version history, rollback, and export functionality.
"""

import io
import logging
from typing import List, Literal

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.subtask import Subtask
from app.models.task import TaskResource
from app.models.task_member import MemberStatus, TaskMember
from app.models.user import User
from app.schemas.canvas import (
    CanvasBrief,
    CanvasCreateRequest,
    CanvasResponse,
    CanvasRollbackRequest,
    CanvasUpdateRequest,
    CanvasUpdateResult,
    CanvasVersionDetailResponse,
    CanvasVersionResponse,
)
from app.services.canvas import (
    CanvasNotFoundException,
    CanvasUpdateError,
    canvas_service,
)

logger = logging.getLogger(__name__)

router = APIRouter()


def _check_canvas_access(
    db: Session,
    canvas,
    current_user: User,
) -> bool:
    """
    Check if user has access to the canvas.

    Access is granted if:
    1. User is the canvas creator
    2. User is the task owner
    3. User is a task member

    Args:
        db: Database session
        canvas: SubtaskContext record
        current_user: Current user

    Returns:
        True if user has access
    """
    # Check if user is the creator
    if canvas.user_id == current_user.id:
        return True

    # Get subtask to find task
    if canvas.subtask_id > 0:
        subtask = db.query(Subtask).filter(Subtask.id == canvas.subtask_id).first()
        if subtask:
            # Check if user is task owner
            task = (
                db.query(TaskResource)
                .filter(
                    TaskResource.id == subtask.task_id,
                    TaskResource.kind == "Task",
                    TaskResource.user_id == current_user.id,
                )
                .first()
            )
            if task:
                return True

            # Check if user is task member
            task_member = (
                db.query(TaskMember)
                .filter(
                    TaskMember.task_id == subtask.task_id,
                    TaskMember.user_id == current_user.id,
                    TaskMember.status == MemberStatus.ACTIVE,
                )
                .first()
            )
            if task_member:
                return True

    return False


@router.post("/create", response_model=CanvasResponse)
async def create_canvas(
    request: CanvasCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Create a new canvas document.

    Args:
        request: Canvas creation request with subtask_id and optional filename/content

    Returns:
        Created canvas response
    """
    logger.info(
        f"[canvas] create_canvas: user_id={current_user.id}, "
        f"subtask_id={request.subtask_id}, filename={request.filename}"
    )

    # Verify subtask exists and user has access
    subtask = db.query(Subtask).filter(Subtask.id == request.subtask_id).first()
    if not subtask:
        raise HTTPException(status_code=404, detail="Subtask not found")

    # Check if user has access to the task
    has_access = subtask.user_id == current_user.id
    if not has_access:
        task = (
            db.query(TaskResource)
            .filter(
                TaskResource.id == subtask.task_id,
                TaskResource.kind == "Task",
                TaskResource.user_id == current_user.id,
            )
            .first()
        )
        if task:
            has_access = True
        else:
            task_member = (
                db.query(TaskMember)
                .filter(
                    TaskMember.task_id == subtask.task_id,
                    TaskMember.user_id == current_user.id,
                    TaskMember.status == MemberStatus.ACTIVE,
                )
                .first()
            )
            has_access = task_member is not None

    if not has_access:
        raise HTTPException(status_code=403, detail="Access denied")

    try:
        canvas = canvas_service.create_canvas(
            db=db,
            user_id=current_user.id,
            subtask_id=request.subtask_id,
            filename=request.filename,
            content=request.content,
        )
        return canvas_service.to_response(canvas)
    except Exception as e:
        logger.error(f"Error creating canvas: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to create canvas") from e


@router.get("/{canvas_id}", response_model=CanvasResponse)
async def get_canvas(
    canvas_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get canvas by ID.

    Args:
        canvas_id: Canvas context ID

    Returns:
        Canvas response with content and metadata
    """
    try:
        canvas = canvas_service.get_canvas(db, canvas_id)
    except CanvasNotFoundException:
        raise HTTPException(status_code=404, detail="Canvas not found")

    if not _check_canvas_access(db, canvas, current_user):
        raise HTTPException(status_code=404, detail="Canvas not found")

    return canvas_service.to_response(canvas)


@router.put("/{canvas_id}", response_model=CanvasResponse)
async def update_canvas(
    canvas_id: int,
    request: CanvasUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Update canvas content (user edit).

    Creates a new version entry and updates the current content.

    Args:
        canvas_id: Canvas context ID
        request: Update request with new content

    Returns:
        Updated canvas response
    """
    try:
        canvas = canvas_service.get_canvas(db, canvas_id)
    except CanvasNotFoundException:
        raise HTTPException(status_code=404, detail="Canvas not found")

    if not _check_canvas_access(db, canvas, current_user):
        raise HTTPException(status_code=404, detail="Canvas not found")

    try:
        updated_canvas = canvas_service.update_canvas_user(
            db=db,
            canvas_id=canvas_id,
            content=request.content,
        )
        return canvas_service.to_response(updated_canvas)
    except CanvasNotFoundException:
        raise HTTPException(status_code=404, detail="Canvas not found")
    except Exception as e:
        logger.error(f"Error updating canvas: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to update canvas") from e


@router.get("/{canvas_id}/versions", response_model=CanvasVersionResponse)
async def get_canvas_versions(
    canvas_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get version history for a canvas.

    Args:
        canvas_id: Canvas context ID

    Returns:
        List of version entries
    """
    try:
        canvas = canvas_service.get_canvas(db, canvas_id)
    except CanvasNotFoundException:
        raise HTTPException(status_code=404, detail="Canvas not found")

    if not _check_canvas_access(db, canvas, current_user):
        raise HTTPException(status_code=404, detail="Canvas not found")

    versions = canvas_service.get_versions(db, canvas_id)
    return CanvasVersionResponse(versions=versions)


@router.get("/{canvas_id}/versions/{version}", response_model=CanvasVersionDetailResponse)
async def get_canvas_version(
    canvas_id: int,
    version: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get a specific version.

    Args:
        canvas_id: Canvas context ID
        version: Version number

    Returns:
        Version detail with content
    """
    try:
        canvas = canvas_service.get_canvas(db, canvas_id)
    except CanvasNotFoundException:
        raise HTTPException(status_code=404, detail="Canvas not found")

    if not _check_canvas_access(db, canvas, current_user):
        raise HTTPException(status_code=404, detail="Canvas not found")

    version_info = canvas_service.get_version(db, canvas_id, version)
    if not version_info:
        raise HTTPException(status_code=404, detail="Version not found")

    return CanvasVersionDetailResponse(
        version=version_info.version,
        content=version_info.content,
        timestamp=version_info.timestamp,
        source=version_info.source,
    )


@router.post("/{canvas_id}/rollback", response_model=CanvasResponse)
async def rollback_canvas(
    canvas_id: int,
    request: CanvasRollbackRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Rollback canvas to a specific version.

    Creates a new version with the content from the target version.

    Args:
        canvas_id: Canvas context ID
        request: Rollback request with target version

    Returns:
        Updated canvas response
    """
    try:
        canvas = canvas_service.get_canvas(db, canvas_id)
    except CanvasNotFoundException:
        raise HTTPException(status_code=404, detail="Canvas not found")

    if not _check_canvas_access(db, canvas, current_user):
        raise HTTPException(status_code=404, detail="Canvas not found")

    try:
        updated_canvas = canvas_service.rollback_to_version(
            db=db,
            canvas_id=canvas_id,
            version=request.version,
        )
        return canvas_service.to_response(updated_canvas)
    except CanvasNotFoundException:
        raise HTTPException(status_code=404, detail="Canvas not found")
    except CanvasUpdateError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Error rolling back canvas: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to rollback canvas") from e


@router.get("/{canvas_id}/export")
async def export_canvas(
    canvas_id: int,
    format: Literal["md", "txt"] = "txt",
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Export canvas as a file.

    Args:
        canvas_id: Canvas context ID
        format: Export format (md or txt)

    Returns:
        File download response
    """
    try:
        canvas = canvas_service.get_canvas(db, canvas_id)
    except CanvasNotFoundException:
        raise HTTPException(status_code=404, detail="Canvas not found")

    if not _check_canvas_access(db, canvas, current_user):
        raise HTTPException(status_code=404, detail="Canvas not found")

    type_data = canvas.type_data or {}
    content = type_data.get("content", "")
    filename = type_data.get("filename", "document")

    # Remove extension from filename if present
    if "." in filename:
        filename = filename.rsplit(".", 1)[0]

    if format == "md":
        media_type = "text/markdown"
        filename = f"{filename}.md"
    else:
        media_type = "text/plain"
        filename = f"{filename}.txt"

    return StreamingResponse(
        io.BytesIO(content.encode("utf-8")),
        media_type=media_type,
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@router.get("/subtask/{subtask_id}", response_model=CanvasResponse)
async def get_canvas_by_subtask(
    subtask_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get canvas by subtask ID.

    Args:
        subtask_id: Subtask ID

    Returns:
        Canvas response or 404 if not found
    """
    canvas = canvas_service.get_canvas_by_subtask(db, subtask_id)
    if not canvas:
        raise HTTPException(status_code=404, detail="Canvas not found")

    if not _check_canvas_access(db, canvas, current_user):
        raise HTTPException(status_code=404, detail="Canvas not found")

    return canvas_service.to_response(canvas)
