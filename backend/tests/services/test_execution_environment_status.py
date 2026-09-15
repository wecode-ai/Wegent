# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Regressions for stale CRD status and record-scoped device presence."""

from unittest.mock import AsyncMock

import pytest

from app.models.kind import Kind
from app.services.workspaces.environment_status import execution_environment_statuses


def device(record_id: int, device_type: str = "local", **spec: object) -> Kind:
    return Kind(
        id=record_id,
        user_id=7,
        namespace="default",
        kind="Device",
        name=f"device-{record_id}",
        is_active=True,
        json={"spec": {"deviceType": device_type, "status": "online", **spec}},
    )


@pytest.mark.asyncio
async def test_missing_heartbeat_overrides_all_persisted_online_states(monkeypatch):
    devices = [device(1), device(2, "remote"), device(3, "cloud"), device(4, "app")]
    devices[1].json = {"spec": {"deviceType": "remote"}, "status": {"state": "Ready"}}
    fetch = AsyncMock(return_value={})
    monkeypatch.setattr("app.core.cache.cache_manager.mget_or_raise", fetch)

    statuses = await execution_environment_statuses(devices)

    assert statuses == {1: "offline", 2: "offline", 3: "offline", 4: "offline"}
    fetch.assert_awaited_once_with(
        [
            "device:online:7:device-1",
            "device:online:7:device-2",
            "device:online:7:device-3",
            "device:online:7:app-record-4",
        ]
    )


@pytest.mark.asyncio
async def test_uses_owner_and_transport_identity_for_live_connections(monkeypatch):
    local = device(1, runtimeInstanceId="runtime-local")
    app = device(2, "app", runtimeInstanceId="runtime-app")
    cloud = device(3, "cloud", deviceId="cloud-socket")
    remote = device(4, "remote")
    remote.user_id = 8
    fetch = AsyncMock(
        return_value={
            "device:online:7:device-1": {
                "status": "busy",
                "runtime_instance_id": "runtime-local",
            },
            "device:online:7:app-record-2": {
                "status": "online",
                "runtime_instance_id": "runtime-app",
            },
            "device:online:7:cloud-socket": {"status": "online"},
            "device:online:8:device-4": {"status": "online"},
        }
    )
    monkeypatch.setattr("app.core.cache.cache_manager.mget_or_raise", fetch)

    assert await execution_environment_statuses([local, app, cloud, remote]) == {
        1: "online",
        2: "online",
        3: "online",
        4: "online",
    }
    fetch.assert_awaited_once_with(
        [
            "device:online:7:device-1",
            "device:online:7:app-record-2",
            "device:online:7:cloud-socket",
            "device:online:8:device-4",
        ]
    )


@pytest.mark.asyncio
async def test_rejects_other_runtime_and_legacy_app_presence(monkeypatch):
    local = device(1, runtimeInstanceId="current")
    app = device(2, "app", runtimeInstanceId="current")
    legacy_app = device(3, "app")
    fetch = AsyncMock(
        return_value={
            "device:online:7:device-1": {
                "status": "online",
                "runtime_instance_id": "old",
            },
            "device:online:7:app-record-2": {
                "status": "online",
                "runtime_instance_id": "old",
            },
            "device:online:7:app-record-3": {"status": "online"},
            "device:online:7:device-2": {
                "status": "online",
                "runtime_instance_id": "current",
            },
        }
    )
    monkeypatch.setattr("app.core.cache.cache_manager.mget_or_raise", fetch)

    assert await execution_environment_statuses([local, app, legacy_app]) == {
        1: "offline",
        2: "offline",
        3: "offline",
    }


@pytest.mark.asyncio
async def test_cloud_config_connection_and_inactive_records(monkeypatch):
    cloud = device(1, "cloud", cloudConfig={"deviceId": "cloud-runtime"})
    inactive = device(2)
    inactive.is_active = False
    fetch = AsyncMock(
        return_value={
            "device:online:7:cloud-runtime": {"status": "online"},
            "device:online:7:device-2": {"status": "online"},
        }
    )
    monkeypatch.setattr("app.core.cache.cache_manager.mget_or_raise", fetch)

    assert await execution_environment_statuses([cloud, inactive]) == {
        1: "online",
        2: "offline",
    }
    fetch.assert_awaited_once_with(["device:online:7:cloud-runtime"])


@pytest.mark.asyncio
async def test_cache_failure_is_not_reported_as_device_status(monkeypatch):
    fetch = AsyncMock(side_effect=ConnectionError("Redis unavailable"))
    monkeypatch.setattr("app.core.cache.cache_manager.mget_or_raise", fetch)

    with pytest.raises(ConnectionError, match="Redis unavailable"):
        await execution_environment_statuses([device(1)])
