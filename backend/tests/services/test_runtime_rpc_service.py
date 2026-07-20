# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock

import pytest


def _compressed_runtime_rpc_response(response: dict):
    import base64
    import gzip
    import json

    raw = json.dumps(response, ensure_ascii=False, separators=(",", ":")).encode(
        "utf-8"
    )
    compressed = gzip.compress(raw)
    return {
        "__runtimeRpcEncoding": "gzip+base64+json",
        "payload": base64.b64encode(compressed).decode("ascii"),
        "rawBytes": len(raw),
        "compressedBytes": len(compressed),
    }


class _SocketManager:
    def __init__(self, *, connected: bool = True):
        self.connected = connected

    def is_connected(self, sid: str, namespace: str) -> bool:
        assert sid == "socket-1"
        assert namespace == "/local-executor"
        return self.connected


def _socketio_with_call(call: AsyncMock, *, connected: bool = True):
    return type(
        "Sio",
        (),
        {
            "call": call,
            "manager": _SocketManager(connected=connected),
        },
    )()


@pytest.mark.asyncio
async def test_runtime_rpc_service_returns_runtime_failure_ack(monkeypatch):
    from app.services.device import runtime_rpc_service as module

    monkeypatch.setattr(
        module.device_service,
        "get_device_online_info",
        AsyncMock(return_value={"socket_id": "socket-1"}),
    )
    sio_call = AsyncMock(
        return_value={
            "success": False,
            "error": "Runtime send adapter is not available",
        }
    )
    sio = _socketio_with_call(sio_call)
    monkeypatch.setattr(module, "get_sio", lambda: sio)

    result = await module.RuntimeRpcService().call(
        user_id=7,
        device_id="device-1",
        method="runtime.tasks.send",
        payload={"localTaskId": "codex-1"},
        timeout_seconds=30,
    )

    assert result == {
        "success": False,
        "error": "Runtime send adapter is not available",
    }
    sio.call.assert_awaited_once_with(
        "runtime:rpc",
        {
            "method": "runtime.tasks.send",
            "payload": {"localTaskId": "codex-1"},
        },
        to="socket-1",
        namespace="/local-executor",
        timeout=35,
    )


@pytest.mark.asyncio
async def test_runtime_rpc_service_decodes_compressed_ack(monkeypatch):
    from app.services.device import runtime_rpc_service as module

    expected = {
        "success": True,
        "messages": [{"id": "m1", "content": "hello" * 200000}],
    }
    monkeypatch.setattr(
        module.device_service,
        "get_device_online_info",
        AsyncMock(return_value={"socket_id": "socket-1"}),
    )
    sio = _socketio_with_call(
        AsyncMock(return_value=_compressed_runtime_rpc_response(expected))
    )
    monkeypatch.setattr(module, "get_sio", lambda: sio)

    result = await module.RuntimeRpcService().call(
        user_id=7,
        device_id="device-1",
        method="runtime.tasks.transcript",
        payload={"localTaskId": "codex-1"},
        timeout_seconds=30,
    )

    assert result == expected


@pytest.mark.asyncio
async def test_runtime_rpc_service_routes_to_socket_on_another_worker(monkeypatch):
    from app.services.device import runtime_rpc_service as module

    monkeypatch.setattr(
        module.device_service,
        "get_device_online_info",
        AsyncMock(return_value={"socket_id": "socket-1"}),
    )
    set_offline = AsyncMock()
    monkeypatch.setattr(module.device_service, "set_device_offline", set_offline)
    sio_call = AsyncMock(return_value={"success": True, "workspaces": []})
    sio = _socketio_with_call(sio_call, connected=False)
    monkeypatch.setattr(module, "get_sio", lambda: sio)

    result = await module.RuntimeRpcService().call(
        user_id=7,
        device_id="device-1",
        method="runtime.tasks.list",
        payload={},
        timeout_seconds=30,
    )

    assert result == {"success": True, "workspaces": []}
    sio_call.assert_awaited_once()
    set_offline.assert_not_awaited()
