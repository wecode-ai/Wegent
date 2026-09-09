# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Remote-control exposure policy for app-backed devices."""

from typing import Any, Optional

from app.schemas.device import DeviceType

REMOTE_CONTROL_DISABLED_MESSAGE = "Remote control is disabled for this app device"


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
    """Return whether privileged device controls may target this device type."""

    return device_type is not None and device_type != DeviceType.APP
