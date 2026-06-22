# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the open-source admin device restart extension point."""

from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.dependencies import get_db
from app.api.endpoints.admin import device_monitor
from app.core import security
from app.schemas.device import DeviceType
from app.services.device import admin_device_restart


def _build_client(db):
    app = FastAPI()
    app.include_router(device_monitor.router, prefix="/admin")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[security.get_admin_user] = lambda: SimpleNamespace(
        id=1,
        user_name="admin",
        is_admin=True,
    )
    return TestClient(app)


def test_admin_device_restart_defaults_to_unimplemented(monkeypatch):
    """The open-source endpoint should stay generic unless an extension registers."""
    db = SimpleNamespace()
    device_kind = SimpleNamespace(
        json={"spec": {"deviceType": DeviceType.CLOUD.value}},
    )

    admin_device_restart._reset_admin_device_restart_handler_for_tests()
    monkeypatch.setattr(
        device_monitor.device_service,
        "get_device_by_device_id",
        lambda _db, user_id, device_id: device_kind,
    )

    response = _build_client(db).post(
        "/admin/device-monitor/devices/device-1/restart",
        json={"user_id": 7},
    )

    assert response.status_code == 200
    assert response.json() == {
        "success": False,
        "message": "Device restart is not configured in this deployment",
    }
