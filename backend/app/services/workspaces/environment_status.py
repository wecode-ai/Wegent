# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Resolve execution-environment availability from live device connections."""

from collections.abc import Sequence

from app.core.cache import cache_manager
from app.models.kind import Kind
from app.schemas.device import DeviceType
from app.services.device.identity import (
    device_connection_route_id,
    device_kind_type,
    matching_online_info,
)
from app.services.device.local_provider import LocalDeviceProvider
from shared.telemetry.decorators import trace_async


@trace_async("workspace.execution_environment.statuses", tracer_name="backend")
async def execution_environment_statuses(devices: Sequence[Kind]) -> dict[int, str]:
    """Use the same Redis keys and Runtime checks as the device providers."""
    keys = {
        device.id: LocalDeviceProvider.generate_online_key(
            device.user_id, device_connection_route_id(device)
        )
        for device in devices
        if device.is_active
    }
    online_infos = await cache_manager.mget_or_raise(list(dict.fromkeys(keys.values())))
    statuses = {}
    for device in devices:
        online_info = online_infos.get(keys.get(device.id))
        if device_kind_type(device) in {DeviceType.LOCAL, DeviceType.APP}:
            spec = device.json.get("spec", {}) if isinstance(device.json, dict) else {}
            online_info = matching_online_info(spec, online_info)
        raw_status = online_info.get("status", "online") if online_info else "offline"
        statuses[device.id] = (
            "online" if raw_status in {"online", "busy"} else "offline"
        )
    return statuses
