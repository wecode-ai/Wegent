"""Personal task consent is per installation and never grants device administration."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.schemas.device import DeviceType, RuntimeFeatures
from app.services.device import runtime_rpc_service as rpc
from app.services.device.remote_control_policy import (
    APP_REMOTE_TASK_METHODS,
    app_remote_task_access_enabled,
)
from app.services.device.runtime_route import RuntimeRoute


def test_existing_create_intent_prepares_app_workspace_inside_the_executor(
    test_db, test_user
):
    from app.schemas.runtime_work import RuntimeTaskCreateRequest
    from app.services import runtime_work_service as work

    request = RuntimeTaskCreateRequest(
        schemaVersion=2,
        deviceId="app-record-11",
        taskId="standalone-task",
        runtime="codex",
        message="Create a standalone conversation",
        standaloneChatWorkspace=True,
    )
    target = work._resolve_runtime_task_target(test_db, test_user.id, request)
    execution = SimpleNamespace()
    work._apply_runtime_create_request(execution, request)

    assert target.device_id == "app-record-11"
    assert target.workspace_path == ""
    assert target.project is None
    assert execution.task_id == "standalone-task"
    assert execution.standalone_chat_workspace is True


@pytest.mark.parametrize(
    "access",
    [
        None,
        {},
        True,
        {"version": True, "enabled": True},
        {"version": 1, "enabled": "true"},
        {"version": 2, "enabled": True},
        {"version": 1, "enabled": False},
        {"version": 1, "enabled": True, "taskCreation": "true"},
    ],
)
def test_missing_or_malformed_consent_grants_nothing(access):
    features = RuntimeFeatures.model_validate(
        {"schemaVersion": 4, "remoteTaskAccess": access}
    )
    assert not app_remote_task_access_enabled(
        {"runtime_features": features.model_dump(by_alias=True)}
    )


@pytest.mark.parametrize("enabled", [False, True])
def test_device_schema_preserves_only_typed_local_consent(enabled):
    features = RuntimeFeatures.model_validate(
        {
            "schemaVersion": 4,
            "remoteTaskAccess": {"version": 1, "enabled": enabled},
        }
    )
    assert features.model_dump(by_alias=True)["remoteTaskAccess"] == {
        "version": 1,
        "enabled": enabled,
        "taskCreation": False,
    }


def test_device_schema_preserves_task_creation_capability():
    access = {"version": 1, "enabled": True, "taskCreation": True}
    features = RuntimeFeatures.model_validate(
        {"schemaVersion": 4, "remoteTaskAccess": access}
    )
    assert features.model_dump(by_alias=True)["remoteTaskAccess"] == access


@pytest.mark.asyncio
@pytest.mark.parametrize("method", sorted(APP_REMOTE_TASK_METHODS))
async def test_consent_is_checked_on_each_target_and_request(monkeypatch, method):
    enabled = {"app-record-11": True, "app-record-22": False}

    async def resolve(*, user_id, submitted_device_id):
        assert user_id == 7
        return RuntimeRoute(
            logical_device_id=submitted_device_id,
            runtime_device_id=submitted_device_id,
            runtime_instance_id=f"installation-{submitted_device_id}",
            device_type=DeviceType.APP,
            socket_id=f"socket-{submitted_device_id}",
            online_info={
                "runtime_features": {
                    "schemaVersion": 4,
                    "remoteTaskAccess": {
                        "version": 1,
                        "enabled": enabled[submitted_device_id],
                    },
                }
            },
        )

    call = AsyncMock(return_value={"success": True})
    monkeypatch.setattr(rpc.runtime_route_resolver, "resolve", resolve)
    monkeypatch.setattr(rpc, "get_sio", lambda: type("Sio", (), {"call": call})())
    service = rpc.RuntimeRpcService()
    await service.call(user_id=7, device_id="app-record-11", method=method, payload={})
    assert call.await_args.kwargs["to"] == "socket-app-record-11"
    assert "appTaskAccessScope" not in call.await_args.args[1]
    for target in ["app-record-22", "app-record-11"]:
        enabled[target] = False
        with pytest.raises(rpc.RuntimeRpcError) as error:
            await service.call(
                user_id=7,
                device_id=target,
                method=method,
                payload={
                    "remoteTaskAccess": {"enabled": True},
                    "appTaskAccessScope": "project-session",
                },
            )
        assert error.value.code == "remote_control_disabled"
    assert call.await_count == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "method",
    [
        "executor.remote_task_access.update",
        "executor.backend.configure",
        "runtime.settings.update",
        "runtime.codex.app_server.request",
        "runtime.workspaces.open",
        "device.execute_command",
    ],
)
async def test_enabled_task_access_never_grants_configuration_or_other_operations(
    monkeypatch, method
):
    route = RuntimeRoute(
        logical_device_id="app-record-11",
        runtime_device_id="app-record-11",
        runtime_instance_id="installation-a",
        device_type=DeviceType.APP,
        socket_id="socket-a",
        online_info={
            "runtime_features": {
                "schemaVersion": 4,
                "remoteTaskAccess": {"version": 1, "enabled": True},
            }
        },
    )
    monkeypatch.setattr(
        rpc.runtime_route_resolver, "resolve", AsyncMock(return_value=route)
    )
    call = AsyncMock()
    monkeypatch.setattr(rpc, "get_sio", lambda: type("Sio", (), {"call": call})())
    with pytest.raises(rpc.RuntimeRpcError) as error:
        await rpc.RuntimeRpcService().call(
            user_id=7,
            device_id="app-record-11",
            method=method,
            payload={"enabled": True},
        )
    assert error.value.code == "remote_control_disabled"
    call.assert_not_awaited()


@pytest.mark.asyncio
async def test_task_list_uses_unique_app_route_and_removes_revoked_installation(
    test_db, test_user, monkeypatch
):
    from app.services import runtime_work_service as work

    devices = [
        {
            "device_id": "shared-name",
            "execution_target_id": f"app-record-{id}",
            "device_type": "app",
            "name": "Computer",
            "status": "online",
            "runtime_features": {"remoteTaskAccess": {"version": 1, "enabled": True}},
        }
        for id in [11, 22]
    ]
    monkeypatch.setattr(
        work.device_service, "get_all_devices", AsyncMock(return_value=devices)
    )
    calls = AsyncMock(
        return_value={
            "success": True,
            "workspaces": [
                {
                    "workspacePath": "/repo",
                    "tasks": [
                        {
                            "taskId": "local-task",
                            "runtime": "codex",
                            "title": "Existing task",
                        }
                    ],
                }
            ],
        }
    )
    monkeypatch.setattr(work.runtime_rpc_service, "call", calls)
    for target in ["app-record-11", "app-record-22"]:
        response = await work.list_runtime_work(
            db=test_db, user_id=test_user.id, device_id=target
        )
        assert response.total_tasks == 1
        assert calls.await_args.kwargs["device_id"] == target
        projected = response.model_dump(by_alias=True)
        assert target in str(projected)
        assert "shared-name" not in str(projected)
    devices[0]["runtime_features"]["remoteTaskAccess"]["enabled"] = False
    calls.reset_mock()
    response = await work.list_runtime_work(
        db=test_db, user_id=test_user.id, device_id="app-record-11"
    )
    assert response.total_tasks == 0
    calls.assert_not_awaited()
