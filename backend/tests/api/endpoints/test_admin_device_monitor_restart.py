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
from app.services.device.runtime_rpc_service import RuntimeRpcError


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


@pytest.mark.parametrize(
    ("provider_configured", "status_code", "message"),
    [
        (False, 501, "Device restart is not configured in this deployment"),
        (True, 502, "Provider temporarily unavailable"),
    ],
)
@pytest.mark.parametrize("instance_override", [False, True])
def test_cloud_device_restart_failure(
    monkeypatch, provider_configured, status_code, message, instance_override
):
    db = SimpleNamespace()
    device_kind = SimpleNamespace(
        user_id=7,
        name="device-1",
        json={"spec": {"deviceType": DeviceType.CLOUD.value}},
    )

    restart = (
        AsyncMock(
            return_value=cloud_device_restart.CloudDeviceRestartResult(
                success=False, message=message
            )
        )
        if provider_configured
        else None
    )
    monkeypatch.setattr(cloud_device_restart, "_restart_handler", restart)

    if instance_override:
        monkeypatch.setitem(
            devices.device_service.__dict__,
            "get_device_by_device_id",
            lambda *_args: pytest.fail("Instance lookup was not replaced"),
        )

    def lookup(_db, user_id, device_id):
        return device_kind

    # The admin endpoint imports the class and the user endpoint its singleton.
    # Patch both lookup sites without leaving attributes on the shared service.
    service = SimpleNamespace(get_device_by_device_id=lookup)
    monkeypatch.setattr(device_monitor, "device_service", service)
    monkeypatch.setattr(devices, "device_service", service)

    client = _build_client(db)
    response = client.post(
        "/admin/device-monitor/devices/device-1/restart", json={"user_id": 7}
    )

    assert response.status_code == 200
    assert response.json() == {
        "success": False,
        "message": message,
    }

    user_response = client.post(
        "/devices/device-1/upgrade", json={"force_stop_tasks": True}
    )
    assert user_response.status_code == status_code
    assert user_response.json()["detail"] == message


@pytest.mark.parametrize(
    ("path", "payload"),
    [
        ("/devices/claude/upgrade", {}),
        ("/admin/device-monitor/devices/claude/upgrade", {"user_id": 7}),
    ],
)
@pytest.mark.parametrize("with_sandbox", [True, False])
def test_cloud_upgrade_checks_sandbox_tasks_and_uses_restart(
    test_db, monkeypatch, path, payload, with_sandbox
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
                        "cloudConfig": {"sandboxId": sandbox} if with_sandbox else {},
                    }
                },
            )
        )
    test_db.flush()
    claude_key = LocalDeviceProvider.generate_online_key(7, "claude")
    claw_key = LocalDeviceProvider.generate_online_key(7, "openclaw-runtime")
    busy_key = claw_key if with_sandbox else claude_key
    expected_keys = {claude_key, claw_key} if with_sandbox else {claude_key}
    get_online = AsyncMock(return_value={busy_key: {"running_task_ids": [42]}})
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
        assert set(get_online.call_args.args[0]) == expected_keys
        restart.assert_not_awaited()

        get_online.return_value = {
            busy_key: {
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

        # The native scheduler does not include its active work in heartbeat IDs.
        get_online.return_value = {
            busy_key: {
                "runtime_features": {"runtimeTaskCreate": {"schemaVersions": [1]}}
            }
        }
        capacity = AsyncMock(return_value={"active": 1})
        monkeypatch.setattr(cloud_device_restart.runtime_rpc_service, "call", capacity)
        assert client.post(path, json=payload).status_code == 400
        capacity.assert_awaited_once_with(
            user_id=7,
            device_id="openclaw-runtime" if with_sandbox else "claude",
            method="runtime.capacity.get",
            payload={},
            timeout_seconds=5,
        )
        restart.assert_not_awaited()

        capacity.reset_mock()
        capacity.side_effect = RuntimeRpcError("executor stopped responding")
        assert client.post(path, json=payload).status_code == 503
        restart.assert_not_awaited()
        capacity.reset_mock()

        forced = client.post(path, json={**payload, "force_stop_tasks": True})
        capacity.assert_not_awaited()

        assert forced.status_code == 200
        assert forced.json() == {"success": True, "message": "Restart requested"}
        restart.assert_awaited_once_with(test_db, 7, "claude")

        missing = client.post(path.replace("/claude/", "/other-owner/"), json=payload)
        assert missing.status_code == 404
        assert restart.await_count == 1

        capacity.side_effect = None
        capacity.return_value = {"active": 0}
        idle = client.post(path, json=payload)
        assert idle.status_code == 200
        assert idle.json() == forced.json()
        assert restart.await_count == 2
