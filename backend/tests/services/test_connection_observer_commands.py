"""Protocol coverage for typed observation commands on owned remote Runtimes."""

import json
from types import SimpleNamespace
from unittest.mock import ANY, AsyncMock
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.endpoints import devices
from app.schemas.device import DeviceType
from app.services.device import command_service
from app.services.device.runtime_rpc_service import RuntimeRpcError, runtime_rpc_service


@pytest.fixture
def dispatch(monkeypatch):
    rpc = AsyncMock(return_value={"observation": {"id": "source"}})
    shell = AsyncMock()
    monkeypatch.setattr(runtime_rpc_service, "call", rpc)
    monkeypatch.setattr(
        command_service.local_device_command_service, "execute_command", shell
    )
    monkeypatch.setattr(
        command_service.device_service,
        "get_device_by_device_id",
        lambda db, user_id, device_id: SimpleNamespace(
            json={"spec": {"deviceType": DeviceType.REMOTE.value}}
        ),
    )
    return rpc, shell


async def execute(key, args):
    return await command_service.execute_configured_device_command(
        db=object(),
        user_id=7,
        device_id="owned-device",
        command_key=key,
        args=args,
        command_config={key: {"command": "must-not-run"}},
        allow_app_device=False,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["start", "renew", "refresh", "stop"])
async def test_observer_commands_use_fixed_runtime_methods(dispatch, operation):
    rpc, shell = dispatch
    payload = {"consumerKey": "window-resource", "generation": "activation"}
    result = await execute(f"connection_observer_{operation}", [json.dumps(payload)])
    rpc.assert_awaited_once_with(
        user_id=7,
        device_id="owned-device",
        method=f"runtime.connections.observers.{operation}",
        payload=payload,
        timeout_seconds=60,
    )
    assert result == {
        "success": True,
        "exit_code": 0,
        "stdout": {"observation": {"id": "source"}},
        "stderr": "",
        "duration": ANY,
    }
    assert result["duration"] >= 0
    shell.assert_not_awaited()


@pytest.mark.asyncio
async def test_subscription_refresh_uses_the_same_owned_runtime_transport(dispatch):
    rpc, shell = dispatch
    await execute("connection_observation_refresh", ["task", "subscription"])
    assert rpc.call_args.kwargs["method"] == "runtime.connections.observations.refresh"
    assert rpc.call_args.kwargs["payload"] == {
        "taskId": "task",
        "subscriptionKey": "subscription",
    }
    shell.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("args", [[], ["[]"], ["null"], ["{"], ["{}", "{}"]])
async def test_invalid_observer_payload_is_rejected_before_dispatch(dispatch, args):
    with pytest.raises(command_service.DeviceCommandError):
        await execute("connection_observer_start", args)
    dispatch[0].assert_not_awaited()
    dispatch[1].assert_not_awaited()


@pytest.mark.asyncio
async def test_owner_and_runtime_policy_failures_never_fall_back_to_shell(
    dispatch, monkeypatch
):
    rpc, shell = dispatch
    monkeypatch.setattr(
        command_service.device_service, "get_device_by_device_id", lambda *args: None
    )
    with pytest.raises(command_service.DeviceCommandNotFoundError):
        await execute("connection_observer_start", ["{}"])
    rpc.assert_not_awaited()
    monkeypatch.setattr(
        command_service.device_service,
        "get_device_by_device_id",
        lambda *args: SimpleNamespace(json={"spec": {"deviceType": "remote"}}),
    )
    rpc.side_effect = RuntimeRpcError("Access disabled", code="remote_control_disabled")
    with pytest.raises(
        command_service.DeviceCommandError, match="remote_control_disabled"
    ):
        await execute("connection_observer_start", ["{}"])
    shell.assert_not_awaited()


@pytest.mark.asyncio
async def test_observation_commands_preserve_the_app_remote_control_boundary(
    dispatch, monkeypatch
):
    monkeypatch.setattr(
        command_service.device_service,
        "get_device_by_device_id",
        lambda *args: SimpleNamespace(json={"spec": {"deviceType": "app"}}),
    )
    with pytest.raises(command_service.DeviceCommandError, match="Remote control"):
        await execute("connection_observer_start", ["{}"])
    dispatch[0].assert_not_awaited()
    dispatch[1].assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("device_type", [DeviceType.REMOTE, DeviceType.CLOUD])
async def test_commands_reach_the_owned_runtime_socket_without_model_configuration(
    monkeypatch, device_type
):
    from app.services.device import runtime_rpc_service as module
    from app.services.device.runtime_route import RuntimeRoute

    monkeypatch.setattr(
        command_service.device_service,
        "get_device_by_device_id",
        lambda *args: SimpleNamespace(json={"spec": {"deviceType": device_type.value}}),
    )
    resolve = AsyncMock(
        return_value=RuntimeRoute(
            logical_device_id="owned-device",
            runtime_device_id="actual-runtime",
            runtime_instance_id="installation",
            device_type=device_type,
            socket_id="owned-socket",
            online_info={"socket_id": "owned-socket"},
        )
    )
    monkeypatch.setattr(module.runtime_route_resolver, "resolve", resolve)
    socket_call = AsyncMock(return_value={"observer": {"id": "observer"}})
    monkeypatch.setattr(module, "get_sio", lambda: SimpleNamespace(call=socket_call))
    shell = AsyncMock()
    monkeypatch.setattr(
        command_service.local_device_command_service, "execute_command", shell
    )
    monkeypatch.setattr(
        module,
        "_load_remote_runtime_proxy_url",
        lambda *args: pytest.fail(
            "Observation commands must not load model configuration"
        ),
    )
    payload = {"consumerKey": "window", "generation": "activation"}
    result = await execute("connection_observer_start", [json.dumps(payload)])
    resolve.assert_awaited_once_with(user_id=7, submitted_device_id="owned-device")
    request_id = socket_call.await_args.args[1]["request_id"]
    assert UUID(request_id).hex == request_id
    socket_call.assert_awaited_once_with(
        "runtime:rpc",
        {
            "method": "runtime.connections.observers.start",
            "payload": payload,
            "request_id": request_id,
        },
        to="owned-socket",
        namespace="/local-executor",
        timeout=65,
    )
    assert result["stdout"] == {"observer": {"id": "observer"}}
    shell.assert_not_awaited()


def test_subscription_cancellation_returns_valid_http_receipt(dispatch):
    rpc, shell = dispatch
    receipt = {
        "subscription": {"subscription_key": "subscription", "status": "cancelled"}
    }
    rpc.return_value = receipt
    app = FastAPI()
    app.include_router(devices.router, prefix="/api/devices")
    app.dependency_overrides[devices.get_db] = object
    app.dependency_overrides[devices.security.get_current_user] = (
        lambda: SimpleNamespace(id=7)
    )

    with TestClient(app) as client:
        response = client.post(
            "/api/devices/owned-device/commands",
            json={
                "command_key": "connection_subscription_cancel",
                "args": ["task", "subscription"],
            },
        )

    assert response.status_code == 200
    result = response.json()
    assert result["success"] is True
    assert result["stdout"] == receipt
    assert result["duration"] >= 0
    rpc.assert_awaited_once_with(
        user_id=7,
        device_id="owned-device",
        method="runtime.connections.subscriptions.cancel",
        payload={"taskId": "task", "subscriptionKey": "subscription"},
        timeout_seconds=60,
    )
    shell.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "args", [[], ["task"], ["", "watch"], ["task", ""], ["a", "b", "c"]]
)
async def test_cancellation_rejects_incomplete_identity(dispatch, args):
    with pytest.raises(command_service.DeviceCommandError):
        await execute("connection_subscription_cancel", args)
    dispatch[0].assert_not_awaited()
    dispatch[1].assert_not_awaited()
