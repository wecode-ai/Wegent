# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""End-to-end unit contracts for Runtime feature online-state projection."""

import asyncio
import copy
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock

import pytest

from app.api.ws import device_namespace
from app.api.ws.device_namespace import DeviceNamespace
from app.models.kind import Kind
from app.schemas.device import DeviceType
from app.services.device import local_provider, remote_provider
from app.services.device.cloud_provider import CloudDeviceProvider
from app.services.device.remote_provider import RemoteDeviceProvider


class _MemoryDeviceCache:
    def __init__(self) -> None:
        self.values: dict[str, dict] = {}

    async def get(self, key: str):
        value = self.values.get(key)
        return copy.deepcopy(value) if value is not None else None

    async def set(self, key: str, value: dict, expire: int | None = None) -> bool:
        self.values[key] = copy.deepcopy(value)
        return True

    async def mget(self, keys: list[str]) -> dict[str, dict]:
        return {
            key: copy.deepcopy(self.values[key]) for key in keys if key in self.values
        }


def _runtime_features(*, managed: bool) -> dict:
    return {
        "schemaVersion": 3,
        "interactiveSessions": {
            "codeServer": False,
            "terminal": True,
        },
        "worktrees": {
            "version": 1,
            "managed": managed,
            "deferredPrepare": True,
            "snapshots": True,
            "restore": True,
            "preflight": True,
            "persistentStorageVerified": True,
        },
    }


def _device(user_id: int, device_id: str, device_type: DeviceType) -> Kind:
    spec = {
        "deviceId": device_id,
        "deviceType": device_type.value,
        "connectionMode": "websocket",
        "bindShell": "claudecode",
        "displayName": device_id,
        "isDefault": False,
    }
    if device_type == DeviceType.CLOUD:
        spec["cloudConfig"] = {
            "sandboxId": device_id,
            "deviceId": device_id,
        }
    if device_type == DeviceType.REMOTE:
        spec["remoteConfig"] = {
            "provider": "docker",
            "deviceId": device_id,
        }
    return Kind(
        user_id=user_id,
        kind="Device",
        name=device_id,
        namespace="default",
        is_active=True,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Device",
            "metadata": {"name": device_id, "namespace": "default"},
            "spec": spec,
        },
    )


def _patch_device_cache(monkeypatch) -> _MemoryDeviceCache:
    from app.core import cache as cache_module

    cache = _MemoryDeviceCache()
    monkeypatch.setattr(cache_module, "cache_manager", cache)
    monkeypatch.setattr(local_provider, "cache_manager", cache)
    monkeypatch.setattr(remote_provider, "cache_manager", cache)
    return cache


def _patch_namespace(
    monkeypatch,
    namespace: DeviceNamespace,
    session: dict,
) -> AsyncMock:
    @asynccontextmanager
    async def _passthrough_identity_lock(user_id):
        yield None

    monkeypatch.setattr(
        device_namespace, "app_identity_lock", _passthrough_identity_lock
    )
    monkeypatch.setattr(namespace, "get_session", AsyncMock(return_value=session))
    monkeypatch.setattr(namespace, "save_session", AsyncMock())
    monkeypatch.setattr(namespace, "enter_room", AsyncMock())
    monkeypatch.setattr(namespace, "_broadcast_device_online", AsyncMock())
    monkeypatch.setattr(namespace, "_broadcast_device_slot_update", AsyncMock())
    monkeypatch.setattr(
        namespace,
        "_sync_global_capabilities_to_registered_device",
        AsyncMock(),
    )
    monkeypatch.setattr(namespace, "_match_cloud_device", AsyncMock(return_value=None))
    monkeypatch.setattr(
        device_namespace,
        "run_sync_in_executor",
        AsyncMock(return_value=(True, "Runtime Device", None, None)),
    )
    reconcile = AsyncMock(return_value=0)
    monkeypatch.setattr(
        "app.tasks.robot_queue_tasks.reconcile_device_executions",
        reconcile,
    )
    return reconcile


async def _wait_for_registration_followups(namespace: DeviceNamespace) -> None:
    if namespace._background_tasks:
        await asyncio.gather(*tuple(namespace._background_tasks))


@pytest.mark.asyncio
async def test_cloud_registration_runtime_features_reach_provider_projection(
    test_db,
    test_user,
    monkeypatch,
):
    device_id = "cloud-runtime-features"
    test_db.add(_device(test_user.id, device_id, DeviceType.CLOUD))
    test_db.commit()
    _patch_device_cache(monkeypatch)
    namespace = DeviceNamespace()
    session = {"user_id": test_user.id, "client_ip": "198.51.100.10"}
    _patch_namespace(monkeypatch, namespace, session)
    monkeypatch.setattr(
        namespace,
        "_match_cloud_device",
        AsyncMock(return_value=device_id),
    )
    monkeypatch.setattr(
        "app.services.device.cloud_provider.executor_version_service.get_latest_version",
        AsyncMock(return_value="1.0.0"),
    )
    runtime_features = _runtime_features(managed=True)

    result = await namespace.on_device_register(
        "socket-cloud",
        {
            "device_id": device_id,
            "name": "Cloud Runtime",
            "device_type": DeviceType.CLOUD.value,
            "executor_version": "1.0.0",
            "runtime_instance_id": "runtime-instance-cloud",
            "runtime_features": runtime_features,
        },
    )
    await _wait_for_registration_followups(namespace)
    devices = await CloudDeviceProvider().list_devices(test_db, test_user.id)

    assert result == {"success": True, "device_id": device_id}
    assert devices[0]["status"] == "online"
    assert devices[0]["runtime_features"] == runtime_features
    assert (
        devices[0]["runtime_features"]["worktrees"]["persistentStorageVerified"] is True
    )


@pytest.mark.asyncio
async def test_remote_heartbeat_runtime_features_reach_provider_projection(
    test_db,
    test_user,
    monkeypatch,
):
    device_id = "remote-runtime-features"
    test_db.add(_device(test_user.id, device_id, DeviceType.REMOTE))
    test_db.commit()
    _patch_device_cache(monkeypatch)
    namespace = DeviceNamespace()
    session = {"user_id": test_user.id, "client_ip": "198.51.100.20"}
    _patch_namespace(monkeypatch, namespace, session)
    monkeypatch.setattr(
        "app.services.device.remote_provider.executor_version_service.get_latest_version",
        AsyncMock(return_value="1.0.0"),
    )

    registered = await namespace.on_device_register(
        "socket-remote",
        {
            "device_id": device_id,
            "name": "Remote Runtime",
            "device_type": DeviceType.REMOTE.value,
            "executor_version": "1.0.0",
            "runtime_instance_id": "runtime-instance-remote",
            "runtime_features": _runtime_features(managed=False),
        },
    )
    await _wait_for_registration_followups(namespace)
    runtime_features = _runtime_features(managed=True)
    heartbeat = await namespace.on_device_heartbeat(
        "socket-remote",
        {
            "device_id": device_id,
            "executor_version": "1.0.1",
            "runtime_instance_id": "runtime-instance-remote",
            "runtime_features": runtime_features,
        },
    )
    devices = await RemoteDeviceProvider().list_devices(test_db, test_user.id)

    assert registered == {"success": True, "device_id": device_id}
    assert heartbeat == {"success": True}
    assert devices[0]["status"] == "online"
    assert devices[0]["executor_version"] == "1.0.1"
    assert devices[0]["runtime_features"] == runtime_features
    assert (
        devices[0]["runtime_features"]["worktrees"]["persistentStorageVerified"] is True
    )


@pytest.mark.asyncio
async def test_app_heartbeat_reconciles_wegent_tasks(
    test_db,
    test_user,
    monkeypatch,
):
    device_id = "app-only-runtime"
    test_db.add(_device(test_user.id, device_id, DeviceType.APP))
    test_db.commit()
    _patch_device_cache(monkeypatch)
    namespace = DeviceNamespace()
    session = {"user_id": test_user.id, "client_ip": "198.51.100.40"}
    reconcile = _patch_namespace(monkeypatch, namespace, session)

    registered = await namespace.on_device_register(
        "socket-app",
        {
            "device_id": device_id,
            "name": "Local App Runtime",
            "device_type": DeviceType.APP.value,
            "executor_version": "1.0.0",
            "runtime_instance_id": "runtime-instance-app",
            "app_device_id": device_id,
        },
    )
    await _wait_for_registration_followups(namespace)
    heartbeat = await namespace.on_device_heartbeat(
        "socket-app",
        {
            "device_id": device_id,
            "executor_version": "1.0.1",
            "runtime_instance_id": "runtime-instance-app",
        },
    )
    await _wait_for_registration_followups(namespace)

    assert registered == {"success": True, "device_id": device_id}
    assert heartbeat == {"success": True}
    assert session["device_type"] == DeviceType.APP.value
    assert reconcile.await_count == 2
    reconcile.assert_any_await(
        user_id=test_user.id,
        device_id=device_id,
    )
    reconcile.assert_any_await(
        user_id=test_user.id,
        device_id=device_id,
        needs_confirmation_only=True,
    )


@pytest.mark.asyncio
async def test_malformed_runtime_features_do_not_block_registration_or_heartbeat(
    test_db,
    test_user,
    monkeypatch,
):
    device_id = "remote-malformed-runtime-features"
    test_db.add(_device(test_user.id, device_id, DeviceType.REMOTE))
    test_db.commit()
    _patch_device_cache(monkeypatch)
    namespace = DeviceNamespace()
    session = {"user_id": test_user.id, "client_ip": "198.51.100.30"}
    _patch_namespace(monkeypatch, namespace, session)

    registered = await namespace.on_device_register(
        "socket-remote-malformed",
        {
            "device_id": device_id,
            "name": "Remote Runtime",
            "device_type": DeviceType.REMOTE.value,
            "executor_version": "1.0.0",
            "runtime_instance_id": "runtime-instance-malformed",
            "runtime_features": {"schemaVersion": 0, "worktrees": "invalid"},
        },
    )
    await _wait_for_registration_followups(namespace)
    heartbeat = await namespace.on_device_heartbeat(
        "socket-remote-malformed",
        {
            "device_id": device_id,
            "executor_version": "1.0.1",
            "runtime_instance_id": "runtime-instance-malformed",
            "runtime_features": {"schemaVersion": "invalid"},
        },
    )
    devices = await RemoteDeviceProvider().list_devices(test_db, test_user.id)

    assert registered == {"success": True, "device_id": device_id}
    assert heartbeat == {"success": True}
    assert devices[0]["status"] == "online"
    assert devices[0]["executor_version"] == "1.0.1"
    assert devices[0]["runtime_features"] is None
