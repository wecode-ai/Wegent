# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Local executor control-plane endpoints."""

import logging
from dataclasses import dataclass

from fastapi import APIRouter, Depends, HTTPException

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


@dataclass(frozen=True)
class _LocalExecutorUser:
    id: int


def _get_local_executor_user(
    current_user: User = Depends(security.get_current_user),
) -> _LocalExecutorUser:
    return _LocalExecutorUser(id=current_user.id)


@router.post(
    "/devices/{device_id}/capabilities/sync",
    response_model=DeviceCapabilitySyncResponse,
)
async def sync_device_capabilities(
    device_id: str,
    request: DeviceCapabilitySyncRequest,
    current_user: _LocalExecutorUser = Depends(_get_local_executor_user),
) -> DeviceCapabilitySyncResponse:
    """Sync selected global capabilities to one online local executor device."""
    try:
        return await device_capability_sync_service.sync_device_capabilities(
            user_id=current_user.id,
            device_id=device_id,
            skill_ids=request.skill_ids,
            installed_skill_ids=request.installed_skill_ids,
            installed_plugin_ids=request.installed_plugin_ids,
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
