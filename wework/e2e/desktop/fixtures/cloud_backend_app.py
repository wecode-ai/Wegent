# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Python-only Backend entrypoint for the isolated Wework desktop E2E matrix."""

import os

from fastapi import Depends
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.main import _fastapi_app, app
from app.models.user import User
from app.schemas.device import DeviceInfo, DeviceListResponse
from app.services.device_service import device_service

if os.environ.get("WEWORK_DESKTOP_E2E") != "1":
    raise RuntimeError(
        "The Wework desktop E2E Backend must not run outside its test harness"
    )


async def list_e2e_devices(
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> DeviceListResponse:
    """Expose the Rust-owned device listing contract to the SQLite-only E2E Backend."""
    devices = await device_service.get_all_devices(db, current_user.id)
    return DeviceListResponse(
        items=[DeviceInfo(**device) for device in devices],
        total=len(devices),
    )


_fastapi_app.add_api_route(
    "/api/devices",
    list_e2e_devices,
    methods=["GET"],
    response_model=DeviceListResponse,
    include_in_schema=False,
)
