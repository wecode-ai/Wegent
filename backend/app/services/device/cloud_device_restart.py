# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Deployment-specific cloud device restart."""

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


@dataclass(frozen=True)
class CloudDeviceRestartResult:
    """Result returned by a cloud device restart implementation."""

    success: bool
    message: str


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
        )

    return await _restart_handler(db, user_id, device_id)


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
        keys = {
            LocalDeviceProvider.generate_online_key(
                device.user_id, device_connection_route_id(sibling)
            )
            for sibling in devices
        }
        online = await cache_manager.mget_or_raise(sorted(keys))
        if any(
            info
            and (info.get("running_task_ids") or runtime_capacity_slot_values(info)[0])
            for info in online.values()
        ):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Cloud device has running tasks. Use force_stop_tasks=true to proceed.",
            )
    return await restart_cloud_device(db, device.user_id, device.name)


def _reset_cloud_device_restart_handler_for_tests() -> None:
    """Clear the registered handler for isolated tests."""
    global _restart_handler

    _restart_handler = None
