# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the admin device monitor restart extension registration."""

from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

import app.api.api  # noqa: F401  register routers and finalize wecode patches
from app.api.dependencies import get_db
from app.api.router import api_router
from app.core import security
from app.schemas.device import DeviceType
from app.services.device import admin_device_restart
from wecode.api import device_monitor_patch, finalize_patches


class _FakeCloudDeviceProvider:
    def __init__(self):
        self.restart_device_kwargs = None

    async def restart_device(self, **kwargs):
        self.restart_device_kwargs = kwargs
        return {
            "device_id": kwargs["device_id"],
            "sandbox_id": "sandbox-1",
            "result": {"status": "accepted"},
        }


def test_admin_device_restart_registration_updates_real_route_behavior(monkeypatch):
    """The admin restart route should execute the registered private provider path."""
    db = SimpleNamespace()
    provider = _FakeCloudDeviceProvider()
    device_kind = SimpleNamespace(
        json={"spec": {"deviceType": DeviceType.CLOUD.value}},
    )
    app = FastAPI()

    admin_device_restart._reset_admin_device_restart_handler_for_tests()
    monkeypatch.setattr(device_monitor_patch, "cloud_device_provider", provider)
    monkeypatch.setattr(
        device_monitor_patch.device_service,
        "get_device_by_device_id",
        lambda _db, user_id, device_id: device_kind,
    )

    device_monitor_patch.apply_patch()
    finalize_patches()

    app.include_router(api_router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[security.get_admin_user] = lambda: SimpleNamespace(
        id=1,
        user_name="admin",
        is_admin=True,
    )

    response = TestClient(app).post(
        "/api/admin/device-monitor/devices/device-1/restart",
        json={"user_id": 7},
    )

    assert response.status_code == 200
    assert response.json() == {
        "success": True,
        "message": "Restart command sent successfully",
    }
    assert provider.restart_device_kwargs == {
        "db": db,
        "user_id": 7,
        "device_id": "device-1",
    }
