# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Internal Service API endpoints for AI Agent tools.

Provides internal API for chat_shell's expose_service tool to update task services.
These endpoints are intended for service-to-service communication, not user access.
"""

import asyncio
import logging
from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.api.dependencies import get_db
from app.models.task import TaskResource
from app.services.chat.ws_emitter import get_main_event_loop, get_ws_emitter

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/services", tags=["internal-services"])


# ==================== Request/Response Schemas ====================


class ServiceUpdateRequest(BaseModel):
    """Request model for updating service/app fields via internal API."""

    task_id: int = Field(..., description="Task ID to update")
    name: Optional[str] = Field(None, description="Application name")
    address: Optional[str] = Field(
        None, description="Service address in IP:port format (e.g., '192.168.1.1:3456')"
    )
    previewUrl: Optional[str] = Field(None, description="Application preview URL")
    mysql: Optional[str] = Field(
        None, description="MySQL connection string (mysql://user:pass@host:port/db)"
    )


class ServiceResponse(BaseModel):
    """Response model for service/app data."""

    success: bool = True
    app: dict[str, Any] = Field(default_factory=dict, description="App configuration")


class HealthResponse(BaseModel):
    """Health check response."""

    status: str
    service: str = "internal-services"


# ==================== API Endpoints ====================


@router.get("/health", response_model=HealthResponse)
async def health_check():
    """Health check endpoint for internal services API."""
    return HealthResponse(status="ok")


@router.post("/update", response_model=ServiceResponse)
def update_task_services(
    request: ServiceUpdateRequest,
    db: Session = Depends(get_db),
):
    """
    Update task services/app configuration (partial merge).

    This is an internal API for chat_shell's expose_service tool.
    It merges the provided fields with existing app data.

    Args:
        request: Service update request with task_id and optional fields
        db: Database session

    Returns:
        ServiceResponse with updated app data
    """
    task = (
        db.query(TaskResource)
        .filter(
            TaskResource.id == request.task_id,
            TaskResource.kind == "Task",
            TaskResource.is_active.is_(True),
        )
        .first()
    )

    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    # Get existing app data or initialize empty dict
    # App data is stored under status.app
    task_json = task.json or {}
    status_data = task_json.get("status", {}) or {}
    app_data = status_data.get("app", {}) or {}

    # Merge only non-None fields from the request (exclude task_id)
    update_data = request.model_dump(exclude_none=True, exclude={"task_id"})

    if not update_data:
        # No fields to update, just return current app data
        return ServiceResponse(success=True, app=app_data)

    app_data.update(update_data)

    # Update task JSON with new app data under status.app
    status_data["app"] = app_data
    task_json["status"] = status_data
    task.json = task_json
    task.updated_at = datetime.now()
    flag_modified(task, "json")

    db.commit()
    db.refresh(task)

    logger.info(f"Updated task {request.task_id} services: {list(update_data.keys())}")

    # Emit WebSocket event to notify frontend about app update
    ws_emitter = get_ws_emitter()
    if ws_emitter:
        loop = get_main_event_loop()
        if loop and loop.is_running():
            asyncio.run_coroutine_threadsafe(
                ws_emitter.emit_task_app_update(request.task_id, app_data),
                loop,
            )
        else:
            logger.warning(
                f"Cannot emit task:app_update for task {request.task_id}: event loop not running"
            )

    return ServiceResponse(success=True, app=app_data)


@router.get("/{task_id}", response_model=ServiceResponse)
def get_task_services(
    task_id: int,
    db: Session = Depends(get_db),
):
    """
    Get task services/app configuration.

    This is an internal API for reading task app data.

    Args:
        task_id: Task ID to query
        db: Database session

    Returns:
        ServiceResponse with app data
    """
    task = (
        db.query(TaskResource)
        .filter(
            TaskResource.id == task_id,
            TaskResource.kind == "Task",
            TaskResource.is_active.is_(True),
        )
        .first()
    )

    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    # App data is stored under status.app
    status_data = task.json.get("status", {}) if task.json else {}
    app_data = status_data.get("app", {}) if status_data else {}
    return ServiceResponse(success=True, app=app_data)
