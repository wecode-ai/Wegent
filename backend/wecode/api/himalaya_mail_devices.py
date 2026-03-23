# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
WeCode device endpoints for Himalaya mail configuration.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.core.socketio import get_sio
from app.models.user import User
from app.schemas.device import DeviceType
from app.services.device_service import device_service
from wecode.schemas.himalaya_mail import (
    HimalayaMailConfigRequest,
    HimalayaMailConfigResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter()


def _load_owned_device(db: Session, user_id: int, device_id: str):
    """Load a local device owned by the current user."""

    device_kind = device_service.get_device_by_device_id(db, user_id, device_id)
    if not device_kind:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Device not found or access denied",
        )

    device_type = device_kind.json.get("spec", {}).get(
        "deviceType", DeviceType.LOCAL.value
    )
    if device_type != DeviceType.LOCAL.value:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Himalaya mail config is only supported on local devices",
        )

    return device_kind


@router.post(
    "/{device_id}/himalaya-mail-config",
    response_model=HimalayaMailConfigResponse,
)
async def create_himalaya_mail_config(
    device_id: str,
    request: HimalayaMailConfigRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> HimalayaMailConfigResponse:
    """Generate a Himalaya config file on a connected local device."""

    user_id = current_user.id
    _load_owned_device(db, user_id, device_id)

    online_info = await device_service.get_device_online_info(user_id, device_id)
    if not online_info:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Device online information not found",
        )

    socket_id = online_info.get("socket_id")
    if not socket_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Device socket information not found",
        )

    try:
        response = await get_sio().call(
            "device:configure_himalaya_mail",
            request.model_dump(),
            to=socket_id,
            namespace="/local-executor",
            timeout=60,
        )
    except Exception as exc:
        logger.exception(
            "[Himalaya Mail Config] Failed to dispatch command: user_id=%s, device_id=%s",
            user_id,
            device_id,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Failed to configure Himalaya mail: {exc}",
        ) from exc

    if not isinstance(response, dict):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Invalid response from local device",
        )

    success = bool(response.get("success"))
    message = str(response.get("message") or "Failed to configure Himalaya mail")
    if not success:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=message,
        )

    return HimalayaMailConfigResponse(**response)
