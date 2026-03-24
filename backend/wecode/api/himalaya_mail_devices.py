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
HIMALAYA_EXTENSION_NAME = "himalaya-mail"
HIMALAYA_EXTENSION_SCRIPT_PATH = "scripts/himalaya-executor-ext.sh"


def _load_owned_device(db: Session, user_id: int, device_id: str):
    """Load an owned device and resolve its type."""

    device_kind = device_service.get_device_by_device_id(db, user_id, device_id)
    if not device_kind:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Device not found or access denied",
        )

    device_type_value = device_kind.json.get("spec", {}).get(
        "deviceType", DeviceType.LOCAL.value
    )
    try:
        device_type = DeviceType(device_type_value)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported device type: {device_type_value}",
        ) from exc

    return device_kind, device_type


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
    """Generate a Himalaya config file on a connected device."""

    user_id = current_user.id
    _, device_type = _load_owned_device(db, user_id, device_id)

    online_info = await device_service.get_device_online_info_by_type(
        user_id, device_id, device_type
    )
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
        payload = request.model_dump(exclude={"task_id"})
        logger.info(
            "[Himalaya Mail Config] Sending device:run_extension to socket_id=%s, "
            "device_id=%s, task_id=%s",
            socket_id,
            device_id,
            request.task_id,
        )
        response = await get_sio().call(
            "device:run_extension",
            {
                "task_id": request.task_id,
                "extension_name": HIMALAYA_EXTENSION_NAME,
                "script_path": HIMALAYA_EXTENSION_SCRIPT_PATH,
                "action": "configure",
                "payload": payload,
            },
            to=socket_id,
            namespace="/local-executor",
            timeout=60,
        )
        logger.info(
            "[Himalaya Mail Config] Received response from device: type=%s, value=%s",
            type(response).__name__,
            response if isinstance(response, dict) else repr(response)[:200],
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

    if response is None:
        logger.warning(
            "[Himalaya Mail Config] No response from device (timeout or not connected): "
            "socket_id=%s, device_id=%s",
            socket_id,
            device_id,
        )
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="Device did not respond in time. Please ensure the device is online and try again.",
        )

    if not isinstance(response, dict):
        logger.warning(
            "[Himalaya Mail Config] Invalid response type from device: type=%s, value=%s",
            type(response).__name__,
            repr(response)[:200],
        )
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
