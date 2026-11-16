# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Protocol integration coverage; no real DingTalk service is contacted."""

import asyncio
from dataclasses import replace
from unittest.mock import AsyncMock

import pytest
from socketio.exceptions import TimeoutError as SocketIOTimeoutError

from app.schemas.device import DeviceType
from app.services.device import capability_sync_rpc as rpc
from app.services.device.runtime_route import RuntimeRoute, RuntimeRouteError


def route(socket_id="old"):
    return RuntimeRoute(
        logical_device_id="app-record-1",
        runtime_device_id="runtime-1",
        runtime_instance_id="instance-1",
        device_type=DeviceType.APP,
        socket_id=socket_id,
        online_info={"runtime_features": {"pluginSync": {"protocolVersion": 2}}},
    )


PAYLOAD = {
    "device_id": "runtime-1",
    "scope": "plugin_delta",
    "mode": "merge",
    "plugin_sync": {"version": 2, "generation": 17, "complete": False},
    "plugins": [{"installed_plugin_id": 54, "name": "dingtalk"}],
}


async def call(sio, payload=None, timeout=2):
    return await rpc.call_capability_sync(
        sio,
        user_id=7,
        route=route(),
        payload=PAYLOAD if payload is None else payload,
        event="device:sync_capabilities",
        namespace="/local-executor",
        timeout_seconds=timeout,
    )


@pytest.mark.asyncio
async def test_reconnect_retries_same_generation_on_new_socket_and_cancels_old_wait(
    monkeypatch,
):
    started = asyncio.Event()
    cancelled = asyncio.Event()
    ack = {"success": True, "plugin_sync": PAYLOAD["plugin_sync"]}

    async def dispatch(event, payload, *, to, **kwargs):
        assert payload == PAYLOAD
        if to == "old":
            started.set()
            try:
                await asyncio.Future()
            finally:
                cancelled.set()
        assert cancelled.is_set()
        return ack

    async def changed(user_id, previous):
        assert user_id == 7
        await started.wait()
        if previous.socket_id == "old":
            return route("new")
        await asyncio.Future()

    sio = AsyncMock()
    sio.call.side_effect = dispatch
    monkeypatch.setattr(rpc, "_changed_route", changed)
    assert await call(sio) == ack
    assert [item.kwargs["to"] for item in sio.call.await_args_list] == ["old", "new"]
    assert all(item.args[1] == PAYLOAD for item in sio.call.await_args_list)


@pytest.mark.asyncio
async def test_ack_wins_without_extra_dispatch_and_monitor_is_cancelled(monkeypatch):
    monitor_started = asyncio.Event()
    monitor_cancelled = asyncio.Event()

    async def monitor(*args):
        monitor_started.set()
        try:
            await asyncio.Future()
        finally:
            monitor_cancelled.set()

    async def dispatch(*args, **kwargs):
        await monitor_started.wait()
        return {"success": False, "error": "package checksum mismatch"}

    monkeypatch.setattr(rpc, "_changed_route", monitor)
    sio = AsyncMock()
    sio.call.side_effect = dispatch
    assert (await call(sio))["error"] == "package checksum mismatch"
    assert sio.call.await_count == 1
    assert monitor_cancelled.is_set()


@pytest.mark.asyncio
@pytest.mark.parametrize("legacy", [False, True])
async def test_total_deadline_has_an_actionable_error_and_cleans_up(
    monkeypatch, legacy
):
    cancelled = []

    async def blocked(*args, **kwargs):
        try:
            await asyncio.Future()
        finally:
            cancelled.append(True)

    monkeypatch.setattr(rpc, "_changed_route", blocked)
    sio = AsyncMock()
    sio.call.side_effect = blocked
    with pytest.raises(TimeoutError, match="acknowledgement timed out"):
        await call(sio, payload={} if legacy else None, timeout=0.01)
    assert sio.call.await_count == 1
    assert len(cancelled) == 2


@pytest.mark.asyncio
async def test_route_monitor_revalidates_owned_device_after_redis_route_change(
    monkeypatch,
):
    monkeypatch.setattr(rpc, "ROUTE_CHECK_INTERVAL_SECONDS", 0)
    online = AsyncMock(side_effect=[None, {"socket_id": "old"}, {"socket_id": "new"}])
    resolve = AsyncMock(return_value=route("new"))
    monkeypatch.setattr(rpc.device_service, "get_device_online_info", online)
    monkeypatch.setattr(rpc.runtime_route_resolver, "resolve", resolve)
    assert await rpc._changed_route(7, route()) == route("new")
    resolve.assert_awaited_once_with(user_id=7, submitted_device_id="app-record-1")
    assert all(item.args == (7, "runtime-1") for item in online.await_args_list)


@pytest.mark.asyncio
@pytest.mark.parametrize("field", ["runtime_device_id", "runtime_instance_id"])
async def test_route_monitor_rejects_a_different_runtime(monkeypatch, field):
    monkeypatch.setattr(rpc, "ROUTE_CHECK_INTERVAL_SECONDS", 0)
    monkeypatch.setattr(
        rpc.device_service,
        "get_device_online_info",
        AsyncMock(return_value={"socket_id": "new"}),
    )
    monkeypatch.setattr(
        rpc.runtime_route_resolver,
        "resolve",
        AsyncMock(return_value=replace(route("new"), **{field: "different"})),
    )
    with pytest.raises(ConnectionError, match="Runtime changed"):
        await rpc._changed_route(7, route())


@pytest.mark.asyncio
async def test_access_revocation_is_not_retried(monkeypatch):
    async def revoked(*args):
        raise RuntimeRouteError("device_not_found", "access denied")

    monkeypatch.setattr(rpc, "_changed_route", revoked)
    sio = AsyncMock()

    # Keep the original RPC pending so revocation, rather than a reply, resolves it.
    async def pending(*args, **kwargs):
        await asyncio.Future()

    sio.call.side_effect = pending
    with pytest.raises(RuntimeRouteError, match="access denied"):
        await call(sio)
    assert sio.call.await_count == 1


@pytest.mark.asyncio
async def test_socketio_timeout_is_not_reported_as_an_empty_error():
    sio = AsyncMock()
    sio.call.side_effect = SocketIOTimeoutError()
    with pytest.raises(TimeoutError, match="acknowledgement timed out"):
        await call(sio)
    assert sio.call.await_count == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["legacy", "downgrade", "churn"])
async def test_unversioned_or_incompatible_or_unstable_routes_do_not_retry_forever(
    monkeypatch, kind
):
    started = asyncio.Queue()

    async def pending(*args, **kwargs):
        await started.put(None)
        await asyncio.Future()

    async def changed(user_id, previous):
        await started.get()
        current = route(previous.socket_id + "-new")
        return replace(current, online_info={}) if kind == "downgrade" else current

    monkeypatch.setattr(rpc, "_changed_route", changed)
    sio = AsyncMock()
    sio.call.side_effect = pending
    with pytest.raises(ConnectionError, match="retry synchronization"):
        await call(sio, payload={} if kind == "legacy" else None)
    assert sio.call.await_count == (3 if kind == "churn" else 1)
