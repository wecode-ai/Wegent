# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock

import pytest


def _runtime_route():
    from app.schemas.device import DeviceType
    from app.services.device.runtime_route import RuntimeRoute

    return RuntimeRoute(
        logical_device_id="device-1",
        runtime_device_id="runtime-device-1",
        runtime_instance_id="runtime-instance-1",
        device_type=DeviceType.CLOUD,
        socket_id="socket-1",
        online_info={"socket_id": "socket-1"},
    )


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


def test_encode_runtime_rpc_response_compresses_large_browser_result() -> None:
    from app.services.device.runtime_rpc_service import (
        RUNTIME_RPC_COMPRESSED_ENCODING,
        RUNTIME_RPC_ENCODING_KEY,
        RuntimeRpcService,
        encode_runtime_rpc_response,
    )

    expected = {
        "success": True,
        "messages": [{"id": "m1", "content": "历史消息🙂" * 100000}],
    }

    encoded = encode_runtime_rpc_response(
        expected,
        method="runtime.tasks.transcript",
    )

    assert encoded[RUNTIME_RPC_ENCODING_KEY] == RUNTIME_RPC_COMPRESSED_ENCODING
    assert (
        RuntimeRpcService._decode_response(
            encoded,
            method="runtime.tasks.transcript",
        )
        == expected
    )


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
        module.runtime_route_resolver,
        "resolve",
        AsyncMock(return_value=_runtime_route()),
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
async def test_runtime_rpc_service_preserves_structured_worktree_unsupported_ack(
    monkeypatch,
):
    from app.services.device import runtime_rpc_service as module

    monkeypatch.setattr(
        module.runtime_route_resolver,
        "resolve",
        AsyncMock(return_value=_runtime_route()),
    )
    expected = {
        "success": False,
        "error": {
            "code": "worktree_unsupported",
            "message": "Managed Worktrees are not supported by this Runtime",
            "retryable": False,
        },
    }
    sio_call = AsyncMock(return_value=expected)
    monkeypatch.setattr(module, "get_sio", lambda: _socketio_with_call(sio_call))

    result = await module.RuntimeRpcService().call(
        user_id=7,
        device_id="device-1",
        method="runtime.worktrees.preflight",
        payload={"sourcePath": "/workspace/project"},
    )

    assert result == expected
    assert sio_call.await_count == 1


@pytest.mark.asyncio
async def test_runtime_rpc_service_decodes_compressed_ack(monkeypatch):
    from app.services.device import runtime_rpc_service as module

    expected = {
        "success": True,
        "messages": [{"id": "m1", "content": "hello" * 200000}],
    }
    monkeypatch.setattr(
        module.runtime_route_resolver,
        "resolve",
        AsyncMock(return_value=_runtime_route()),
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
async def test_runtime_rpc_service_preserves_oversized_response_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.services.device import runtime_rpc_service as module

    expected = {
        "success": False,
        "code": "runtime_rpc_response_too_large",
        "error": "Runtime RPC response exceeded the Socket.IO payload limit",
    }
    monkeypatch.setattr(
        module.runtime_route_resolver,
        "resolve",
        AsyncMock(return_value=_runtime_route()),
    )
    monkeypatch.setattr(
        module,
        "get_sio",
        lambda: _socketio_with_call(AsyncMock(return_value=expected)),
    )

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
        module.runtime_route_resolver,
        "resolve",
        AsyncMock(return_value=_runtime_route()),
    )
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


@pytest.mark.asyncio
async def test_runtime_rpc_service_projects_runtime_device_id_back_to_logical_id(
    monkeypatch,
):
    from app.services.device import runtime_rpc_service as module

    monkeypatch.setattr(
        module.runtime_route_resolver,
        "resolve",
        AsyncMock(return_value=_runtime_route()),
    )
    sio = _socketio_with_call(
        AsyncMock(
            return_value={
                "success": True,
                "deviceId": "runtime-device-1",
                "runtimeWorktrees": {"version": 1, "managed": True},
            }
        )
    )
    monkeypatch.setattr(module, "get_sio", lambda: sio)

    result = await module.RuntimeRpcService().call(
        user_id=7,
        device_id="device-1",
        method="runtime.worktrees.capabilities",
        payload={"deviceId": "device-1"},
    )

    assert result["deviceId"] == "device-1"


@pytest.mark.asyncio
async def test_runtime_rpc_service_projects_nested_worktree_device_ids(
    monkeypatch,
):
    from app.services.device import runtime_rpc_service as module

    monkeypatch.setattr(
        module.runtime_route_resolver,
        "resolve",
        AsyncMock(return_value=_runtime_route()),
    )
    sio = _socketio_with_call(
        AsyncMock(
            return_value={
                "success": True,
                "deviceId": "runtime-device-1",
                "items": [
                    {
                        "deviceId": "runtime-device-1",
                        "worktreeId": "worktree-1",
                        "conversations": [
                            {
                                "deviceId": "runtime-device-1",
                                "taskId": "task-1",
                            }
                        ],
                    }
                ],
            }
        )
    )
    monkeypatch.setattr(module, "get_sio", lambda: sio)

    result = await module.RuntimeRpcService().call(
        user_id=7,
        device_id="device-1",
        method="runtime.worktrees.list",
        payload={"deviceId": "device-1"},
    )

    assert result["deviceId"] == "device-1"
    assert result["items"][0]["deviceId"] == "device-1"
    assert result["items"][0]["conversations"][0]["deviceId"] == "device-1"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("socket_error_name", "expected_code", "expected_retryable"),
    [
        ("timeout", "runtime_rpc_timeout", True),
        ("disconnected", "device_disconnected", True),
        ("bad_namespace", "runtime_route_missing", False),
    ],
)
async def test_runtime_rpc_service_classifies_socket_error_retryability(
    monkeypatch,
    socket_error_name,
    expected_code,
    expected_retryable,
):
    from socketio.exceptions import BadNamespaceError, DisconnectedError
    from socketio.exceptions import TimeoutError as SocketTimeoutError

    from app.services.device import runtime_rpc_service as module

    errors = {
        "timeout": SocketTimeoutError(),
        "disconnected": DisconnectedError(),
        "bad_namespace": BadNamespaceError(),
    }
    monkeypatch.setattr(
        module.runtime_route_resolver,
        "resolve",
        AsyncMock(return_value=_runtime_route()),
    )
    sio_call = AsyncMock(side_effect=errors[socket_error_name])
    monkeypatch.setattr(module, "get_sio", lambda: _socketio_with_call(sio_call))

    with pytest.raises(module.RuntimeRpcError) as exc_info:
        await module.RuntimeRpcService().call(
            user_id=7,
            device_id="device-1",
            method="runtime.tasks.create",
            payload={"taskId": "task-1"},
            timeout_seconds=30,
        )

    assert exc_info.value.code == expected_code
    assert exc_info.value.retryable is expected_retryable
    assert sio_call.await_count == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("route_code", "retryable"),
    [
        ("device_not_found", False),
        ("device_offline", True),
        ("runtime_route_missing", True),
    ],
)
async def test_runtime_rpc_service_preserves_route_failures(
    monkeypatch,
    route_code,
    retryable,
):
    from app.services.device import runtime_rpc_service as module
    from app.services.device.runtime_route import RuntimeRouteError

    monkeypatch.setattr(
        module.runtime_route_resolver,
        "resolve",
        AsyncMock(
            side_effect=RuntimeRouteError(
                route_code,
                "route failed",
                retryable=retryable,
                details={"deviceId": "device-1"},
            )
        ),
    )
    get_sio = AsyncMock()
    monkeypatch.setattr(module, "get_sio", get_sio)

    with pytest.raises(module.RuntimeRpcError) as exc_info:
        await module.RuntimeRpcService().call(
            user_id=7,
            device_id="device-1",
            method="runtime.worktrees.prepare",
            payload={"taskId": "task-1"},
        )

    assert exc_info.value.code == route_code
    assert exc_info.value.retryable is retryable
    assert exc_info.value.details == {"deviceId": "device-1"}
    get_sio.assert_not_awaited()


@pytest.mark.asyncio
async def test_runtime_rpc_service_rejects_invalid_response(monkeypatch):
    from app.services.device import runtime_rpc_service as module

    monkeypatch.setattr(
        module.runtime_route_resolver,
        "resolve",
        AsyncMock(return_value=_runtime_route()),
    )
    monkeypatch.setattr(
        module,
        "get_sio",
        lambda: _socketio_with_call(AsyncMock(return_value=["not", "an", "object"])),
    )

    with pytest.raises(module.RuntimeRpcError) as exc_info:
        await module.RuntimeRpcService().call(
            user_id=7,
            device_id="device-1",
            method="runtime.tasks.list",
            payload={},
        )

    assert exc_info.value.code == "runtime_rpc_invalid_response"
