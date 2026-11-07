"""Personal continuation retains native scope and uses collaboration permissions."""

import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import HTTPException

from app.models.delivery import CloudProject, LoopItem
from app.models.resource_member import ResourceMember
from app.models.user import User
from app.schemas.runtime_work import (
    RuntimeSendRequest,
    RuntimeTaskAddress,
    RuntimeTaskMaterializeRequest,
    RuntimeTranscriptResponse,
)
from app.services import runtime_work_service as service
from tests.utils.collaboration import authorize_project


@pytest.mark.asyncio
@pytest.mark.parametrize("authorized_im", [True, False])
async def test_app_continuation_keeps_existing_im_authorization(
    test_db, test_user, monkeypatch, authorized_im
):
    from app.schemas.device import DeviceType
    from app.services.device import runtime_rpc_service as rpc_module
    from app.services.device.runtime_route import RuntimeRoute

    monkeypatch.setattr(service, "_ensure_owned_device", lambda *args: None)
    monkeypatch.setattr(service, "_touch_workspace_mapping", lambda *args: None)
    route = RuntimeRoute(
        logical_device_id="app-device",
        runtime_device_id="app-runtime",
        runtime_instance_id="app-instance",
        device_type=DeviceType.APP,
        socket_id="app-socket",
        online_info={"socket_id": "app-socket"},
    )
    monkeypatch.setattr(
        rpc_module.runtime_route_resolver, "resolve", AsyncMock(return_value=route)
    )

    async def device_call(event, body, **kwargs):
        assert event == "runtime:rpc"
        if body["method"] == "runtime.tasks.transcript":
            assert body["payload"]["conversationContextOnly"] is True
            assert body["payload"]["identityOnly"] is True
            return {
                "taskId": "original-task",
                "workspacePath": "/original/workspace",
                "runtime": "codex",
                "turns": [],
            }
        assert body["method"] == "runtime.tasks.send"
        assert body["payload"]["workspacePath"] == "/original/workspace"
        return {"accepted": True, "taskId": "original-task"}

    socket_call = AsyncMock(side_effect=device_call)
    monkeypatch.setattr(
        rpc_module,
        "get_sio",
        lambda: SimpleNamespace(
            call=socket_call,
            manager=SimpleNamespace(is_connected=Mock(return_value=True)),
        ),
    )
    if authorized_im:
        result = await service.send_runtime_message(
            db=test_db,
            user_id=test_user.id,
            request=request(),
            allow_app_device_task_messaging=True,
        )
        assert result.accepted
        assert [call.args[1]["method"] for call in socket_call.await_args_list] == [
            "runtime.tasks.transcript",
            "runtime.tasks.send",
        ]
    else:
        with pytest.raises(HTTPException) as error:
            await service.send_runtime_message(
                db=test_db, user_id=test_user.id, request=request()
            )
        assert error.value.status_code == 502
        assert "Remote control" in str(error.value.detail)
        socket_call.assert_not_awaited()


@pytest.fixture
def scope(test_db, test_user):
    project = CloudProject(
        public_id=str(uuid.uuid4()),
        project_key="CONTINUE",
        name="Continuation",
        created_by_user_id=test_user.id,
        metadata_json={},
    )
    authorize_project(test_db, project)
    member = User(
        user_name="continuation-member", password_hash="unused", is_active=True
    )
    test_db.add(member)
    test_db.flush()
    grant = ResourceMember.create(
        resource_type="CloudProject",
        resource_id=int(project.id),
        entity_id=str(member.id),
        role="Developer",
        status="approved",
    )
    issue = LoopItem(
        cloud_project_id=project.id,
        title="Continue original work",
        created_by_user_id=test_user.id,
        metadata_json={"security_level": "open"},
    )
    test_db.add_all([grant, issue])
    test_db.commit()
    origin = {
        "type": "board_task",
        "cloudProjectId": str(project.id),
        "loopItemId": str(issue.id),
        "dispatch_role": "executor",
    }
    return member, grant, issue, origin


@pytest.fixture
def transport(monkeypatch):
    monkeypatch.setattr(service, "_ensure_owned_device", lambda *args: None)
    monkeypatch.setattr(service, "_touch_workspace_mapping", lambda *args: None)
    rpc = AsyncMock(return_value={"accepted": True, "taskId": "original-task"})
    monkeypatch.setattr(service.runtime_rpc_service, "call", rpc)
    return rpc


def request():
    return RuntimeSendRequest(
        address=RuntimeTaskAddress(
            deviceId="original-device",
            taskId="original-task",
            workspacePath="/forged/workspace",
            runtimeHandle={"origin": None, "cloudProjectId": "forged-project"},
        ),
        message="Continue assigned work",
        clientUserMessageId="stable-message",
    )


def history(monkeypatch, origin, *, runtime="codex", task="original-task"):
    read = AsyncMock(
        return_value=RuntimeTranscriptResponse(
            taskId=task,
            workspacePath="/original/workspace",
            runtime=runtime,
            turns=[],
            origin=origin,
        )
    )
    monkeypatch.setattr(service, "get_runtime_transcript", read)
    return read


@pytest.mark.asyncio
@pytest.mark.parametrize("runtime", ["codex", "claude_code"])
@pytest.mark.parametrize("role", ["Developer", "Viewer"])
async def test_continuation_reads_native_identity_through_context_projection(
    test_db, scope, transport, runtime, role
):
    user, grant, _, origin = scope
    grant.role = role
    test_db.commit()

    async def dispatch(**kwargs):
        payload = kwargs["payload"]
        if kwargs["method"] == "runtime.tasks.transcript":
            assert payload["identityOnly"] is True
            # The navigation index is Codex-specific and has no Claude workspace.
            navigation_only = payload.get("navigationOnly", False)
            return {
                "taskId": "original-task",
                "workspacePath": "" if navigation_only else "/original/workspace",
                "runtime": "codex" if navigation_only else runtime,
                "origin": origin,
                "turns": [],
            }
        assert kwargs["method"] == "runtime.tasks.send"
        assert payload["workspacePath"] == "/original/workspace"
        assert payload["runtimeHandle"]["runtime"] == runtime
        assert payload["executionRequest"]["origin"] == origin
        return {"accepted": True, "taskId": "original-task"}

    transport.side_effect = dispatch
    if role == "Developer":
        result = await service.send_runtime_message(
            db=test_db, user_id=user.id, request=request()
        )
        assert result.accepted
        assert transport.await_count == 2
    else:
        with pytest.raises(HTTPException) as error:
            await service.send_runtime_message(
                db=test_db, user_id=user.id, request=request()
            )
        assert error.value.status_code == 403
        assert transport.await_count == 1
    read = transport.await_args_list[0].kwargs
    assert read["method"] == "runtime.tasks.transcript"
    assert read["payload"]["limit"] == 1
    assert read["payload"]["conversationContextOnly"] is True
    assert not read["payload"].get("navigationOnly")
    assert "forged" not in str(read["payload"])


@pytest.mark.asyncio
@pytest.mark.parametrize("runtime", ["codex", "claude_code"])
async def test_personal_send_preserves_authorized_native_identity(
    test_db, scope, transport, monkeypatch, runtime
):
    user, _, _, origin = scope
    read = history(monkeypatch, origin, runtime=runtime)
    result = await service.send_runtime_message(
        db=test_db, user_id=user.id, request=request()
    )
    assert result.accepted
    read.assert_awaited_once()
    assert read.await_args.kwargs["address"].device_id == "original-device"
    assert read.await_args.kwargs["address"].local_task_id == "original-task"
    assert read.await_args.kwargs["identity_only"] is True
    transport.assert_awaited_once()
    call = transport.await_args.kwargs
    assert call["device_id"] == "original-device"
    assert call["method"] == "runtime.tasks.send"
    payload = call["payload"]
    assert payload["taskId"] == "original-task"
    assert payload["workspacePath"] == "/original/workspace"
    assert payload["clientUserMessageId"] == "stable-message"
    assert payload["runtimeHandle"]["runtime"] == runtime
    execution = payload["executionRequest"]
    assert execution["origin"] == origin
    assert execution["cloud_project_id"] == origin["cloudProjectId"]
    assert execution["new_session"] is False
    assert "forged" not in str(payload)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "denial", ["viewer", "revoked", "hidden_issue", "read_denied", "wrong_task"]
)
async def test_continuation_denials_never_dispatch(
    test_db, scope, transport, monkeypatch, denial
):
    user, grant, issue, origin = scope
    read = history(
        monkeypatch,
        origin,
        task="wrong-task" if denial == "wrong_task" else "original-task",
    )
    if denial == "viewer":
        grant.role = "Viewer"
    elif denial == "revoked":
        grant.status = "rejected"
    elif denial == "hidden_issue":
        issue.metadata_json = {"security_level": "related"}
    elif denial == "read_denied":
        read.side_effect = HTTPException(403, "Transcript denied")
    test_db.commit()
    with pytest.raises(HTTPException) as error:
        await service.send_runtime_message(
            db=test_db, user_id=user.id, request=request()
        )
    assert (
        error.value.status_code
        == {
            "viewer": 403,
            "revoked": 404,
            "hidden_issue": 404,
            "read_denied": 403,
            "wrong_task": 502,
        }[denial]
    )
    transport.assert_not_awaited()


@pytest.mark.parametrize("denial", [None, "viewer", "revoked", "hidden_issue"])
@pytest.mark.parametrize("new_session", [True, False])
def test_frontend_materialization_and_http_send_share_permission_check(
    test_db, scope, monkeypatch, denial, new_session
):
    user, grant, issue, origin = scope
    if denial == "viewer":
        grant.role = "Viewer"
    elif denial == "revoked":
        grant.status = "rejected"
    elif denial == "hidden_issue":
        issue.metadata_json = {"security_level": "related"}
    test_db.commit()
    monkeypatch.setattr(service, "_ensure_owned_device", Mock())
    intent = RuntimeTaskMaterializeRequest(
        deviceId="original-device",
        workspacePath="/original/workspace",
        taskId="original-task",
        newSession=new_session,
        runtime="codex",
        message="Continue",
        origin=origin,
        cloudProjectId=origin["cloudProjectId"],
    )
    # Exercise the public materialization service, including its transport boundary.
    if denial is None:
        compiled = service.materialize_runtime_task_create(
            db=test_db, user_id=user.id, request=intent
        )
        assert compiled.payload["executionRequest"]["origin"] == origin
        assert compiled.payload["executionRequest"]["new_session"] is new_session
    else:
        with pytest.raises(HTTPException) as error:
            service.materialize_runtime_task_create(
                db=test_db, user_id=user.id, request=intent
            )
        assert error.value.status_code == (403 if denial == "viewer" else 404)


@pytest.mark.parametrize("new_session", [True, False])
def test_project_only_materialization_denies_viewer_execution(
    test_db, scope, monkeypatch, new_session
):
    user, grant, _, origin = scope
    grant.role = "Viewer"
    test_db.commit()
    monkeypatch.setattr(service, "_ensure_owned_device", Mock())
    compiler = Mock()
    monkeypatch.setattr(
        service, "_build_direct_wework_runtime_execution_request", compiler
    )
    with pytest.raises(HTTPException) as error:
        service.materialize_runtime_task_create(
            db=test_db,
            user_id=user.id,
            request=RuntimeTaskMaterializeRequest(
                deviceId="original-device",
                workspacePath="/original/workspace",
                taskId="new-project-task",
                runtime="codex",
                message="Denied project execution",
                newSession=new_session,
                origin={
                    "type": "project_task",
                    "cloudProjectId": origin["cloudProjectId"],
                },
                cloudProjectId=origin["cloudProjectId"],
            ),
        )
    assert error.value.status_code == 403
    compiler.assert_not_called()
