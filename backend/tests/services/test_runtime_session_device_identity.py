"""Normal project session flows retain one user-owned device identity."""

from contextlib import contextmanager
from datetime import datetime
from types import MethodType

import pytest
from fastapi import HTTPException

from app.models.delivery import LoopItemTaskBinding, loop_datetime_is_unset
from app.models.kind import Kind
from app.models.loop_item_execution import LoopItemExecution
from app.models.resource_member import ResourceMember
from app.schemas.delivery import LoopItemTaskBind
from app.schemas.project_chat import LoopItemExecutionAssignmentStatus
from app.schemas.runtime_work import RuntimeTranscriptRequest
from app.services.collaboration_member_activity import (
    project_collaboration_member_activity,
)
from app.services.device.identity import record_route_id
from app.services.loop_item_executions import device_pull
from app.services.loop_item_executions.service import loop_item_execution_service
from app.services.loop_items.service import loop_item_service
from app.services.project_chat.comment_execution import _execution, execute_comment
from app.services.project_chat.session_access import resolve_project_transcript
from tests.services.test_project_comment_execution import comment, scenario
from tests.services.test_project_group_comment_execution import (
    group_scenario,
    member_scenario,
)


def app_device(s):
    device = s.db.query(Kind).filter_by(kind="Device", name="admin-cloud").one()
    device.json = {
        "spec": {
            "deviceType": "app",
            "deviceId": "native-device",
            "appDeviceId": "electron-app",
        }
    }
    s.db.commit()
    return device


def transcript_request(s, device_id):
    return RuntimeTranscriptRequest(
        deviceId=device_id,
        taskId=s.root.runtime_task_id,
        projectSession={"projectId": str(s.project.id), "issueId": s.issue.id},
    )


@pytest.mark.asyncio
async def test_member_report_reply_and_executor_pull_share_one_binding(
    member_scenario, monkeypatch
):
    s = member_scenario
    monkeypatch.setattr(
        loop_item_execution_service,
        "_runtime_profile_and_context",
        MethodType(
            type(loop_item_execution_service)._runtime_profile_and_context,
            loop_item_execution_service,
        ),
    )
    device = app_device(s)
    route = record_route_id(device)
    s.execution.runtime_device_id = route
    s.execution.execution_environment = "local"
    s.member_agent.metadata_json = {
        **s.member_agent.metadata_json,
        "execution_environment": "local",
    }
    s.db.commit()
    message, changed = project_collaboration_member_activity(
        s.db,
        project_id=s.project.id,
        values=LoopItemExecutionAssignmentStatus(
            loop_item_id=s.issue.id,
            dispatch_id="group-dispatch-1",
            round_id="round-1",
            assignment_id="assignment-1",
            runtime_device_id="electron-app",
            runtime_task_id=s.root.runtime_task_id,
            status="completed",
            result="CPU evidence collected",
        ),
    )
    assert changed
    s.root = message
    binding = s.db.query(LoopItemTaskBinding).one()
    binding_id = binding.id
    assert binding.device_id == "electron-app"
    replies = await execute_comment(
        s.db, user_id=s.member.id, request=comment(s, text="Inspect memory too")
    )
    queued = s.db.get(LoopItemExecution, replies[0].metadata["execution_id"])
    assert queued.runtime_task_id == message.runtime_task_id
    assert queued.assignment_pending
    assert queued.execution_device_id == ""
    assert loop_item_execution_service.prepare_queued_assignments(s.db) == 1
    assert not queued.assignment_pending
    assert queued.execution_device_id == route
    assert queued.runtime_device_id == "electron-app"
    assert queued.status == "queued"
    assert s.db.query(LoopItemTaskBinding).count() == 1

    @contextmanager
    def fixture_db_session():
        yield s.db

    monkeypatch.setattr(device_pull, "get_db_session", fixture_db_session)
    pulled = device_pull._claim_execution(
        execution_target_id="native-device",
        runtime_device_id=route,
        environment="local",
        runtime_instance_id="fixture-app-runtime",
        owner_user_id=s.owner.id,
    )
    assert pulled["success"]
    assert pulled["task"]["execution_id"] == queued.id
    assert queued.runtime_device_id == route
    assert (
        loop_item_execution_service.mark_start_requested(
            s.db, execution_ids=[queued.id]
        )
        == 1
    )
    bindings = loop_item_service.list_task_bindings(s.db, s.issue.id, s.owner.id)
    assert [row.id for row in bindings] == [binding_id]
    assert bindings[0].device_id == "electron-app"
    for alias in ["electron-app", route]:
        owner, address = resolve_project_transcript(
            s.db, s.member.id, transcript_request(s, alias)
        )
        assert owner == s.owner.id
        assert address.local_task_id == message.runtime_task_id


@pytest.fixture
def manual_session(scenario):
    s = scenario
    device = app_device(s)
    s.db.delete(s.execution)
    s.root.metadata_json = {}
    s.root.runtime_device_id = "electron-app"
    s.db.commit()
    s.device = device
    return s


def bind_manual(s, alias):
    return loop_item_service.bind_task(
        s.db,
        s.issue.id,
        LoopItemTaskBind(
            deviceId=alias,
            taskId=s.root.runtime_task_id,
            modelSelection={"modelName": "original-model", "modelType": "runtime"},
        ),
        s.owner.id,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("first_alias", ["electron-app", "record"])
async def test_manual_session_rebind_reply_read_and_unbind_use_either_alias(
    manual_session, first_alias
):
    s = manual_session
    route = record_route_id(s.device)
    first_alias = route if first_alias == "record" else first_alias
    other_alias = "electron-app" if first_alias == route else route
    first = bind_manual(s, first_alias)
    rebound = bind_manual(s, other_alias)
    s.root.runtime_device_id = other_alias
    s.db.commit()

    assert rebound.id == first.id
    assert rebound.device_id == first_alias
    request = comment(s)
    resolved = _execution(s.db, request, s.root)
    assert resolved.executor_owner_user_id == s.owner.id
    assert resolved.runtime_device_id == first_alias
    await execute_comment(s.db, user_id=s.member.id, request=request)
    assert s.compiler.call_args.kwargs["user_id"] == s.owner.id
    assert s.compiler.call_args.kwargs["request"].model_id == "original-model"
    assert s.rpc.call_args.kwargs["payload"]["taskId"] == s.root.runtime_task_id

    for alias in [first_alias, other_alias]:
        owner, address = resolve_project_transcript(
            s.db, s.owner.id, transcript_request(s, alias)
        )
        assert owner == s.owner.id
        assert address.local_task_id == s.root.runtime_task_id
    loop_item_service.unbind_task(
        s.db,
        s.issue.id,
        LoopItemTaskBind(deviceId=other_alias, taskId=s.root.runtime_task_id),
        s.owner.id,
    )
    # The response has no durable execution row; unlinking removes its authority.
    with pytest.raises(HTTPException):
        _execution(s.db, request, s.root)
    for alias in [first_alias, other_alias]:
        with pytest.raises(HTTPException) as denied:
            resolve_project_transcript(s.db, s.owner.id, transcript_request(s, alias))
        assert denied.value.status_code == 404


@pytest.mark.parametrize("reader", ["comment", "transcript"])
@pytest.mark.parametrize(
    "boundary",
    ["other_owner", "other_installation", "ambiguous_alias", "deleted", "unlinked"],
)
def test_session_aliases_do_not_cross_identity_or_inactive_bindings(
    manual_session, reader, boundary
):
    s = manual_session
    binding = bind_manual(s, record_route_id(s.device))
    requested = "electron-app"
    if boundary in {"other_owner", "other_installation", "ambiguous_alias"}:
        other = Kind(
            kind="Device",
            name=s.device.name,
            namespace="default",
            user_id=s.member.id if boundary == "other_owner" else s.owner.id,
            is_active=True,
            json={
                "spec": {
                    "deviceType": "app",
                    "deviceId": "native-device",
                    "appDeviceId": "other-electron",
                }
            },
        )
        s.db.add(other)
        s.db.flush()
        requested = (
            "native-device" if boundary == "ambiguous_alias" else record_route_id(other)
        )
    elif boundary == "deleted":
        binding.deleted_at = datetime(2026, 10, 16)
    else:
        binding.unlinked_at = datetime(2026, 10, 16)
    s.root.runtime_device_id = requested
    s.db.commit()

    with pytest.raises(HTTPException) as denied:
        if reader == "comment":
            _execution(s.db, comment(s), s.root)
        else:
            resolve_project_transcript(
                s.db, s.member.id, transcript_request(s, requested)
            )
    assert denied.value.status_code in {404, 409}
    s.rpc.assert_not_awaited()


@pytest.mark.parametrize("reader", ["comment", "transcript"])
def test_duplicate_alias_bindings_reject_conflicting_owners(manual_session, reader):
    s = manual_session
    bind_manual(s, "electron-app")
    s.db.add(
        LoopItemTaskBinding(
            cloud_project_id=s.project.id,
            loop_item_id=s.issue.id,
            task_user_id=s.member.id,
            device_id="electron-app",
            task_id=s.root.runtime_task_id,
        )
    )
    s.db.commit()
    with pytest.raises(HTTPException) as denied:
        if reader == "comment":
            _execution(s.db, comment(s), s.root)
        else:
            resolve_project_transcript(
                s.db, s.member.id, transcript_request(s, "electron-app")
            )
    assert denied.value.status_code == 409


@pytest.mark.asyncio
@pytest.mark.parametrize("revoked", ["project", "device"])
async def test_alias_reply_rechecks_project_and_device_revocation(
    manual_session, revoked
):
    s = manual_session
    bind_manual(s, record_route_id(s.device))
    request = comment(s)
    source = (
        s.grant
        if revoked == "project"
        else s.db.query(ResourceMember)
        .filter_by(
            resource_type="Device",
            entity_type="workspace",
            entity_id=str(s.project.workspace_id),
        )
        .one()
    )
    s.db.delete(source)
    s.db.commit()
    with pytest.raises(HTTPException) as denied:
        await execute_comment(s.db, user_id=s.member.id, request=request)
    assert denied.value.status_code == (404 if revoked == "project" else 403)
    s.rpc.assert_not_awaited()
    s.compiler.assert_not_called()


@pytest.mark.parametrize("use_execution_id", [False, True])
def test_recorded_execution_matches_a_device_alias(scenario, use_execution_id):
    s = scenario
    device = app_device(s)
    s.execution.runtime_device_id = "electron-app"
    s.root.runtime_device_id = record_route_id(device)
    s.root.metadata_json = {"execution_id": s.execution.id} if use_execution_id else {}
    s.db.commit()

    resolved = _execution(s.db, comment(s), s.root)
    owner, address = resolve_project_transcript(
        s.db, s.member.id, transcript_request(s, record_route_id(device))
    )

    assert resolved.id == s.execution.id
    assert resolved.executor_owner_user_id == owner == s.owner.id
    assert address.local_task_id == s.execution.runtime_task_id


def test_historical_duplicate_alias_bindings_resolve_the_newest_session(manual_session):
    s = manual_session
    first = bind_manual(s, "electron-app")
    first.linked_at = datetime(2026, 10, 15)
    newest = LoopItemTaskBinding(
        cloud_project_id=s.project.id,
        loop_item_id=s.issue.id,
        task_user_id=s.owner.id,
        device_id=record_route_id(s.device),
        task_id=s.root.runtime_task_id,
        linked_at=datetime(2026, 10, 16),
        metadata_json={"model_selection": {"modelName": "newest-model"}},
    )
    s.db.add(newest)
    s.root.runtime_device_id = "native-device"
    s.db.commit()

    resolved = _execution(s.db, comment(s), s.root)
    owner, _ = resolve_project_transcript(
        s.db, s.owner.id, transcript_request(s, "native-device")
    )

    assert resolved.runtime_device_id == newest.device_id
    assert resolved.runtime_request["modelId"] == "newest-model"
    assert resolved.executor_owner_user_id == owner == s.owner.id


@pytest.mark.asyncio
async def test_alias_transcript_rpc_uses_the_bound_owner_and_exact_task(manual_session):
    from app.services.runtime_work_service import get_runtime_transcript

    s = manual_session
    bind_manual(s, "electron-app")
    s.rpc.return_value = {
        "taskId": s.root.runtime_task_id,
        "workspacePath": "",
        "runtime": "codex",
        "messages": [],
        "turns": [],
        "running": False,
    }
    request = transcript_request(s, record_route_id(s.device))
    request.runtime_handle = {"threadId": "private-session"}
    request.workspace_path = "/private-workspace"

    await get_runtime_transcript(db=s.db, user_id=s.owner.id, address=request)

    s.rpc.assert_awaited_once_with(
        user_id=s.owner.id,
        device_id=record_route_id(s.device),
        method="runtime.tasks.transcript",
        payload={
            "deviceId": record_route_id(s.device),
            "taskId": s.root.runtime_task_id,
        },
        timeout_seconds=30,
        allow_app_device_task_reading=True,
    )


@pytest.mark.parametrize("search", [False, True])
def test_manual_binding_never_grants_another_member_transcript_access(
    manual_session, search
):
    from app.schemas.runtime_work import RuntimeTranscriptSearchRequest

    s = manual_session
    bind_manual(s, "electron-app")
    values = transcript_request(s, "electron-app").model_dump(by_alias=True)
    request = (
        RuntimeTranscriptSearchRequest(**values, query="private")
        if search
        else transcript_request(s, "electron-app")
    )
    with pytest.raises(HTTPException) as denied:
        resolve_project_transcript(s.db, s.member.id, request)
    assert denied.value.status_code == 404
    s.rpc.assert_not_awaited()
