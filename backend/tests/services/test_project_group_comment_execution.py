"""Group replies retain their native conversation and durable dispatch grant."""

import json
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

from app.models.delivery import LoopItemTaskBinding, ProjectChatAgent
from app.models.kind import Kind
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.schemas.project_chat import LoopItemExecutionAssignmentStatus
from app.schemas.runtime_work import RuntimeTaskCreateRequest, RuntimeTranscriptRequest
from app.services.collaboration_member_activity import (
    project_collaboration_member_activity,
)
from app.services.collaboration_round_assignment import assign_round_owner
from app.services.loop_item_executions.service import loop_item_execution_service
from app.services.project_chat.comment_execution import _execution, execute_comment
from app.services.project_chat.runtime_binding import collaboration_manager_task_id
from app.services.project_chat.session_access import resolve_project_transcript
from tests.services.test_project_comment_execution import comment, scenario
from tests.utils.collaboration import authorize_project_agent


@pytest.fixture
def group_scenario(scenario, monkeypatch):
    s = scenario
    from app.models.resource_member import ResourceMember

    device = (
        s.db.query(Kind)
        .filter_by(
            kind="Device", name="admin-cloud", namespace="default", user_id=s.owner.id
        )
        .one()
    )
    group = {
        "id": "group-1",
        "leader": {"kind": "agent", "id": s.agent.id},
        "members": [],
    }
    record = Kind(
        kind="CollaborationGroup",
        name="Comment group",
        namespace=f"projects/{s.project.id}",
        user_id=s.owner.id,
        is_active=True,
        json={"spec": group},
    )
    s.db.add(record)
    s.db.flush()
    group["id"] = str(record.id)
    s.db.add(
        ResourceMember.create(
            resource_type="CollaborationGroup",
            resource_id=record.id,
            entity_type="project",
            entity_id=str(s.project.id),
            role="Developer",
            status="approved",
        )
    )
    context = {
        "dispatch_kind": "collaboration_group",
        "dispatch_role": "manager",
        "dispatch_id": "group-dispatch-1",
        "dispatch_task_id": s.issue.id,
        "manager_agent_id": s.agent.id,
        "assignment_key": "assignment-1",
        "collaboration_group_id": group["id"],
        "collaboration_group": group,
        "execution_prompt": "Manage this group",
    }
    s.issue.metadata_json = {
        "collaboration_group": group,
        "collaboration_group_assignment_key": "assignment-1",
        "runner_binding": {"environment_id": str(device.id)},
    }
    s.agent.device_id = "admin-cloud"
    s.agent.metadata_json = {
        **s.agent.metadata_json,
        "execution_environment": "cloud",
        "model": "admin-model",
        "model_type": "runtime",
    }
    s.execution.agent_id = ""
    s.execution.execution_payload = json.dumps(
        {
            **s.execution.execution_intent,
            "runtime_selection": {"executor_kind": "collaboration_group_dispatch"},
            "origin_context": context,
        }
    )
    s.root.runtime_task_id = ""
    s.root.runtime_device_id = ""
    s.root.metadata_json = {
        "dispatch_role": "manager",
        "dispatch_id": context["dispatch_id"],
        "activity_type": "manager_status_comment",
    }
    intent = RuntimeTaskCreateRequest.model_validate(s.execution.runtime_request)
    builder = MagicMock(
        side_effect=lambda _db, **kwargs: intent.model_copy(
            update={
                "local_task_id": kwargs["runtime_task_id"],
                "origin": {
                    "dispatchId": context["dispatch_id"],
                    "dispatchRole": "manager",
                    "managerAgentId": s.agent.id,
                },
            }
        )
    )
    monkeypatch.setattr(
        loop_item_execution_service,
        "_runtime_profile_and_context",
        lambda _db, *, execution: (
            SimpleNamespace(build_runtime_request=builder),
            {**context, **execution.runtime_origin_context},
        ),
    )
    monkeypatch.setattr(
        "app.services.loop_item_executions.service.notify_execution_lifecycle",
        MagicMock(),
    )
    s.db.commit()
    return s


@pytest.fixture
def member_scenario(group_scenario):
    s = group_scenario
    agent = ProjectChatAgent(
        id="group-member",
        cloud_project_id=str(s.project.id),
        name="Collector",
        title="Collector",
        device_id="admin-cloud",
        created_by_user_id=s.owner.id,
        status="active",
        metadata_json={
            "runtime": "codex",
            "execution_environment": "cloud",
            "model": "member-model",
            "model_type": "runtime",
        },
    )
    authorize_project_agent(s.db, agent)
    s.db.add(agent)
    device = s.db.query(Kind).filter_by(kind="Device", name="admin-cloud").one()
    device.json = {
        **device.json,
        "spec": {**device.json["spec"], "deviceId": "admin-native"},
    }
    context = dict(s.execution.runtime_origin_context)
    group = {
        **context["collaboration_group"],
        "members": [{"kind": "agent", "id": agent.id}],
    }
    context["collaboration_group"] = group
    record = s.db.get(Kind, int(group["id"]))
    record.json = {"spec": group}
    s.execution.execution_payload = json.dumps(
        {**s.execution.execution_intent, "origin_context": context}
    )
    s.issue.metadata_json = {**s.issue.metadata_json, "collaboration_group": group}
    task_id = f"{s.execution.runtime_task_id}-member-round-1-assignment-1"
    activity(
        s,
        "member-plan",
        activity_type="manager_assignment",
        coordination_round_id="round-1",
        dispatch_assignments=[
            {
                "assignment_id": "assignment-1",
                "assignee_type": "agent",
                "agent_id": agent.id,
                "task_title": "Collect evidence",
                "instructions": "Inspect CPU usage",
                "runtime_task_id": task_id,
            }
        ],
    )
    member = activity(
        s,
        "member-result",
        activity_type="member_execution",
        dispatch_role="member",
        coordination_round_id="round-1",
        assignment_id="assignment-1",
    )
    member.agent_id = member.sender_id = agent.id
    member.sender_name = agent.name
    member.runtime_device_id = "admin-native"
    member.runtime_task_id = task_id
    s.root = member
    s.member_agent = agent
    s.db.commit()
    return s


def activity(s, key, **metadata):
    row = ProjectChatMessage(
        message_id=key,
        client_message_id=key,
        project_id=str(s.project.id),
        task_id=s.issue.id,
        sender_type="agent",
        sender_id=s.agent.id,
        sender_name="Manager",
        agent_id=s.agent.id,
        content="Waiting for a reply",
        message_type="text",
        status="completed",
        metadata_json={
            "dispatch_role": "manager",
            "dispatch_id": "group-dispatch-1",
            **metadata,
        },
    )
    s.db.add(row)
    s.db.flush()
    return row


def test_historical_manager_decision_resolves_its_recorded_rounds(group_scenario):
    s = group_scenario
    activity(
        s, "plan-1", activity_type="manager_assignment", coordination_round_id="r1"
    )
    activity(
        s, "plan-2", activity_type="manager_assignment", coordination_round_id="r2"
    )
    decision = activity(s, "decision", activity_type="manager_status_comment")

    resolved = collaboration_manager_task_id(s.db, s.execution, decision)

    assert (
        resolved == "original-session-manager-initial-manager-after-r1-manager-after-r2"
    )
    assert not decision.runtime_task_id


def test_recorded_older_manager_thread_does_not_move_to_latest_round(group_scenario):
    s = group_scenario
    activity(s, "plan", activity_type="manager_assignment", coordination_round_id="r1")
    decision = activity(s, "decision", activity_type="manager_status_comment")
    decision.runtime_task_id = "original-session-manager-initial"

    assert (
        collaboration_manager_task_id(s.db, s.execution, decision)
        == decision.runtime_task_id
    )


def test_unrelated_manager_session_is_rejected(group_scenario):
    s = group_scenario
    s.root.runtime_task_id = "another-private-session"

    with pytest.raises(HTTPException) as error:
        collaboration_manager_task_id(s.db, s.execution, s.root)

    assert error.value.status_code == 409


@pytest.mark.asyncio
async def test_manager_reply_queues_same_session_and_rebuilds_member_profiles(
    group_scenario, monkeypatch
):
    s = group_scenario
    request = comment(s, text="Execute pwd")

    first = await execute_comment(s.db, user_id=s.member.id, request=request)
    second = await execute_comment(s.db, user_id=s.member.id, request=request)

    assert first[0].message_id == second[0].message_id
    queued = s.db.get(LoopItemExecution, first[0].metadata["execution_id"])
    assert queued.id != s.execution.id
    assert queued.status == "queued"
    assert queued.runtime_task_id == "original-session-manager-initial"
    assert queued.executor_owner_user_id == s.owner.id
    assert queued.assigner_user_id == s.member.id
    assert queued.runtime_request["newSession"] is False
    assert queued.runtime_request["origin"]["dispatchRole"] == "manager"
    assert queued.runtime_request["origin"]["executionId"] == queued.id
    assert (
        queued.runtime_origin_context["collaboration_dispatch_execution_id"]
        == s.execution.id
    )
    assert first[0].metadata["dispatch_id"] == "group-dispatch-1"
    s.rpc.assert_not_called()

    profiles = [{"memberIds": [s.agent.id], "runtimePayload": {"runtime": "codex"}}]
    compiler = MagicMock(return_value=profiles)
    monkeypatch.setattr(
        loop_item_execution_service, "_collaboration_member_runtime_profiles", compiler
    )

    payload = loop_item_execution_service.build_executor_runtime_payload(
        s.db,
        execution=queued,
        execution_target_id="admin-cloud",
        executor_device_id="admin-cloud",
    )

    assert payload["runtimeAction"] == "send"
    assert payload["clientUserMessageId"] == request.trigger_message_id
    assert (
        payload["runtimeHandle"]["collaborationDispatchTaskId"]
        == s.execution.runtime_task_id
    )
    assert payload["runtimeHandle"]["collaborationMemberRuntimeProfiles"] == profiles
    assert compiler.call_args.kwargs["execution"].id == queued.id


@pytest.mark.asyncio
async def test_member_reply_without_execution_or_binding_queues_original_session(
    member_scenario,
):
    s = member_scenario
    assert s.db.query(LoopItemTaskBinding).count() == 0
    request = comment(s, text="Inspect CPU usage")

    result = await execute_comment(s.db, user_id=s.member.id, request=request)

    queued = s.db.get(LoopItemExecution, result[0].metadata["execution_id"])
    assert queued.agent_id == s.member_agent.id
    assert queued.executor_owner_user_id == s.owner.id
    assert queued.runtime_task_id == s.root.runtime_task_id
    assert queued.runtime_request["newSession"] is False
    assert queued.runtime_request["modelId"] == "member-model"
    assert queued.runtime_request["origin"]["dispatchRole"] == "member"
    assert queued.runtime_request["origin"]["coordinationRoundId"] == "round-1"
    assert (
        queued.runtime_origin_context["collaboration_dispatch_execution_id"]
        == s.execution.id
    )
    assert result[0].metadata["dispatch_id"] == "group-dispatch-1"
    s.rpc.assert_not_called()


@pytest.mark.parametrize("field", ["agent_id", "runtime_task_id", "runtime_device_id"])
def test_member_reply_rejects_a_session_outside_its_assignment(member_scenario, field):
    s = member_scenario
    setattr(s.root, field, "unrelated-identity")

    with pytest.raises(HTTPException) as error:
        _execution(s.db, comment(s), s.root)

    assert error.value.status_code == 409


def test_historical_member_transcript_uses_assignment_without_model_compilation(
    member_scenario,
):
    s = member_scenario
    s.issue.metadata_json = {}

    owner, address = resolve_project_transcript(
        s.db,
        s.member.id,
        RuntimeTranscriptRequest(
            deviceId=s.root.runtime_device_id,
            taskId=s.root.runtime_task_id,
            projectSession={"projectId": str(s.project.id), "issueId": s.issue.id},
        ),
    )

    assert owner == s.owner.id
    assert address.local_task_id == s.root.runtime_task_id
    s.compiler.assert_not_called()
    s.rpc.assert_not_called()


def test_member_activity_binds_its_session_after_the_issue_is_reassigned(
    member_scenario,
):
    s = member_scenario
    s.issue.metadata_json = {}

    message, changed = project_collaboration_member_activity(
        s.db,
        project_id=s.project.id,
        values=LoopItemExecutionAssignmentStatus(
            loop_item_id=s.issue.id,
            dispatch_id="group-dispatch-1",
            round_id="round-1",
            assignment_id="assignment-1",
            runtime_device_id=s.root.runtime_device_id,
            runtime_task_id=s.root.runtime_task_id,
            status="completed",
            result="CPU evidence collected",
        ),
    )

    binding = s.db.query(LoopItemTaskBinding).one()
    assert changed
    assert binding.task_user_id == s.owner.id
    assert binding.task_id == message.runtime_task_id == s.root.runtime_task_id
    assert binding.device_id == message.runtime_device_id == s.root.runtime_device_id
    assert message.metadata_json["task_binding_id"] == str(binding.id)
    assert binding.metadata_json["dispatch_id"] == "group-dispatch-1"
    assert binding.metadata_json["dispatch_round_id"] == "round-1"
    assert binding.metadata_json["assignment_id"] == "assignment-1"


@pytest.mark.asyncio
@pytest.mark.parametrize("human_owner", [False, True])
async def test_member_reply_uses_upstream_session_after_round_owner_handoff(
    member_scenario, human_owner
):
    s = member_scenario
    assignment = (
        {
            "assignee_type": "human",
            "human_user_id": s.member.id,
            "human_user_name": s.member.user_name,
        }
        if human_owner
        else {
            "assignee_type": "agent",
            "agent_id": s.member_agent.id,
            "agent_name": s.member_agent.name,
        }
    )
    assign_round_owner(s.db, item=s.issue, assignments=[assignment], user_id=s.owner.id)
    s.db.commit()

    rows = await execute_comment(
        s.db, user_id=s.member.id, request=comment(s, text="Check memory")
    )

    queued = s.db.get(LoopItemExecution, rows[0].metadata["execution_id"])
    assert queued.runtime_task_id == s.root.runtime_task_id
    assert queued.executor_owner_user_id == s.owner.id
    assert queued.runtime_request["newSession"] is False
    assert queued.runtime_request["modelId"] == "member-model"
    assert queued.runtime_request["origin"]["assignmentId"] == "assignment-1"
