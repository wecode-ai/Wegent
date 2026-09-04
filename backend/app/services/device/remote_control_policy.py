# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Remote-control exposure policy for app-backed devices."""

from typing import Any, Optional

from app.db.session import get_db_session
from app.schemas.device import DeviceType
from app.services.device.runtime_route import resolve_runtime_route_identity

REMOTE_CONTROL_DISABLED_MESSAGE = "Remote control is disabled for this app device"


class RemoteControlDisabledError(PermissionError):
    """Raised when Backend-originated work targets an app-only connection."""


def device_kind_type(device_kind: Any) -> Optional[DeviceType]:
    """Read a persisted device type without inventing an unknown type."""

    device_json = getattr(device_kind, "json", None)
    spec = device_json.get("spec", {}) if isinstance(device_json, dict) else {}
    if "deviceType" not in spec:
        return DeviceType.LOCAL
    raw_type = spec.get("deviceType")
    if not isinstance(raw_type, str):
        return None
    try:
        return DeviceType(raw_type)
    except ValueError:
        return None


def remote_control_is_enabled(device_type: Optional[DeviceType]) -> bool:
    """Return whether Backend-originated control may target this device type."""

    return device_type is not None and device_type != DeviceType.APP


def ensure_remote_control_enabled_for_device(
    *,
    user_id: int,
    device_id: str,
) -> None:
    """Reject Backend task dispatch when the persisted device is app-only."""

    with get_db_session() as db:
        identity = resolve_runtime_route_identity(
            db,
            user_id=user_id,
            submitted_device_id=device_id,
        )
    if identity is not None and not remote_control_is_enabled(identity.device_type):
        raise RemoteControlDisabledError(REMOTE_CONTROL_DISABLED_MESSAGE)
