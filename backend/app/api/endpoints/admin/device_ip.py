# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Admin lookup for a device's directly reachable Executor gateway."""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import (
    get_admin_user,
    get_current_user_flexible_for_executor,
)
from app.models.kind import Kind
from app.models.user import User
from app.services.device.device_gateway_address import reported_device_address

router = APIRouter()


class AdminDeviceIpResponse(BaseModel):
    """The directly reachable IP and Executor gateway port for a device."""

    device_id: str
    ip_address: Optional[str]
    port: Optional[int]
    observed_at: Optional[str]


def _admin_user(
    current_user: User = Depends(get_current_user_flexible_for_executor),
) -> User:
    """Allow admin JWTs and personal API keys."""
    return get_admin_user(current_user)


@router.get("/{device_id}/ip", response_model=AdminDeviceIpResponse)
def get_device_ip(
    device_id: str,
    db: Session = Depends(get_db),
    _current_user: User = Depends(_admin_user),
) -> AdminDeviceIpResponse:
    """Read the device's directly reachable Executor gateway address."""
    devices = (
        db.query(Kind)
        .filter(
            Kind.name == device_id,
            Kind.kind == "Device",
            Kind.namespace == "default",
            Kind.is_active.is_(True),
        )
        .limit(2)
        .all()
    )
    if not devices:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Device not found")
    if len(devices) > 1:
        raise HTTPException(status.HTTP_409_CONFLICT, "Ambiguous device ID")

    spec = (devices[0].json or {}).get("spec") or {}
    ip_address, port = reported_device_address(spec)
    return AdminDeviceIpResponse(
        device_id=device_id,
        ip_address=ip_address,
        port=port,
        observed_at=None,
    )
