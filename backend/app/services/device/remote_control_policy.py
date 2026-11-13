# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Remote-control exposure policy for app-backed devices."""

from typing import Any, Optional

from app.schemas.device import DeviceType

REMOTE_CONTROL_DISABLED_MESSAGE = "Remote control is disabled for this app device"

APP_REMOTE_TASK_METHODS = frozenset(
    {
        "runtime.tasks.create",
        "runtime.tasks.list",
        "runtime.tasks.search",
        "runtime.tasks.transcript",
        "runtime.tasks.transcript.search",
        "runtime.tasks.send",
        "runtime.tasks.cancel",
        "runtime.tasks.goal.get",
        "runtime.tasks.goal.set",
    }
)


def app_remote_task_access_enabled(online_info: dict[str, Any]) -> bool:
    """Trust only explicit consent reported by the target's current Runtime."""
    features = online_info.get("runtime_features")
    access = features.get("remoteTaskAccess") if isinstance(features, dict) else None
    return (
        isinstance(access, dict)
        and type(access.get("version")) is int
        and access.get("version") == 1
        and access.get("enabled") is True
    )


def personal_task_devices(devices: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Use record-scoped routes for opted-in App installations in task views."""
    return [
        (
            {**device, "device_id": device["execution_target_id"]}
            if device.get("device_type") == DeviceType.APP.value
            else device
        )
        for device in devices
        if device.get("device_type") != DeviceType.APP.value
        or (
            device.get("execution_target_id") and app_remote_task_access_enabled(device)
        )
    ]


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
