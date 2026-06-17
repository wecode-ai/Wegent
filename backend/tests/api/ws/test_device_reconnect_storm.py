# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
from unittest.mock import AsyncMock

import pytest

from app.api.ws import device_namespace
from app.api.ws.device_namespace import DeviceNamespace


@pytest.mark.asyncio
async def test_device_register_does_not_wait_for_capability_sync(monkeypatch):
    namespace = DeviceNamespace()
    sync_started = asyncio.Event()
    sync_release = asyncio.Event()

    async def fake_get_session(sid):
        return {
            "user_id": 7,
            "client_ip": "127.0.0.1",
        }

    async def fake_run_sync_in_executor(func, *args):
        return True, "MacBook", None

    async def slow_capability_sync(*, user_id, device_id):
        sync_started.set()
        await sync_release.wait()

    monkeypatch.setattr(namespace, "get_session", fake_get_session)
    monkeypatch.setattr(namespace, "save_session", AsyncMock())
    monkeypatch.setattr(namespace, "enter_room", AsyncMock())
    monkeypatch.setattr(namespace, "_match_cloud_device", AsyncMock(return_value=None))
    monkeypatch.setattr(namespace, "_broadcast_device_online", AsyncMock())
    monkeypatch.setattr(
        namespace,
        "_sync_global_capabilities_to_registered_device",
        slow_capability_sync,
    )
    monkeypatch.setattr(
        device_namespace,
        "run_sync_in_executor",
        fake_run_sync_in_executor,
    )
    monkeypatch.setattr(
        device_namespace.device_service,
        "set_device_online",
        AsyncMock(return_value=True),
    )

    register_task = asyncio.create_task(
        namespace.on_device_register(
            "sid-1",
            {
                "device_id": "device-1",
                "name": "MacBook",
                "executor_version": "1.8.0",
            },
        )
    )

    await asyncio.wait_for(sync_started.wait(), timeout=0.5)
    result = await asyncio.wait_for(register_task, timeout=0.5)

    assert result == {"success": True, "device_id": "device-1"}
    sync_release.set()


@pytest.mark.asyncio
async def test_device_register_debounces_repeated_db_upserts(monkeypatch):
    namespace = DeviceNamespace()
    upsert_calls = 0

    async def fake_get_session(sid):
        return {
            "user_id": 7,
            "client_ip": "127.0.0.1",
        }

    async def fake_run_sync_in_executor(func, *args):
        nonlocal upsert_calls
        upsert_calls += 1
        return True, "MacBook", None

    monkeypatch.setattr(namespace, "get_session", fake_get_session)
    monkeypatch.setattr(namespace, "save_session", AsyncMock())
    monkeypatch.setattr(namespace, "enter_room", AsyncMock())
    monkeypatch.setattr(namespace, "_match_cloud_device", AsyncMock(return_value=None))
    monkeypatch.setattr(namespace, "_broadcast_device_online", AsyncMock())
    monkeypatch.setattr(
        namespace,
        "_sync_global_capabilities_to_registered_device",
        AsyncMock(),
    )
    monkeypatch.setattr(
        device_namespace,
        "run_sync_in_executor",
        fake_run_sync_in_executor,
    )
    monkeypatch.setattr(
        device_namespace.device_service,
        "set_device_online",
        AsyncMock(return_value=True),
    )

    payload = {
        "device_id": "device-1",
        "name": "MacBook",
        "executor_version": "1.8.0",
    }

    first = await namespace.on_device_register("sid-1", payload)
    second = await namespace.on_device_register("sid-2", payload)

    assert first == {"success": True, "device_id": "device-1"}
    assert second == {"success": True, "device_id": "device-1"}
    assert upsert_calls == 1


def test_connection_rate_limit_tracks_attempt_window():
    namespace = DeviceNamespace()
    key = "ip:127.0.0.1"

    for _ in range(device_namespace.DEVICE_CONNECT_RATE_LIMIT_MAX_ATTEMPTS):
        assert namespace._is_connection_rate_limited(key, now=100.0) is False

    assert namespace._is_connection_rate_limited(key, now=100.0) is True

    reset_at = 100.0 + device_namespace.DEVICE_CONNECT_RATE_LIMIT_WINDOW_SECONDS + 0.1
    assert namespace._is_connection_rate_limited(key, now=reset_at) is False


@pytest.mark.asyncio
async def test_stale_disconnect_does_not_clear_newer_device_socket(monkeypatch):
    namespace = DeviceNamespace()

    async def fake_get_session(sid):
        return {
            "user_id": 7,
            "device_id": "device-1",
            "request_id": "req-1",
        }

    monkeypatch.setattr(namespace, "get_session", fake_get_session)
    monkeypatch.setattr(
        device_namespace.device_service,
        "get_device_online_info",
        AsyncMock(return_value={"socket_id": "sid-new"}),
    )
    set_offline = AsyncMock()
    monkeypatch.setattr(
        device_namespace.device_service, "set_device_offline", set_offline
    )
    monkeypatch.setattr(
        device_namespace,
        "run_sync_in_executor",
        AsyncMock(return_value=[]),
    )
    monkeypatch.setattr(namespace, "_broadcast_device_offline", AsyncMock())

    await namespace.on_disconnect("sid-old")

    set_offline.assert_not_awaited()
    device_namespace.run_sync_in_executor.assert_not_awaited()
    namespace._broadcast_device_offline.assert_not_awaited()


@pytest.mark.asyncio
async def test_transient_disconnect_rechecks_device_before_failing_tasks(monkeypatch):
    namespace = DeviceNamespace()

    async def fake_get_session(sid):
        return {
            "user_id": 7,
            "device_id": "device-1",
            "request_id": "req-1",
        }

    monkeypatch.setattr(namespace, "get_session", fake_get_session)
    monkeypatch.setattr(
        device_namespace.device_service,
        "get_device_online_info",
        AsyncMock(
            side_effect=[
                {"socket_id": "sid-old"},
                {"socket_id": "sid-new"},
            ]
        ),
    )
    monkeypatch.setattr(device_namespace.asyncio, "sleep", AsyncMock())
    set_offline = AsyncMock()
    monkeypatch.setattr(
        device_namespace.device_service, "set_device_offline", set_offline
    )
    monkeypatch.setattr(
        device_namespace,
        "run_sync_in_executor",
        AsyncMock(return_value=[]),
    )
    monkeypatch.setattr(namespace, "_broadcast_device_offline", AsyncMock())

    await namespace.on_disconnect("sid-old")

    device_namespace.asyncio.sleep.assert_awaited_once()
    set_offline.assert_not_awaited()
    device_namespace.run_sync_in_executor.assert_not_awaited()
    namespace._broadcast_device_offline.assert_not_awaited()
