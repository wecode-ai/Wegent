"""Project membership authorizes collaboration, not access to owner devices."""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

from app.models.delivery import CloudProject, LoopItem, ProjectChatAgent
from app.models.kind import Kind
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.schemas.base_role import BaseRole
from app.schemas.project_chat import ProjectChatCommentExecution, ProjectChatSend
from app.services.project_chat.comment_execution import execute_comment
from app.services.project_chat.service import project_chat_service
from tests.utils.collaboration import (
    authorize_project,
    authorize_project_agent,
    authorize_resource,
)


@pytest.fixture
def scenario(test_db, test_user, test_admin_user, monkeypatch):
    owner, member = test_admin_user, test_user
    project = CloudProject(
        public_id="comment-project",
        project_key="COMMENT",
        name="Comments",
        created_by_user_id=owner.id,
        metadata_json={},
    )
    authorize_project(test_db, project)
    test_db.add(project)
    test_db.flush()
    grant = ResourceMember(
        resource_type=ResourceType.CLOUD_PROJECT.value,
        resource_id=project.id,
        entity_type="user",
        entity_id=str(member.id),
        role=BaseRole.Developer.value,
        status=MemberStatus.APPROVED.value,
    )
    agent = ProjectChatAgent(
        id="admin-agent",
        cloud_project_id=str(project.id),
        name="Codex",
        title="Codex",
        created_by_user_id=owner.id,
        status="active",
        metadata_json={"runtime": "codex", "visibility": "creator_admin"},
    )
    authorize_project_agent(test_db, agent)
    issue = LoopItem(
        id="member-issue",
        cloud_project_id=str(project.id),
        title="Member issue",
        created_by_user_id=member.id,
        assignee_agent_id=agent.id,
        status="in_review",
        metadata_json={},
    )
    device = Kind(
        kind="Device",
        name="admin-cloud",
        namespace="default",
        user_id=owner.id,
        is_active=True,
        json={"spec": {"deviceType": "cloud"}},
    )
    test_db.add(device)
    test_db.flush()
    authorize_resource(test_db, project, device)
    test_db.add_all([grant, agent, issue])
    test_db.flush()
    execution = LoopItemExecution(
        loop_item_id=issue.id,
        cloud_project_id=str(project.id),
        agent_id=agent.id,
        executor_owner_user_id=owner.id,
        assigner_user_id=owner.id,
        status="completed",
        execution_device_id="admin-cloud",
        runtime_device_id="admin-cloud",
        runtime_task_id="original-session",
        execution_environment="cloud",
        execution_payload=json.dumps(
            {
                "schema_version": 2,
                "runtime_request": {
                    "schemaVersion": 2,
                    "runtime": "codex",
                    "deviceId": "admin-cloud",
                    "taskId": "original-session",
                    "message": "Original work",
                    "modelId": "admin-model",
                    "modelType": "runtime",
                },
            }
        ),
    )
    test_db.add(execution)
    test_db.flush()
    root = ProjectChatMessage(
        message_id="ai-result",
        client_message_id="ai-result",
        project_id=str(project.id),
        task_id=issue.id,
        sender_type="agent",
        sender_id=agent.id,
        sender_name=agent.name,
        agent_id=agent.id,
        content="Done",
        message_type="text",
        status="completed",
        runtime_device_id="admin-cloud",
        runtime_task_id="original-session",
        metadata_json={"execution_id": execution.id, "executor_type": "project_robot"},
    )
    test_db.add(root)
    test_db.commit()
    compiler = MagicMock(
        return_value=SimpleNamespace(
            payload={
                "executionRequest": {"user": {"id": owner.id}, "model_config": {}}
            },
            target=SimpleNamespace(device_id="admin-cloud"),
        )
    )
    rpc = AsyncMock(return_value={"accepted": True})
    monkeypatch.setattr(
        "app.services.runtime_work_service.compile_runtime_task_create", compiler
    )
    monkeypatch.setattr(
        "app.services.device.runtime_rpc_service.runtime_rpc_service.call", rpc
    )
    monkeypatch.setattr(
        "app.services.project_chat.comment_execution.push_project_chat_message",
        MagicMock(),
    )
    monkeypatch.setattr(
        "app.services.project_chat.service.notify_project_chat_mentions", MagicMock()
    )
    return SimpleNamespace(
        db=test_db,
        member=member,
        owner=owner,
        project=project,
        grant=grant,
        issue=issue,
        agent=agent,
        execution=execution,
        root=root,
        compiler=compiler,
        rpc=rpc,
    )


def comment(s, text="完成了？", reply=True, mentions=None):
    result = project_chat_service.send(
        s.db,
        user_id=s.member.id,
        user_name=s.member.user_name,
        request=ProjectChatSend(
            project_id=str(s.project.id),
            task_id=s.issue.id,
            client_message_id=f"comment-{s.db.query(ProjectChatMessage).count()}",
            content=text,
            reply_to_message_id=s.root.message_id if reply else None,
            mentions=mentions or [],
        ),
    )
    return ProjectChatCommentExecution(
        project_id=str(s.project.id),
        task_id=s.issue.id,
        trigger_message_id=result.message.message_id,
    )


@pytest.mark.asyncio
async def test_member_reply_uses_original_owner_and_session_once(scenario):
    s = scenario
    assert (
        project_chat_service.list_agents(
            s.db, user_id=s.member.id, project_id=str(s.project.id)
        )
        != []
    )
    request = comment(s)
    first = await execute_comment(s.db, user_id=s.member.id, request=request)
    second = await execute_comment(s.db, user_id=s.member.id, request=request)
    assert first[0].message_id == second[0].message_id
    assert first[0].root_message_id == s.root.message_id
    assert s.compiler.call_args.kwargs["user_id"] == s.owner.id
    assert s.compiler.call_args.kwargs["request"].message == "完成了？"
    assert s.compiler.call_args.kwargs["request"].model_id == "admin-model"
    s.rpc.assert_awaited_once()
    assert s.rpc.call_args.kwargs["user_id"] == s.owner.id
    assert s.rpc.call_args.kwargs["payload"]["taskId"] == "original-session"


@pytest.mark.asyncio
async def test_old_thread_survives_reassignment(scenario):
    s = scenario
    s.issue.assignee_agent_id = "different-agent"
    s.db.commit()
    await execute_comment(s.db, user_id=s.member.id, request=comment(s))
    assert s.rpc.call_args.kwargs["payload"]["taskId"] == "original-session"


@pytest.mark.asyncio
@pytest.mark.parametrize("offset", [None, 360 * 1024])
async def test_project_transcript_relays_lossless_chunks_under_the_bound_identity(
    scenario, offset
):
    from app.schemas.runtime_transcript_transport import (
        RuntimeTranscriptTransferRequest,
    )
    from app.schemas.runtime_work import RuntimeTranscriptRequest
    from app.services.runtime_work_service import get_runtime_transcript

    s = scenario
    snapshot_id = "a" * 64
    transfer = {"snapshotId": snapshot_id, "offset": offset} if offset else None
    request = RuntimeTranscriptRequest(
        deviceId="admin-cloud",
        taskId="original-session",
        workspacePath="/untrusted",
        runtimeHandle={"threadId": "unrelated-private-thread"},
        projectSession={"projectId": str(s.project.id), "issueId": s.issue.id},
        transcriptProtocolVersion=2,
        transcriptTransfer=transfer,
        limit=5,
        refresh=True,
    )
    chunk = {
        "success": True,
        "transcriptProtocolVersion": 2,
        "transfer": {
            "snapshotId": snapshot_id,
            "encoding": "gzip+base64+json",
            "offset": offset or 0,
            "totalBytes": 2 * 360 * 1024,
            "nextOffset": None if offset else 360 * 1024,
            "payload": "cGF5bG9hZA==",
        },
    }
    s.rpc.return_value = chunk

    response = await get_runtime_transcript(
        db=s.db, user_id=s.member.id, address=request
    )

    assert response.model_dump(by_alias=True) == chunk
    assert s.rpc.await_args.kwargs["user_id"] == s.owner.id
    assert s.rpc.await_args.kwargs["allow_app_device_task_reading"] is True
    assert s.rpc.await_args.kwargs["payload"] == {
        "deviceId": "admin-cloud",
        "taskId": "original-session",
        "limit": 5,
        "refresh": True,
        "transcriptProtocolVersion": 2,
        **({"transcriptTransfer": transfer} if transfer else {}),
    }

    s.db.delete(s.grant)
    s.db.commit()
    request.transcript_transfer = RuntimeTranscriptTransferRequest(
        snapshotId=snapshot_id, offset=360 * 1024
    )
    with pytest.raises(HTTPException) as denied:
        await get_runtime_transcript(db=s.db, user_id=s.member.id, address=request)
    assert denied.value.status_code == 404
    assert s.rpc.await_count == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "boundary",
    [
        "outsider",
        "viewer",
        "other_author",
        "other_issue",
        "binding",
        "inactive",
    ],
)
async def test_rejects_invalid_collaboration_without_runtime_dispatch(
    scenario, boundary
):
    s = scenario
    request = comment(s)
    if boundary == "outsider":
        s.db.delete(s.grant)
    elif boundary == "viewer":
        s.grant.role = BaseRole.Viewer.value
    elif boundary == "other_author":
        s.db.query(ProjectChatMessage).filter_by(
            message_id=request.trigger_message_id
        ).one().sender_id = str(s.owner.id)
    elif boundary == "other_issue":
        request.task_id = "different-issue"
    elif boundary == "binding":
        s.execution.cloud_project_id = "different-project"
    elif boundary == "inactive":
        s.agent.status = "archived"
    s.db.commit()
    with pytest.raises(HTTPException):
        await execute_comment(s.db, user_id=s.member.id, request=request)
    s.rpc.assert_not_called()


@pytest.mark.asyncio
async def test_busy_session_accepts_follow_up_into_runtime_queue(scenario):
    s = scenario
    s.root.status = "streaming"
    s.rpc.return_value = {
        "accepted": True,
        "status": "queued",
        "queuePosition": 2,
    }
    s.db.commit()

    result = await execute_comment(s.db, user_id=s.member.id, request=comment(s))

    assert result[0].status == "pending"
    assert result[0].metadata["run_status"] == "queued"
    assert result[0].metadata["queue_position"] == 2
    assert s.issue.status == "in_progress"
    assert s.rpc.call_args.kwargs["payload"]["queueIfBusy"] is True


@pytest.mark.asyncio
async def test_runtime_rejection_is_durable_and_retry_does_not_resend(scenario):
    s = scenario
    s.rpc.return_value = {"accepted": False, "error": "Device offline"}
    request = comment(s)
    for _ in range(2):
        with pytest.raises(HTTPException, match="Device offline"):
            await execute_comment(s.db, user_id=s.member.id, request=request)
    response = (
        s.db.query(ProjectChatMessage)
        .filter_by(trigger_message_id=request.trigger_message_id)
        .one()
    )
    assert response.status == "failed"
    assert "Device offline" in response.content
    s.rpc.assert_awaited_once()


@pytest.mark.asyncio
async def test_unassigned_plain_comment_does_not_execute(scenario):
    s = scenario
    s.issue.assignee_agent_id = ""
    s.db.commit()
    assert (
        await execute_comment(
            s.db, user_id=s.member.id, request=comment(s, reply=False)
        )
        == []
    )
    s.rpc.assert_not_called()


@pytest.mark.asyncio
async def test_new_comment_queues_hidden_agent_once_in_its_own_thread(
    scenario, monkeypatch
):
    s = scenario
    queued = LoopItemExecution(
        loop_item_id=s.issue.id,
        cloud_project_id=str(s.project.id),
        agent_id=s.agent.id,
        executor_owner_user_id=s.owner.id,
        status="pending_approval",
        runtime_task_id="new-session",
    )

    def enqueue(db, **kwargs):
        db.add(queued)
        db.flush()
        return queued

    enqueue_mock = MagicMock(side_effect=enqueue)
    monkeypatch.setattr(
        "app.services.loop_item_executions.service.loop_item_execution_service.enqueue_for_assignment",
        enqueue_mock,
    )
    request = comment(s, text="再检查一下", reply=False)
    result = await execute_comment(s.db, user_id=s.member.id, request=request)
    repeated = await execute_comment(s.db, user_id=s.member.id, request=request)
    assert result[0].message_id == repeated[0].message_id
    assert result[0].root_message_id == request.trigger_message_id
    assert result[0].metadata["run_status"] == "pending_approval"
    assert enqueue_mock.call_args.kwargs["assigner_user_id"] == s.member.id
    context = enqueue_mock.call_args.kwargs["automation_context"]
    assert context["runtime_subject_user_id"] == s.owner.id
    assert context["comment_prompt"] == "再检查一下"
    assert "run_id" not in context
    enqueue_mock.assert_called_once()
    s.rpc.assert_not_called()


@pytest.mark.asyncio
async def test_cannot_mention_unassigned_disabled_agent(scenario):
    s = scenario
    s.issue.assignee_agent_id = ""
    s.agent.status = "archived"
    s.db.commit()
    with pytest.raises(HTTPException) as exc:
        comment(
            s,
            reply=False,
            mentions=[{"type": "agent", "id": s.agent.id, "label": "Codex"}],
        )
    assert exc.value.status_code == 409
    s.rpc.assert_not_called()


@pytest.mark.asyncio
async def test_continuation_projects_completion_without_reopening_automation(scenario):
    s = scenario
    s.root.metadata_json = {
        **s.root.metadata_json,
        "automation_run_id": "completed-automation",
    }
    s.db.commit()
    result = await execute_comment(s.db, user_id=s.member.id, request=comment(s))
    assert "automation_run_id" not in result[0].metadata
    projected = project_chat_service.project_runtime_event(
        s.db,
        device_id="admin-cloud",
        runtime_task_id="original-session",
        event_name="response.completed",
        payload={
            "data": {
                "response": {
                    "output": [
                        {
                            "type": "message",
                            "content": [
                                {"type": "output_text", "text": "Yes, complete"}
                            ],
                        }
                    ]
                }
            }
        },
    )
    assert projected is not None
    assert projected[0].message_id == result[0].message_id
    assert projected[0].status == "completed"
    assert s.root.content == "Done"


@pytest.mark.asyncio
async def test_manually_bound_session_uses_the_binding_owner(scenario):
    from app.models.delivery import LoopItemTaskBinding

    s = scenario
    s.db.delete(s.execution)
    s.root.metadata_json = {}
    s.db.add(
        LoopItemTaskBinding(
            cloud_project_id=str(s.project.id),
            loop_item_id=s.issue.id,
            device_id=s.root.runtime_device_id,
            task_id=s.root.runtime_task_id,
            task_user_id=s.owner.id,
            linked_by_user_id=s.owner.id,
            metadata_json={
                "model_selection": {
                    "modelName": "original-model",
                    "modelType": "runtime",
                    "options": {},
                }
            },
        )
    )
    s.db.commit()
    await execute_comment(s.db, user_id=s.member.id, request=comment(s))
    assert s.compiler.call_args.kwargs["user_id"] == s.owner.id
    assert s.compiler.call_args.kwargs["request"].model_id == "original-model"
    assert s.rpc.call_args.kwargs["payload"]["taskId"] == s.root.runtime_task_id


@pytest.mark.asyncio
async def test_manually_bound_team_session_keeps_its_model_on_reply(scenario):
    from app.models.delivery import LoopItemTaskBinding

    s = scenario
    s.db.delete(s.execution)
    s.root.metadata_json = {}
    s.db.add(
        LoopItemTaskBinding(
            cloud_project_id=str(s.project.id),
            loop_item_id=s.issue.id,
            device_id=s.root.runtime_device_id,
            task_id=s.root.runtime_task_id,
            task_user_id=s.owner.id,
            linked_by_user_id=s.owner.id,
            metadata_json={"wegent_team_id": 1880},
        )
    )
    s.db.commit()

    await execute_comment(s.db, user_id=s.member.id, request=comment(s))

    intent = s.compiler.call_args.kwargs["request"]
    assert intent.schema_version == 3
    assert intent.wegent_team_id == 1880
    assert intent.model_id is None
    assert intent.new_session is False
    assert intent.origin == {
        "type": "board_comment",
        "dispatchRole": "executor",
        "cloudProjectId": s.project.id,
        "loopItemId": s.issue.id,
    }
    assert s.compiler.call_args.kwargs["user_id"] == s.owner.id


@pytest.mark.asyncio
async def test_plain_comment_ack_retry_does_not_acquire_a_new_assignee(scenario):
    s = scenario
    s.issue.assignee_agent_id = ""
    s.db.commit()
    request = comment(s, reply=False)
    assert await execute_comment(s.db, user_id=s.member.id, request=request) == []
    s.issue.assignee_agent_id = s.agent.id
    s.db.commit()
    assert await execute_comment(s.db, user_id=s.member.id, request=request) == []
    s.rpc.assert_not_called()


@pytest.mark.asyncio
async def test_new_root_preserves_real_queue_owner_and_comment_intent(scenario):
    from app.models.kind import Kind

    s = scenario
    s.agent.device_id = "admin-cloud"
    s.agent.metadata_json = {
        **s.agent.metadata_json,
        "execution_environment": "cloud",
        "model": "admin-model",
        "model_type": "runtime",
    }
    s.db.commit()
    request = comment(s, text="Review this comment independently", reply=False)
    response = await execute_comment(s.db, user_id=s.member.id, request=request)
    execution = s.db.get(LoopItemExecution, response[0].metadata["execution_id"])
    assert execution.id != s.execution.id
    assert execution.executor_owner_user_id == s.owner.id
    assert execution.assigner_user_id == s.member.id
    assert execution.status == "queued"
    assert execution.automation_run_id == ""
    assert execution.assignment_pending
    assert execution.runtime_request == {}
    from app.services.loop_item_executions.service import loop_item_execution_service

    assert loop_item_execution_service.prepare_queued_assignments(s.db) == 1
    s.db.refresh(execution)
    assert not execution.assignment_pending
    assert execution.status == "queued"
    assert execution.runtime_request["message"].endswith(
        "Review this comment independently"
    )
    assert (
        f"cloud://projects/{s.project.id}/todos/{s.issue.id}"
        in execution.runtime_request["message"]
    )
    assert execution.runtime_request["modelId"] == "admin-model"
    assert (
        execution.runtime_request["origin"]["rootCommentId"]
        == request.trigger_message_id
    )
    assert execution.runtime_request["origin"]["type"] == "board_comment"
    assert execution.runtime_task_id != "original-session"


@pytest.mark.asyncio
@pytest.mark.parametrize("role", [BaseRole.Developer, BaseRole.Viewer])
async def test_member_reads_bound_transcript_using_original_owner(scenario, role):
    from app.schemas.runtime_work import RuntimeTranscriptRequest
    from app.services.runtime_work_service import get_runtime_transcript

    s = scenario
    s.grant.role = role.value
    s.db.commit()
    s.rpc.return_value = {
        "taskId": "original-session",
        "workspacePath": "",
        "runtime": "codex",
        "messages": [],
        "turns": [],
        "running": False,
    }
    request = RuntimeTranscriptRequest(
        deviceId="admin-cloud",
        taskId="original-session",
        workspacePath="/forged",
        runtimeHandle={"threadId": "another-session"},
        limit=20,
        beforeCursor="page-2",
        projectSession={"projectId": str(s.project.id), "issueId": s.issue.id},
    )
    await get_runtime_transcript(db=s.db, user_id=s.member.id, address=request)
    s.rpc.assert_awaited_once_with(
        user_id=s.owner.id,
        device_id="admin-cloud",
        method="runtime.tasks.transcript",
        payload={
            "deviceId": "admin-cloud",
            "taskId": "original-session",
            "limit": 20,
            "beforeCursor": "page-2",
            "transcriptProtocolVersion": 2,
        },
        timeout_seconds=30,
        allow_app_device_task_reading=True,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "requested_task", ["original-session", "original-session-manager-initial"]
)
async def test_group_transcript_reads_manager_session_without_changing_dispatch_identity(
    scenario, requested_task
):
    from app.schemas.runtime_work import RuntimeTranscriptRequest
    from app.services.runtime_work_service import get_runtime_transcript

    s = scenario
    s.execution.execution_payload = json.dumps(
        {
            **s.execution.execution_intent,
            "runtime_selection": {"executor_kind": "collaboration_group_dispatch"},
        }
    )
    s.db.commit()
    s.rpc.return_value = {
        "taskId": "original-session-manager-initial",
        "workspacePath": "/manager-session",
        "runtime": "codex",
        "messages": [
            {"id": "planning", "role": "assistant", "content": "Planning work"}
        ],
        "turns": [],
        "running": True,
    }
    response = await get_runtime_transcript(
        db=s.db,
        user_id=s.member.id,
        address=RuntimeTranscriptRequest(
            deviceId="admin-cloud",
            taskId=requested_task,
            runtimeHandle={"threadId": "unrelated-private-thread"},
            projectSession={"projectId": str(s.project.id), "issueId": s.issue.id},
        ),
    )

    assert response.local_task_id == "original-session-manager-initial"
    assert response.messages[0].content == "Planning work"
    assert s.execution.runtime_task_id == "original-session"
    assert s.rpc.call_args.kwargs["payload"] == {
        "deviceId": "admin-cloud",
        "taskId": "original-session-manager-initial",
        "transcriptProtocolVersion": 2,
    }
    assert s.rpc.call_args.kwargs["user_id"] == s.owner.id


@pytest.mark.asyncio
async def test_invalid_runtime_transcript_returns_explicit_gateway_error(scenario):
    from app.schemas.runtime_work import RuntimeTranscriptRequest
    from app.services.runtime_work_service import get_runtime_transcript

    s = scenario
    s.rpc.return_value = {
        "taskId": "original-session",
        "workspacePath": "",
        "runtime": "runtime",
        "messages": [],
        "turns": [],
    }
    with pytest.raises(HTTPException) as error:
        await get_runtime_transcript(
            db=s.db,
            user_id=s.member.id,
            address=RuntimeTranscriptRequest(
                deviceId="admin-cloud",
                taskId="original-session",
                projectSession={"projectId": str(s.project.id), "issueId": s.issue.id},
            ),
        )
    assert error.value.status_code == 502
    assert error.value.detail == "Runtime returned an invalid conversation response"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "change",
    ["outsider", "wrong_issue", "wrong_task", "wrong_device", "conflicting_owner"],
)
@pytest.mark.parametrize("continuation", [False, True])
async def test_project_transcript_rejects_unbound_or_unauthorized_requests(
    scenario, change, continuation
):
    from app.schemas.runtime_work import RuntimeTranscriptRequest
    from app.services.runtime_work_service import get_runtime_transcript

    s = scenario
    request = RuntimeTranscriptRequest(
        deviceId="admin-cloud",
        taskId="original-session",
        projectSession={"projectId": str(s.project.id), "issueId": s.issue.id},
        transcriptProtocolVersion=2,
        transcriptTransfer=(
            {"snapshotId": "a" * 64, "offset": 360 * 1024} if continuation else None
        ),
    )
    if change == "outsider":
        s.db.delete(s.grant)
    elif change == "wrong_issue":
        request.project_session.issue_id = "another-issue"
    elif change == "wrong_task":
        request.local_task_id = "private-session"
    elif change == "wrong_device":
        request.device_id = "another-device"
    else:
        s.db.add(
            LoopItemExecution(
                loop_item_id=s.issue.id,
                cloud_project_id=str(s.project.id),
                executor_owner_user_id=s.member.id,
                runtime_device_id="admin-cloud",
                runtime_task_id="original-session",
                status="completed",
            )
        )
    s.db.commit()
    with pytest.raises(HTTPException) as exc:
        await get_runtime_transcript(db=s.db, user_id=s.member.id, address=request)
    assert exc.value.status_code in {403, 404, 409}
    s.rpc.assert_not_awaited()


@pytest.mark.asyncio
async def test_project_transcript_uses_manual_binding_and_reports_real_device_failure(
    scenario,
):
    from app.models.delivery import LoopItemTaskBinding
    from app.schemas.runtime_work import RuntimeTranscriptRequest
    from app.services.device.runtime_rpc_service import RuntimeRpcError
    from app.services.runtime_work_service import get_runtime_transcript

    s = scenario
    s.db.delete(s.execution)
    s.db.add(
        LoopItemTaskBinding(
            id="manual-read-binding",
            cloud_project_id=str(s.project.id),
            loop_item_id=s.issue.id,
            task_user_id=s.owner.id,
            device_id="admin-cloud",
            task_id="original-session",
        )
    )
    s.db.commit()
    s.rpc.side_effect = RuntimeRpcError(
        "Device 'admin-cloud' is offline", code="device_offline"
    )
    request = RuntimeTranscriptRequest(
        deviceId="admin-cloud",
        taskId="original-session",
        projectSession={"projectId": str(s.project.id), "issueId": s.issue.id},
    )
    with pytest.raises(HTTPException) as exc:
        await get_runtime_transcript(db=s.db, user_id=s.owner.id, address=request)
    assert exc.value.status_code == 502
    assert "admin-cloud" in exc.value.detail
    assert s.rpc.await_args.kwargs["user_id"] == s.owner.id


@pytest.mark.asyncio
@pytest.mark.parametrize("continuation", [False, True])
@pytest.mark.parametrize("search", [False, True])
async def test_project_transcript_websocket_uses_same_authorization(
    scenario, monkeypatch, search, continuation
):
    from contextlib import contextmanager

    from app.api.ws import wework_runtime_namespace as ws

    s = scenario

    @contextmanager
    def session():
        yield s.db

    monkeypatch.setattr(ws, "get_db_session", session)

    # SQLite's test connection stays on its owning thread.
    async def inline(func, *args):
        return func(*args)

    monkeypatch.setattr(ws, "run_sync_in_executor", inline)
    await ws.relay_ipc_request(
        user_id=s.member.id,
        device_id="admin-cloud",
        method=(
            "runtime.tasks.transcript.search" if search else "runtime.tasks.transcript"
        ),
        params={
            "deviceId": "forged-device",
            "taskId": "original-session",
            "projectSession": {"projectId": str(s.project.id), "issueId": s.issue.id},
            **(
                {"query": "needle", "limit": 250}
                if search
                else {
                    "transcriptProtocolVersion": 2,
                    **(
                        {
                            "transcriptTransfer": {
                                "snapshotId": "a" * 64,
                                "offset": 360 * 1024,
                            }
                        }
                        if continuation
                        else {}
                    ),
                }
            ),
        },
        timeout_seconds=30,
    )
    assert s.rpc.await_args.kwargs["user_id"] == s.owner.id
    assert s.rpc.await_args.kwargs["payload"] == {
        "deviceId": "admin-cloud",
        "taskId": "original-session",
        **(
            {"query": "needle", "limit": 250}
            if search
            else {
                "transcriptProtocolVersion": 2,
                **(
                    {
                        "transcriptTransfer": {
                            "snapshotId": "a" * 64,
                            "offset": 360 * 1024,
                        }
                    }
                    if continuation
                    else {}
                ),
            }
        ),
    }


@pytest.mark.asyncio
async def test_routed_reply_queues_offline_and_keeps_the_original_session(
    scenario, monkeypatch
):
    from app.models.kind import Kind
    from app.schemas.runner_routing import RunnerCatalog
    from app.services.loop_item_executions.service import loop_item_execution_service
    from app.services.runner_routing import save_catalog

    db = scenario.db
    original = db.query(LoopItemExecution).first()
    agent = db.get(ProjectChatAgent, original.agent_id)
    original.execution_environment = "cloud"
    model = {"runtime": "codex", "provider": "openai", "model_id": "native-model"}
    device = (
        db.query(Kind)
        .filter_by(
            kind="Device",
            name="admin-cloud",
            namespace="default",
            user_id=original.executor_owner_user_id,
        )
        .one()
    )
    save_catalog(
        db,
        device,
        RunnerCatalog(
            models=[{**model, "label": "Native", "local_model_id": "native-model"}]
        ),
    )
    agent.metadata_json = {
        **agent.metadata_json,
        "execution_policy": {"mode": "project_pool"},
        "model_policy": {"mode": "fixed", "model": model},
    }
    intent = original.execution_intent
    intent["runtime_selection"] = {
        "runner_routing": {
            "execution_policy": {"mode": "project_pool"},
            "model": model,
        },
        "resolved_environment_id": str(device.id),
    }
    original.execution_payload = json.dumps(intent)
    db.get(LoopItem, original.loop_item_id).metadata_json = {
        "runner_binding": {"environment_id": str(device.id)}
    }
    monkeypatch.setattr(
        "app.services.runner_routing.project_environment_ids", lambda *_: {device.id}
    )
    trigger = ProjectChatMessage(
        message_id="queued-reply",
        client_message_id="queued-reply",
        project_id=original.cloud_project_id,
        task_id=original.loop_item_id,
        sender_type="user",
        sender_id=str(scenario.member.id),
        sender_name="Member",
        content="Continue",
        message_type="text",
        status="completed",
        reply_to_message_id="ai-result",
        thread_root_message_id="ai-result",
        metadata_json={},
    )
    db.add(trigger)
    db.commit()
    rows = await execute_comment(
        db,
        user_id=scenario.member.id,
        request=ProjectChatCommentExecution(
            project_id=original.cloud_project_id,
            task_id=original.loop_item_id,
            trigger_message_id=trigger.message_id,
        ),
    )
    queued = db.query(LoopItemExecution).order_by(LoopItemExecution.id.desc()).first()
    assert queued.id != original.id
    assert queued.status == "queued"
    assert queued.runtime_task_id == original.runtime_task_id
    assert queued.assignment_pending
    assert loop_item_execution_service.prepare_queued_assignments(db) == 1
    db.refresh(queued)
    assert queued.status == "queued"
    assert queued.runtime_request["newSession"] is False
    assert rows[0].status == "pending"
    next_request = comment(scenario, text="Another offline reply")
    followups = await execute_comment(
        db, user_id=scenario.member.id, request=next_request
    )
    assert followups[0].status == "pending"
    second = db.query(LoopItemExecution).order_by(LoopItemExecution.id.desc()).first()
    assert second.id != queued.id
    assert second.runtime_task_id == "original-session"
    scenario.rpc.assert_not_awaited()
    claimed = loop_item_execution_service.claim_next_for_device(
        db,
        execution_device_id=device.name,
        owner_user_id=device.user_id,
        environment="cloud",
        runtime_instance_id="runner",
    )
    assert claimed.id == queued.id
    assert claimed.runtime_task_id == "original-session"
    compiled = loop_item_execution_service.build_executor_runtime_payload(
        db,
        execution=claimed,
        execution_target_id=device.name,
        executor_device_id=device.name,
    )
    assert compiled["executionRequest"]["new_session"] is False
    assert compiled["runtimeAction"] == "send"


@pytest.mark.asyncio
async def test_cp13_cp16_comment_continuation_rechecks_current_device_grants(scenario):
    s = scenario
    source = (
        s.db.query(ResourceMember)
        .filter_by(
            resource_type="Device",
            entity_type="workspace",
            entity_id=str(s.project.workspace_id),
        )
        .one()
    )
    s.db.delete(source)
    s.db.commit()
    request = comment(s)
    with pytest.raises(HTTPException) as denied:
        await execute_comment(s.db, user_id=s.member.id, request=request)
    assert denied.value.status_code == 403
    s.rpc.assert_not_awaited()
    s.compiler.assert_not_called()
