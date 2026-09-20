# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Admin lookup for the IP observed during cloud device registration."""

from ipaddress import ip_address
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
from app.schemas.device import DeviceType

router = APIRouter()


class AdminCloudDeviceIpResponse(BaseModel):
    """The last backend-observed IP for a cloud device."""

    device_id: str
    ip_address: Optional[str]
    observed_at: Optional[str]


def _admin_user(
    current_user: User = Depends(get_current_user_flexible_for_executor),
) -> User:
    """Allow admin JWTs and personal API keys."""
    return get_admin_user(current_user)


def _observed_ip(value: object) -> Optional[str]:
    """Return a canonical IP from persisted registration metadata."""
    if not isinstance(value, str):
        return None
    try:
        return str(ip_address(value.strip()))
    except ValueError:
        return None


@router.get("/{device_id}/ip", response_model=AdminCloudDeviceIpResponse)
def get_cloud_device_ip(
    device_id: str,
    db: Session = Depends(get_db),
    _current_user: User = Depends(_admin_user),
) -> AdminCloudDeviceIpResponse:
    """Read the cloud device's last backend-observed connection IP."""
    devices = (
        db.query(Kind)
        .filter(
            Kind.name == device_id,
            Kind.kind == "Device",
            Kind.namespace == "default",
            Kind.is_active.is_(True),
            Kind.json["spec"]["deviceType"].as_string() == DeviceType.CLOUD.value,
        )
        .limit(2)
        .all()
    )
    if not devices:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Cloud device not found")
    if len(devices) > 1:
        raise HTTPException(status.HTTP_409_CONFLICT, "Ambiguous cloud device ID")

    spec = (devices[0].json or {}).get("spec") or {}
    return AdminCloudDeviceIpResponse(
        device_id=device_id,
        ip_address=_observed_ip(spec.get("clientIp")),
        observed_at=None,
    )
