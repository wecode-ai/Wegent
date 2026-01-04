# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Canvas API endpoints for managing canvas content in tasks.
"""
import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.deps import get_db, get_current_user
from app.models.user import User
from app.services.canvas_service import CanvasService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/canvas", tags=["canvas"])


# Request/Response Models
class EnableCanvasRequest(BaseModel):
    """Request to enable canvas mode."""

    task_id: int
    initial_content: str = ""
    file_type: str = "text"
    title: str = "Untitled"


class UpdateCanvasRequest(BaseModel):
    """Request to update canvas content."""

    task_id: int
    content: str
    file_type: str | None = None
    title: str | None = None


class CanvasResponse(BaseModel):
    """Canvas state response."""

    enabled: bool
    content: str
    file_type: str
    title: str


class DisableCanvasResponse(BaseModel):
    """Response when disabling canvas."""

    message: str


@router.post("/enable", response_model=CanvasResponse)
async def enable_canvas(
    request: EnableCanvasRequest,
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> CanvasResponse:
    """Enable canvas mode for a task.

    Args:
        request: Enable canvas request
        db: Database session
        current_user: Current authenticated user

    Returns:
        Canvas state after enabling

    Raises:
        HTTPException: If task not found or user not authorized
    """
    try:
        service = CanvasService(db)
        result = await service.enable_canvas(
            task_id=request.task_id,
            initial_content=request.initial_content,
            file_type=request.file_type,
            title=request.title,
        )
        return CanvasResponse(**result)
    except ValueError as e:
        logger.error(f"Error enabling canvas: {e}")
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e),
        )
    except Exception as e:
        logger.error(f"Unexpected error enabling canvas: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to enable canvas",
        )


@router.get("/{task_id}", response_model=CanvasResponse)
async def get_canvas(
    task_id: int,
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> CanvasResponse:
    """Get canvas content for a task.

    Args:
        task_id: Task ID
        db: Database session
        current_user: Current authenticated user

    Returns:
        Canvas state

    Raises:
        HTTPException: If task not found or user not authorized
    """
    try:
        service = CanvasService(db)
        result = await service.get_canvas(task_id)
        return CanvasResponse(**result)
    except ValueError as e:
        logger.error(f"Error getting canvas: {e}")
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e),
        )
    except Exception as e:
        logger.error(f"Unexpected error getting canvas: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get canvas",
        )


@router.put("/update", response_model=CanvasResponse)
async def update_canvas(
    request: UpdateCanvasRequest,
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> CanvasResponse:
    """Update canvas content.

    Args:
        request: Update canvas request
        db: Database session
        current_user: Current authenticated user

    Returns:
        Updated canvas state

    Raises:
        HTTPException: If task not found or user not authorized
    """
    try:
        service = CanvasService(db)
        result = await service.update_canvas(
            task_id=request.task_id,
            content=request.content,
            file_type=request.file_type,
            title=request.title,
        )
        return CanvasResponse(enabled=True, **result)
    except ValueError as e:
        logger.error(f"Error updating canvas: {e}")
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e),
        )
    except Exception as e:
        logger.error(f"Unexpected error updating canvas: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update canvas",
        )


@router.post("/{task_id}/disable", response_model=DisableCanvasResponse)
async def disable_canvas(
    task_id: int,
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> DisableCanvasResponse:
    """Disable canvas mode for a task.

    Args:
        task_id: Task ID
        db: Database session
        current_user: Current authenticated user

    Returns:
        Success message

    Raises:
        HTTPException: If task not found or user not authorized
    """
    try:
        service = CanvasService(db)
        await service.disable_canvas(task_id)
        return DisableCanvasResponse(message="Canvas disabled successfully")
    except ValueError as e:
        logger.error(f"Error disabling canvas: {e}")
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e),
        )
    except Exception as e:
        logger.error(f"Unexpected error disabling canvas: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to disable canvas",
        )
