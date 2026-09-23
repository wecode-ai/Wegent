# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Admin lookup for a device's directly reachable Executor gateway."""

from ipaddress import ip_address
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.constants import EXECUTOR_SESSION_GATEWAY_DEFAULT_PORT
from app.core.security import (
    get_admin_user,
    get_current_user_flexible_for_executor,
)
from app.models.kind import Kind
from app.models.user import User

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


def _usable_device_ip(value: object) -> Optional[str]:
    """Return a canonical IP that another machine can address directly."""
    if not isinstance(value, str):
        return None
    try:
        address = ip_address(value.strip())
    except ValueError:
        return None
    if (
        address.is_loopback
        or address.is_unspecified
        or address.is_multicast
        or address.is_link_local
    ):
        return None
    return str(address)


def _gateway_port(spec: dict, resolved_ip: Optional[str]) -> Optional[int]:
    """Return the reported port or the legacy Executor default."""
    if resolved_ip is None:
        return None
    if "runtimeTransferPort" not in spec:
        return EXECUTOR_SESSION_GATEWAY_DEFAULT_PORT
    value = spec.get("runtimeTransferPort")
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if 1 <= value <= 65535 else None


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
    resolved_ip = _usable_device_ip(
        spec.get("runtimeTransferHost")
    ) or _usable_device_ip(spec.get("clientIp"))
    return AdminDeviceIpResponse(
        device_id=device_id,
        ip_address=resolved_ip,
        port=_gateway_port(spec, resolved_ip),
        observed_at=None,
    )
