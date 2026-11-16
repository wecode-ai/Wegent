# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the open-source admin device restart extension point."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.dependencies import get_db
from app.api.endpoints import devices
from app.api.endpoints.admin import device_monitor
from app.core import security
from app.models.kind import Kind
from app.schemas.device import DeviceType
from app.services.device import cloud_device_restart
from app.services.device.local_provider import LocalDeviceProvider


def _build_client(db):
    app = FastAPI()
    app.include_router(device_monitor.router, prefix="/admin")
    app.include_router(devices.router, prefix="/devices")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[security.get_current_user] = lambda: SimpleNamespace(
        id=7, user_name="owner"
    )
    app.dependency_overrides[security.get_admin_user] = lambda: SimpleNamespace(
        id=1,
        user_name="admin",
        is_admin=True,
    )
    return TestClient(app)


def test_cloud_device_restart_defaults_to_unimplemented(monkeypatch):
    """The open-source endpoint should stay generic unless an extension registers."""
    db = SimpleNamespace()
    device_kind = SimpleNamespace(
        json={"spec": {"deviceType": DeviceType.CLOUD.value}},
    )

    monkeypatch.setattr(cloud_device_restart, "_restart_handler", None)
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


@pytest.mark.parametrize(
    ("path", "payload"),
    [
        ("/devices/claude/upgrade", {}),
        ("/admin/device-monitor/devices/claude/upgrade", {"user_id": 7}),
    ],
)
def test_cloud_upgrade_checks_sandbox_tasks_and_uses_restart(
    test_db, monkeypatch, path, payload
):
    for owner, name, sandbox in (
        (7, "claude", "shared"),
        (7, "openclaw", "shared"),
        (7, "unrelated", "different"),
        (8, "other-owner", "shared"),
    ):
        test_db.add(
            Kind(
                user_id=owner,
                name=name,
                namespace="default",
                kind="Device",
                is_active=True,
                json={
                    "spec": {
                        "deviceId": "openclaw-runtime" if name == "openclaw" else name,
                        "deviceType": DeviceType.CLOUD.value,
                        "cloudConfig": {"sandboxId": sandbox},
                    }
                },
            )
        )
    test_db.flush()
    claude_key = LocalDeviceProvider.generate_online_key(7, "claude")
    claw_key = LocalDeviceProvider.generate_online_key(7, "openclaw-runtime")
    get_online = AsyncMock(return_value={claw_key: {"running_task_ids": [42]}})
    restart = AsyncMock(
        return_value=cloud_device_restart.CloudDeviceRestartResult(
            success=True, message="Restart requested"
        )
    )
    monkeypatch.setattr(cloud_device_restart.cache_manager, "mget_or_raise", get_online)
    monkeypatch.setattr(cloud_device_restart, "_restart_handler", restart)

    with _build_client(test_db) as client:
        blocked = client.post(path, json=payload)
        assert blocked.status_code == 400
        assert "running tasks" in blocked.json()["detail"]
        assert set(get_online.call_args.args[0]) == {claude_key, claw_key}
        restart.assert_not_awaited()

        get_online.return_value = {
            claw_key: {
                "runtime_capacity": {
                    "active": 1,
                    "limit": 3,
                    "active_task_ids": ["live-run"],
                }
            }
        }
        blocked_runtime_work = client.post(path, json=payload)
        assert blocked_runtime_work.status_code == 400
        assert "running tasks" in blocked_runtime_work.json()["detail"]
        restart.assert_not_awaited()

        forced = client.post(path, json={**payload, "force_stop_tasks": True})
        assert forced.status_code == 200
        assert forced.json() == {"success": True, "message": "Restart requested"}
        restart.assert_awaited_once_with(test_db, 7, "claude")

        missing = client.post(path.replace("/claude/", "/other-owner/"), json=payload)
        assert missing.status_code == 404
        assert restart.await_count == 1

        get_online.return_value = {}
        idle = client.post(path, json=payload)
        assert idle.status_code == 200
        assert idle.json() == forced.json()
        assert restart.await_count == 2
