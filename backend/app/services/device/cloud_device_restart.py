# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Deployment-specific cloud device restart."""

import asyncio
from dataclasses import dataclass
from typing import Awaitable, Callable, Optional

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.core.cache import cache_manager
from app.models.kind import Kind
from app.schemas.device import DeviceType
from app.services.device.identity import device_connection_route_id
from app.services.device.local_provider import (
    LocalDeviceProvider,
    runtime_capacity_slot_values,
)
from app.services.device.runtime_rpc_service import RuntimeRpcError, runtime_rpc_service


@dataclass(frozen=True)
class CloudDeviceRestartResult:
    """Result returned by a cloud device restart implementation."""

    success: bool
    message: str
    provider_configured: bool = True


CloudDeviceRestartHandler = Callable[
    [Session, int, str], Awaitable[CloudDeviceRestartResult]
]

_restart_handler: Optional[CloudDeviceRestartHandler] = None


def register_cloud_device_restart_handler(
    handler: CloudDeviceRestartHandler,
) -> None:
    """Register the deployment-specific cloud device restart implementation."""
    global _restart_handler

    _restart_handler = handler


async def restart_cloud_device(
    db: Session,
    user_id: int,
    device_id: str,
) -> CloudDeviceRestartResult:
    """Restart a cloud device through the registered deployment implementation."""
    if _restart_handler is None:
        return CloudDeviceRestartResult(
            success=False,
            message="Device restart is not configured in this deployment",
            provider_configured=False,
        )

    return await _restart_handler(db, user_id, device_id)


async def _has_active_runtime_work(user_id: int, device_id: str) -> bool:
    """Read native work from the runtime scheduler, outside the heartbeat cache."""
    try:
        result = await runtime_rpc_service.call(
            user_id=user_id,
            device_id=device_id,
            method="runtime.capacity.get",
            payload={},
            timeout_seconds=5,
        )
    except RuntimeRpcError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Could not check cloud device running tasks",
        ) from exc
    active = result.get("active") if isinstance(result, dict) else None
    if type(active) is not int or active < 0:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Could not check cloud device running tasks",
        )
    return active > 0


async def _cloud_devices_have_running_tasks(user_id: int, devices: list[Kind]) -> bool:
    routes = {
        LocalDeviceProvider.generate_online_key(user_id, route): route
        for route in {device_connection_route_id(device) for device in devices}
    }
    online = await cache_manager.mget_or_raise(sorted(routes))
    if any(
        info and (info.get("running_task_ids") or runtime_capacity_slot_values(info)[0])
        for info in online.values()
    ):
        return True
    native_routes = [
        routes[key]
        for key, info in online.items()
        if info and (info.get("runtime_features") or {}).get("runtimeTaskCreate")
    ]
    return any(
        await asyncio.gather(
            *(_has_active_runtime_work(user_id, route) for route in native_routes)
        )
    )


async def restart_cloud_device_for_upgrade(
    db: Session, device: Kind, force_stop_tasks: bool
) -> CloudDeviceRestartResult:
    """Apply the legacy upgrade task guard to the entire sandbox."""
    if _restart_handler and not force_stop_tasks:
        sandbox_id = (device.json["spec"].get("cloudConfig") or {}).get("sandboxId")
        devices = [device]
        if sandbox_id:
            devices.extend(
                db.query(Kind)
                .filter(
                    Kind.user_id == device.user_id,
                    Kind.kind == "Device",
                    Kind.namespace == device.namespace,
                    Kind.is_active.is_(True),
                    Kind.json["spec"]["deviceType"].as_string()
                    == DeviceType.CLOUD.value,
                    Kind.json["spec"]["cloudConfig"]["sandboxId"].as_string()
                    == sandbox_id,
                )
                .all()
            )
        if await _cloud_devices_have_running_tasks(device.user_id, devices):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Cloud device has running tasks. Use force_stop_tasks=true to proceed.",
            )
    return await restart_cloud_device(db, device.user_id, device.name)


def _reset_cloud_device_restart_handler_for_tests() -> None:
    """Clear the registered handler for isolated tests."""
    global _restart_handler

    _restart_handler = None
