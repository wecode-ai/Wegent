"""Personal continuation retains native scope and uses collaboration permissions."""

import uuid
from unittest.mock import AsyncMock

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


@pytest.mark.parametrize("allowed", [True, False])
def test_frontend_materialization_and_http_send_share_permission_check(
    test_db, scope, monkeypatch, allowed
):
    user, grant, _, origin = scope
    if not allowed:
        grant.role = "Viewer"
        test_db.commit()
    from app.services.runtime_work_service import RuntimeTaskTarget

    target = RuntimeTaskTarget(
        "original-device", "/original/workspace", None, "local_path"
    )
    intent = RuntimeTaskMaterializeRequest(
        deviceId="original-device",
        taskId="original-task",
        newSession=False,
        runtime="codex",
        message="Continue",
        origin=origin,
        cloudProjectId=origin["cloudProjectId"],
    )
    # Both entry points reach this real compiler before any transport send.
    if allowed:
        execution = service._build_runtime_execution_request(
            db=test_db, user_id=user.id, request=intent, target=target
        )
        assert execution.origin == origin
    else:
        with pytest.raises(HTTPException) as error:
            service._build_runtime_execution_request(
                db=test_db, user_id=user.id, request=intent, target=target
            )
        assert error.value.status_code == 403
