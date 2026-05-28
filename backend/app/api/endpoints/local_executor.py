# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Local executor control-plane endpoints."""

import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.schemas.device import (
    DeviceCapabilitySyncRequest,
    DeviceCapabilitySyncResponse,
)
from app.services.device.capability_sync_service import (
    DeviceCapabilityResolutionError,
    DeviceCapabilitySyncError,
    device_capability_sync_service,
)

logger = logging.getLogger(__name__)

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
    """Sync selected global capabilities to one online local executor device."""
    try:
        return await device_capability_sync_service.sync_device_capabilities(
            db,
            user=current_user,
            device_id=device_id,
            skill_ids=request.skill_ids,
            installed_skill_ids=request.installed_skill_ids,
            installed_mcp_ids=request.installed_mcp_ids,
            mcp_ids=request.mcp_ids,
            mode=request.mode,
        )
    except DeviceCapabilityResolutionError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    except DeviceCapabilitySyncError as exc:
        logger.warning(
            "[LocalExecutor] Capability sync failed: user_id=%s, device_id=%s, error=%s",
            current_user.id,
            device_id,
            exc,
        )
        raise HTTPException(status_code=502, detail=str(exc)) from exc
