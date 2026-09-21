# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Internal cloud-device VNC session endpoints."""

from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Body, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.services.device.session_service import (
    DeviceSessionError,
    DeviceSessionNotFoundError,
)
from wecode.service.vnc_session_service import vnc_session_service

router = APIRouter()


class DeviceVncSessionCreate(BaseModel):
    """Optional owner override for an administrator opening a device."""

    owner_user_id: int | None = Field(default=None, ge=1)


class DeviceVncSessionResponse(BaseModel):
    """Short-lived VNC proxy session metadata returned to a client."""

    session_id: str
    device_id: str
    type: Literal["vnc"] = "vnc"
    path: str = ""
    url: str
    transport: Literal["websocket"] = "websocket"
    expires_at: datetime | None = None


@router.post("/{device_id}/vnc", response_model=DeviceVncSessionResponse)
async def start_device_vnc(
    device_id: str,
    payload: DeviceVncSessionCreate | None = Body(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> DeviceVncSessionResponse:
    """Start a short-lived VNC desktop WebSocket session on a cloud device."""
    owner_user_id = payload.owner_user_id if payload else None
    if owner_user_id is None:
        owner_user_id = current_user.id
    if (
        owner_user_id != current_user.id
        and getattr(current_user, "role", "user") != "admin"
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only admins can access another user's device desktop",
        )

    try:
        result = await vnc_session_service.start_session(
            db=db,
            actor_user_id=current_user.id,
            owner_user_id=owner_user_id,
            device_id=device_id,
        )
    except DeviceSessionNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except DeviceSessionError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(exc),
        ) from exc

    return DeviceVncSessionResponse(
        session_id=result.get("session_id", ""),
        device_id=result.get("device_id", device_id),
        url=result.get("url", ""),
        expires_at=result.get("expires_at"),
    )


@router.delete("/vnc-sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_device_vnc_session(
    session_id: str,
    current_user: User = Depends(security.get_current_user),
) -> None:
    """Revoke a VNC session; connected proxies observe the exact Redis key."""
    try:
        revoked = await vnc_session_service.revoke_session(
            session_id=session_id,
            user_id=current_user.id,
            allow_admin=getattr(current_user, "role", "user") == "admin",
        )
    except DeviceSessionNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    if not revoked:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="VNC session not found or expired",
        )
