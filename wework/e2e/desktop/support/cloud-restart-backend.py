# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Run the public Backend with the desktop E2E sandbox process controller."""

import os
from urllib.parse import quote

import httpx
from sqlalchemy.orm import Session

from app.main import app
from app.services.device.cloud_device_restart import (
    CloudDeviceRestartResult,
    register_cloud_device_restart_handler,
)
from app.services.device_service import DeviceService

__all__ = ["app"]

CONTROL_URL = os.environ["WEWORK_E2E_SANDBOX_CONTROL_URL"]


async def restart_ci_sandbox(
    db: Session, user_id: int, device_id: str
) -> CloudDeviceRestartResult:
    device = DeviceService.get_device_by_device_id(db, user_id, device_id)
    sandbox_id = (
        (device.json["spec"].get("cloudConfig") or {}).get("sandboxId")
        if device is not None
        else None
    )
    if not sandbox_id:
        return CloudDeviceRestartResult(False, "Device has no E2E sandbox")
    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{CONTROL_URL}/e2e/sandboxes/{quote(sandbox_id, safe='')}/restart"
            )
            response.raise_for_status()
    except httpx.HTTPError as error:
        return CloudDeviceRestartResult(False, f"E2E sandbox restart failed: {error}")
    return CloudDeviceRestartResult(True, "E2E sandbox restart accepted")


register_cloud_device_restart_handler(restart_ci_sandbox)
