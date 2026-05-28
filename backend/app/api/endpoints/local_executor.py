# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Local executor capability management endpoints."""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.schemas.device import (
    DeviceCapabilitySyncRequest,
    DeviceCapabilitySyncResponse,
)
from app.services.device.capability_sync_service import device_capability_sync_service

router = APIRouter(tags=["local-executor"])


@router.post(
    "/devices/{device_id}/capabilities/sync",
    response_model=DeviceCapabilitySyncResponse,
)
async def sync_device_capabilities(
    device_id: str,
    request: DeviceCapabilitySyncRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> DeviceCapabilitySyncResponse:
    """Sync selected global capabilities to a local executor device."""
    return await device_capability_sync_service.sync_device_selected_capabilities(
        db,
        user_id=current_user.id,
        device_id=device_id,
        skill_ids=request.skill_ids,
        installed_skill_ids=request.installed_skill_ids,
        installed_mcp_ids=request.installed_mcp_ids,
        mode=request.mode,
    )
