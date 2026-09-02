# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock

import pytest

from shared.telemetry.context import set_request_context


def _runtime_route(
    *, runtime_features=None, device_type=None, app_device_id: str | None = None
):
    from app.schemas.device import DeviceType
    from app.services.device.runtime_route import RuntimeRoute

    return RuntimeRoute(
        logical_device_id="device-1",
        runtime_device_id="runtime-device-1",
        runtime_instance_id="runtime-instance-1",
        device_type=device_type or DeviceType.CLOUD,
        socket_id="socket-1",
        online_info={
            "socket_id": "socket-1",
            **(
                {"runtime_features": runtime_features}
                if runtime_features is not None
                else {}
            ),
        },
        app_device_id=app_device_id,
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
async def test_runtime_rpc_service_propagates_request_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.services.device import runtime_rpc_service as module

    async def resolve_route(**_kwargs):
        set_request_context("changed-during-route-resolution")
        return _runtime_route()

    monkeypatch.setattr(
        module.runtime_route_resolver,
        "resolve",
        AsyncMock(side_effect=resolve_route),
    )
    sio_call = AsyncMock(return_value={"accepted": True})
    monkeypatch.setattr(module, "get_sio", lambda: _socketio_with_call(sio_call))
    set_request_context("cloud-runtime-request-1")

    await module.RuntimeRpcService().call(
        user_id=7,
        device_id="device-1",
        method="runtime.tasks.list",
        payload={},
    )

    assert sio_call.await_args.args[1]["request_id"] == "cloud-runtime-request-1"


@pytest.mark.asyncio
async def test_runtime_rpc_service_applies_account_proxy_to_remote_model_configs(
    monkeypatch,
):
    from app.services.device import runtime_rpc_service as module

    monkeypatch.setattr(
        module.runtime_route_resolver,
        "resolve",
        AsyncMock(return_value=_runtime_route()),
    )
    monkeypatch.setattr(
        module,
        "_load_remote_runtime_proxy_url",
        lambda user_id: (
            "socks5://proxy.internal:7890"
            if user_id == 7
            else pytest.fail("unexpected user")
        ),
    )
    sio_call = AsyncMock(return_value={"accepted": True})
    monkeypatch.setattr(module, "get_sio", lambda: _socketio_with_call(sio_call))

    await module.RuntimeRpcService().call(
        user_id=7,
        device_id="device-1",
        method="runtime.tasks.create",
        payload={
            "runtime": "codex",
            "executionRequest": {
                "model_config": {
                    "proxy": {"url": "http://127.0.0.1:7897"},
                    "runtime_config": {
                        "codex": {
                            "use_user_config": True,
                            "configured": True,
                        }
                    },
                }
            },
            "friendlyTitleExecutionRequest": {"model_config": {}},
            "initialSupervisor": {"modelConfig": {}},
        },
    )

    emitted = sio_call.await_args.args[1]["payload"]
    for model_config in (
        emitted["executionRequest"]["model_config"],
        emitted["friendlyTitleExecutionRequest"]["model_config"],
        emitted["initialSupervisor"]["modelConfig"],
    ):
        assert model_config["proxy"] == {"url": "socks5://proxy.internal:7890"}
        assert model_config["runtime_config"]["codex"]["use_proxy"] is True
        assert model_config["runtime_config"]["codex"]["proxy_configured"] is True
    assert (
        emitted["executionRequest"]["model_config"]["runtime_config"]["codex"][
            "use_user_config"
        ]
        is True
    )


@pytest.mark.asyncio
async def test_runtime_rpc_service_bypasses_proxy_for_cloud_model_gateway(
    monkeypatch,
):
    from app.services.device import runtime_rpc_service as module

    monkeypatch.setattr(
        module.runtime_route_resolver,
        "resolve",
        AsyncMock(return_value=_runtime_route()),
    )
    monkeypatch.setattr(
        module,
        "_load_remote_runtime_proxy_url",
        lambda _user_id: "http://proxy.internal:7890",
    )
    sio_call = AsyncMock(return_value={"accepted": True})
    monkeypatch.setattr(module, "get_sio", lambda: _socketio_with_call(sio_call))

    await module.RuntimeRpcService().call(
        user_id=7,
        device_id="device-1",
        method="runtime.tasks.create",
        payload={
            "executionRequest": {
                "model_config": {
                    "wework_model_kind": "cloud",
                    "base_url": (
                        "http://10.218.32.65:8000/api/runtime-work/"
                        "llm-responses-proxy"
                    ),
                    "api_key": "desktop-token",
                    "proxy": {"url": "http://stale-proxy.internal:7890"},
                    "vision_sidecar": {
                        "request_url": (
                            "http://10.218.32.65:8000/api/runtime-work/"
                            "llm-responses-proxy/responses"
                        ),
                    },
                }
            },
            "friendlyTitleExecutionRequest": {
                "model_config": {
                    "wework_model_kind": "codex-official",
                }
            },
        },
    )

    emitted = sio_call.await_args.args[1]["payload"]
    cloud_model = emitted["executionRequest"]["model_config"]
    assert cloud_model["base_url"] == (
        "http://10.218.32.65:8000/api/runtime-work/llm-responses-proxy"
    )
    assert cloud_model["vision_sidecar"]["request_url"] == (
        "http://10.218.32.65:8000/api/runtime-work/llm-responses-proxy/responses"
    )
    assert cloud_model["api_key"] == "desktop-token"
    assert "proxy" not in cloud_model
    assert cloud_model["runtime_config"]["codex"] == {
        "use_proxy": False,
        "proxy_configured": False,
    }
    title_model = emitted["friendlyTitleExecutionRequest"]["model_config"]
    assert title_model["proxy"] == {"url": "http://proxy.internal:7890"}
    assert title_model["runtime_config"]["codex"] == {
        "use_proxy": True,
        "proxy_configured": True,
    }


@pytest.mark.asyncio
async def test_runtime_rpc_service_removes_client_proxy_without_account_proxy(
    monkeypatch,
):
    from app.services.device import runtime_rpc_service as module

    monkeypatch.setattr(
        module.runtime_route_resolver,
        "resolve",
        AsyncMock(return_value=_runtime_route()),
    )
    monkeypatch.setattr(module, "_load_remote_runtime_proxy_url", lambda _user_id: "")
    sio_call = AsyncMock(return_value={"accepted": True})
    monkeypatch.setattr(module, "get_sio", lambda: _socketio_with_call(sio_call))

    await module.RuntimeRpcService().call(
        user_id=7,
        device_id="device-1",
        method="runtime.tasks.send",
        payload={
            "executionRequest": {
                "model_config": {
                    "proxy": {"url": "http://127.0.0.1:7897"},
                    "proxy_url": "http://127.0.0.1:7897",
                }
            }
        },
    )

    model_config = sio_call.await_args.args[1]["payload"]["executionRequest"][
        "model_config"
    ]
    assert "proxy" not in model_config
    assert "proxy_url" not in model_config
    assert model_config["runtime_config"]["codex"] == {
        "use_proxy": False,
        "proxy_configured": False,
    }


@pytest.mark.asyncio
async def test_runtime_rpc_service_applies_account_proxy_to_automation_payloads(
    monkeypatch,
):
    from app.services.device import runtime_rpc_service as module

    monkeypatch.setattr(
        module.runtime_route_resolver,
        "resolve",
        AsyncMock(return_value=_runtime_route()),
    )
    monkeypatch.setattr(
        module,
        "_load_remote_runtime_proxy_url",
        lambda _user_id: "http://proxy.internal:7890",
    )
    sio_call = AsyncMock(return_value={"automation": {"id": "automation-1"}})
    monkeypatch.setattr(module, "get_sio", lambda: _socketio_with_call(sio_call))

    await module.RuntimeRpcService().call(
        user_id=7,
        device_id="device-1",
        method="runtime.automations.create",
        payload={
            "automation": {
                "taskPayload": {"executionRequest": {"model_config": {}}},
                "continuationPayload": {"executionRequest": {"model_config": {}}},
            }
        },
    )

    automation = sio_call.await_args.args[1]["payload"]["automation"]
    for model_config in (
        automation["taskPayload"]["executionRequest"]["model_config"],
        automation["continuationPayload"]["executionRequest"]["model_config"],
    ):
        assert model_config["proxy"] == {"url": "http://proxy.internal:7890"}


@pytest.mark.asyncio
async def test_runtime_rpc_service_preserves_local_device_proxy(monkeypatch):
    from app.schemas.device import DeviceType
    from app.services.device import runtime_rpc_service as module

    monkeypatch.setattr(
        module.runtime_route_resolver,
        "resolve",
        AsyncMock(return_value=_runtime_route(device_type=DeviceType.LOCAL)),
    )
    load_proxy = AsyncMock()
    monkeypatch.setattr(module, "_load_remote_runtime_proxy_url", load_proxy)
    sio_call = AsyncMock(return_value={"accepted": True})
    monkeypatch.setattr(module, "get_sio", lambda: _socketio_with_call(sio_call))

    await module.RuntimeRpcService().call(
        user_id=7,
        device_id="device-1",
        method="runtime.tasks.send",
        payload={
            "executionRequest": {
                "model_config": {
                    "proxy": {"url": "http://127.0.0.1:7897"},
                }
            }
        },
    )

    emitted = sio_call.await_args.args[1]["payload"]
    assert emitted["executionRequest"]["model_config"]["proxy"] == {
        "url": "http://127.0.0.1:7897"
    }
    load_proxy.assert_not_called()


@pytest.mark.asyncio
async def test_runtime_rpc_service_rejects_app_device_when_remote_control_is_disabled(
    monkeypatch,
):
    from app.schemas.device import DeviceType
    from app.services.device import runtime_rpc_service as module

    monkeypatch.setattr(
        module.runtime_route_resolver,
        "resolve",
        AsyncMock(return_value=_runtime_route(device_type=DeviceType.APP)),
    )
    sio_call = AsyncMock(return_value={"accepted": True})
    monkeypatch.setattr(module, "get_sio", lambda: _socketio_with_call(sio_call))

    with pytest.raises(module.RuntimeRpcError) as exc_info:
        await module.RuntimeRpcService().call(
            user_id=7,
            device_id="device-1",
            method="runtime.capacity.get",
            payload={},
        )

    assert exc_info.value.code == "remote_control_disabled"
    assert exc_info.value.retryable is False
    assert str(exc_info.value) == "Remote control is disabled for this app device"
    sio_call.assert_not_awaited()


@pytest.mark.asyncio
async def test_runtime_rpc_service_sends_v2_to_capable_executor(monkeypatch):
    from app.services.device import runtime_rpc_service as module

    monkeypatch.setattr(
        module.runtime_route_resolver,
        "resolve",
        AsyncMock(
            return_value=_runtime_route(
                runtime_features={
                    "schemaVersion": 2,
                    "runtimeTaskCreate": {
                        "schemaVersions": [1, 2],
                        "features": {"goal": True},
                    },
                }
            )
        ),
    )
    sio_call = AsyncMock(return_value={"accepted": True})
    monkeypatch.setattr(module, "get_sio", lambda: _socketio_with_call(sio_call))

    await module.RuntimeRpcService().call(
        user_id=7,
        device_id="device-1",
        method="runtime.tasks.create",
        payload={
            "schemaVersion": 2,
            "runtime": "codex",
            "message": "Implement",
            "initialGoal": {"objective": "Finish"},
        },
    )

    emitted = sio_call.await_args.args[1]["payload"]
    assert emitted["schemaVersion"] == 2
    assert emitted["initialGoal"] == {"objective": "Finish"}


@pytest.mark.asyncio
async def test_runtime_rpc_service_losslessly_downgrades_plain_v2(monkeypatch):
    from app.services.device import runtime_rpc_service as module

    monkeypatch.setattr(
        module.runtime_route_resolver,
        "resolve",
        AsyncMock(return_value=_runtime_route()),
    )
    sio_call = AsyncMock(return_value={"accepted": True})
    monkeypatch.setattr(module, "get_sio", lambda: _socketio_with_call(sio_call))

    await module.RuntimeRpcService().call(
        user_id=7,
        device_id="device-1",
        method="runtime.tasks.create",
        payload={
            "schemaVersion": 2,
            "runtime": "codex",
            "message": "Implement",
        },
    )

    emitted = sio_call.await_args.args[1]["payload"]
    assert "schemaVersion" not in emitted


@pytest.mark.asyncio
async def test_runtime_rpc_service_preserves_v1_device_project_binding(monkeypatch):
    from app.services.device import runtime_rpc_service as module

    monkeypatch.setattr(
        module.runtime_route_resolver,
        "resolve",
        AsyncMock(return_value=_runtime_route()),
    )
    sio_call = AsyncMock(return_value={"accepted": True})
    monkeypatch.setattr(module, "get_sio", lambda: _socketio_with_call(sio_call))

    await module.RuntimeRpcService().call(
        user_id=7,
        device_id="device-1",
        method="runtime.tasks.create",
        payload={
            "schemaVersion": 2,
            "runtime": "codex",
            "message": "Implement",
            "runtimeProjectKey": "local:wegent",
        },
    )

    emitted = sio_call.await_args.args[1]["payload"]
    assert "schemaVersion" not in emitted
    assert emitted["runtimeProjectKey"] == "local:wegent"


@pytest.mark.asyncio
async def test_runtime_rpc_service_rejects_lossy_v2_downgrade(monkeypatch):
    from app.services.device import runtime_rpc_service as module

    monkeypatch.setattr(
        module.runtime_route_resolver,
        "resolve",
        AsyncMock(return_value=_runtime_route()),
    )
    sio_call = AsyncMock(return_value={"accepted": True})
    monkeypatch.setattr(module, "get_sio", lambda: _socketio_with_call(sio_call))

    with pytest.raises(module.RuntimeRpcError) as exc_info:
        await module.RuntimeRpcService().call(
            user_id=7,
            device_id="device-1",
            method="runtime.tasks.create",
            payload={
                "schemaVersion": 2,
                "runtime": "codex",
                "message": "Implement",
                "initialSupervisor": {"mode": "auto"},
            },
        )

    assert exc_info.value.code == "unsupported_runtime_task_create_features"
    assert exc_info.value.retryable is False
    assert exc_info.value.details["features"] == ["supervisor"]
    sio_call.assert_not_awaited()


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
async def test_runtime_rpc_service_projects_app_device_id_back_to_logical_id(
    monkeypatch,
):
    from app.services.device import runtime_rpc_service as module

    monkeypatch.setattr(
        module.runtime_route_resolver,
        "resolve",
        AsyncMock(return_value=_runtime_route(app_device_id="electron-device-1")),
    )
    sio = _socketio_with_call(
        AsyncMock(
            return_value={
                "accepted": True,
                "deviceId": "electron-device-1",
                "localTaskId": "runtime-task-1",
            }
        )
    )
    monkeypatch.setattr(module, "get_sio", lambda: sio)

    result = await module.RuntimeRpcService().call(
        user_id=7,
        device_id="device-1",
        method="runtime.tasks.create",
        payload={"message": "pwd"},
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
