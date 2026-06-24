# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging

from fastapi import APIRouter, Depends, File, Form, UploadFile, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_admin_user
from app.models.user import User
from app.schemas.installed_plugin import (
    PluginRuntime,
    SystemPlugin,
    SystemPluginListResponse,
    SystemPluginUpdateRequest,
)
from app.services.claude_plugin_parser import MAX_PLUGIN_PACKAGE_SIZE_BYTES
from app.services.installed_plugin_service import installed_plugin_service

router = APIRouter()
logger = logging.getLogger(__name__)
PLUGIN_UPLOAD_CHUNK_SIZE_BYTES = 1024 * 1024


@router.get("/plugins", response_model=SystemPluginListResponse)
async def list_system_plugins(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
) -> SystemPluginListResponse:
    """List system-managed Claude Code plugins."""
    return installed_plugin_service.list_system_plugins(db=db)


@router.post(
    "/plugins",
    response_model=SystemPlugin,
    status_code=status.HTTP_201_CREATED,
)
async def upload_system_plugin(
    file: UploadFile = File(...),
    enabled: bool = Form(True),
    runtime: PluginRuntime = Form("claudecode"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
) -> SystemPlugin:
    """Upload or replace a system-managed Claude Code plugin package."""
    logger.info(
        "System plugin upload requested: admin_id=%s filename=%s enabled=%s runtime=%s",
        current_user.id,
        file.filename,
        enabled,
        runtime,
    )
    package_bytes = await _read_plugin_upload(file)
    return installed_plugin_service.upload_system_plugin(
        db=db,
        package_bytes=package_bytes,
        filename=file.filename or "plugin.zip",
        enabled=enabled,
        runtime=runtime,
    )


@router.put("/plugins/{system_plugin_id}", response_model=SystemPlugin)
async def update_system_plugin(
    system_plugin_id: int,
    request: SystemPluginUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
) -> SystemPlugin:
    """Update system plugin display metadata and visibility."""
    return installed_plugin_service.update_system_plugin_metadata(
        db=db,
        system_plugin_id=system_plugin_id,
        display_name=request.displayName,
        description=request.description,
        enabled=request.enabled,
    )


@router.put("/plugins/{system_plugin_id}/package", response_model=SystemPlugin)
async def replace_system_plugin_package(
    system_plugin_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
) -> SystemPlugin:
    """Replace a system plugin ZIP package with a new version."""
    logger.info(
        "System plugin package replacement requested: admin_id=%s plugin_id=%s filename=%s",
        current_user.id,
        system_plugin_id,
        file.filename,
    )
    package_bytes = await _read_plugin_upload(file)
    return installed_plugin_service.replace_system_plugin_package(
        db=db,
        system_plugin_id=system_plugin_id,
        package_bytes=package_bytes,
        filename=file.filename or "plugin.zip",
    )


@router.delete("/plugins/{system_plugin_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_system_plugin(
    system_plugin_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
) -> None:
    """Remove a system-managed plugin from the user-facing catalog."""
    installed_plugin_service.delete_system_plugin(
        db=db,
        system_plugin_id=system_plugin_id,
    )


async def _read_plugin_upload(file: UploadFile) -> bytes:
    chunks: list[bytes] = []
    total_size = 0
    while True:
        chunk = await file.read(PLUGIN_UPLOAD_CHUNK_SIZE_BYTES)
        if not chunk:
            break
        total_size += len(chunk)
        if total_size > MAX_PLUGIN_PACKAGE_SIZE_BYTES:
            from fastapi import HTTPException

            raise HTTPException(status_code=413, detail="Plugin package is too large")
        chunks.append(chunk)
    return b"".join(chunks)
