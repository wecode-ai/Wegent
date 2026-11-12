"""Real Group rounds separate Runtime ownership from delegated Group authority."""

from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import HTTPException

from app.api.endpoints import loop_item_executions
from app.models.delivery import ProjectChatAgent
from app.models.loop_item_execution import LoopItemExecution
from app.models.resource_member import ResourceMember
from app.schemas.delivery import LoopItemCreate, LoopItemTaskBind
from app.schemas.project_chat import (
    LoopItemExecutionAssignmentStatus,
    LoopItemExecutionBatchCreate,
    LoopItemExecutionBatchItem,
    LoopItemExecutionManagerDecision,
    ProjectChatAgentCreate,
    ProjectChatCommentExecution,
)
from app.schemas.workspace import CollaborationGroupCreate, CollaborationGroupMember
from app.services.loop_items.service import loop_item_service
from app.services.project_chat.service import project_chat_service
from app.services.workspaces import workspace_service
from tests.services.test_group_agent_resources import inline, project_agent
from tests.services.test_loop_item_executions import _ensure_device
from tests.services.test_thread_participation import make_group, person
from tests.utils.collaboration import authorize_resource


@pytest.fixture(params=[False, True], ids=["group-resource", "linked-project-resource"])
def group_round(test_db, test_user, monkeypatch, request):
    actor = person(test_db, "group-round-assigner")
    group = make_group(test_db, test_user, [(actor, "Developer")])
    if request.param:
        source, manager = project_agent(test_db, test_user)
        test_db.add(
            ResourceMember(
                resource_type="CloudProject",
                resource_id=int(source.id),
                entity_type="user",
                entity_id=str(actor.id),
                status="approved",
                role="Developer",
            )
        )
    else:
        source, manager = group, inline(test_db, test_user, group)
    device = _ensure_device(test_db, test_user, "group-round-device", "local")
    test_db.add(
        ResourceMember(
            resource_type="Device",
            resource_id=device.id,
            entity_type="chat_group",
            entity_id=group.id,
            status="approved",
            role="Developer",
        )
    )
    if request.param:
        authorize_resource(test_db, source, device)
    manager.device_id = device.name
    manager.metadata_json = {**manager.metadata_json, "model": "test-model"}
    test_db.flush()
    worker_view = project_chat_service.create_agent(
        test_db,
        user_id=test_user.id,
        project_id=str(source.id),
        request=ProjectChatAgentCreate(name="Round member", runtime="codex"),
    )
    worker = test_db.get(ProjectChatAgent, worker_view.id)
    worker.device_id = device.name
    worker.metadata_json = {**worker.metadata_json, "model": "test-model"}
    test_db.flush()
    leader = CollaborationGroupMember(kind="agent", id=manager.id)
    crew = workspace_service.create_project_collaboration_group(
        test_db,
        int(source.id),
        test_user.id,
        CollaborationGroupCreate(
            name="Independent group round",
            leader=leader,
            members=[
                leader,
                CollaborationGroupMember(kind="agent", id=worker.id),
                CollaborationGroupMember(kind="human", id=str(actor.id)),
            ],
        ),
    )
    item = loop_item_service.create(
        test_db,
        cloud_project_id=group.id,
        user_id=actor.id,
        values=LoopItemCreate(
            title="Group round",
            assignee_group_id=str(crew["id"]),
            assignee_group_source_id=source.id,
            classification_project_id=source.id if request.param else None,
        ),
    )
    dispatch = test_db.query(LoopItemExecution).filter_by(loop_item_id=item.id).one()
    dispatch.runtime_task_id = "group-manager-runtime"
    dispatch.runtime_device_id = device.name
    test_db.commit()
    monkeypatch.setattr(loop_item_executions, "push_project_chat_message", Mock())
    monkeypatch.setattr("app.core.async_utils.schedule_async_task", Mock())
    return SimpleNamespace(
        group=group,
        source=source,
        actor=actor,
        owner=test_user,
        manager=manager,
        worker=worker,
        item=item,
        dispatch=dispatch,
        dispatch_id=dispatch.runtime_origin_context["dispatch_id"],
    )


def batch_values(fixture):
    return LoopItemExecutionBatchCreate(
        loop_item_id=fixture.item.id,
        dispatch_id=fixture.dispatch_id,
        round_id="round-one",
        manager_agent_id=fixture.manager.id,
        manager_runtime_task_id="group-manager-runtime-manager-initial",
        items=[
            LoopItemExecutionBatchItem(
                assignment_id="human-one",
                assignee_type="human",
                assignee_id=str(fixture.actor.id),
                title="Review",
                instructions="Review result",
            )
        ],
    )


@pytest.mark.parametrize("runtime_owner_in_group", [True, False])
def test_group_runtime_owner_records_human_round_without_project(
    test_db, group_round, runtime_owner_in_group
):
    if not runtime_owner_in_group:
        test_db.query(ResourceMember).filter_by(
            resource_type="CollaborationChatGroup",
            resource_id=int(group_round.group.id),
            entity_type="user",
            entity_id=str(group_round.owner.id),
        ).one().status = "rejected"
        test_db.commit()
        with pytest.raises(HTTPException) as denied:
            loop_item_service.bind_task(
                test_db,
                group_round.item.id,
                LoopItemTaskBind(
                    deviceId="private-device", taskId="unrelated-private-task"
                ),
                group_round.owner.id,
            )
        assert denied.value.status_code == 404
    result = loop_item_executions.enqueue_execution_batch(
        int(group_round.group.id), batch_values(group_round), test_db, group_round.owner
    )
    assert len(result["human_assignments"]) == 1
    assert result["human_assignments"][0]["human_user_id"] == group_round.actor.id
    assert group_round.dispatch.assigner_user_id == group_round.actor.id
    assert group_round.dispatch.executor_owner_user_id == group_round.owner.id
    assert group_round.item.cloud_project_id == group_round.group.id
    if not runtime_owner_in_group:
        assert (
            test_db.query(ResourceMember)
            .filter_by(
                resource_type="CollaborationChatGroup",
                resource_id=int(group_round.group.id),
                entity_type="user",
                entity_id=str(group_round.owner.id),
            )
            .one()
            .status
            == "rejected"
        )


@pytest.mark.parametrize("revocation", ["caller", "actor", "generation"])
def test_group_round_rejects_wrong_owner_or_revoked_assignment(
    test_db, group_round, revocation
):
    caller = group_round.owner
    if revocation == "caller":
        caller = group_round.actor
    elif revocation == "actor":
        test_db.query(ResourceMember).filter_by(
            resource_type="CollaborationChatGroup",
            resource_id=int(group_round.group.id),
            entity_type="user",
            entity_id=str(group_round.actor.id),
        ).one().status = "rejected"
    else:
        group_round.item.metadata_json = {
            **group_round.item.metadata_json,
            "collaboration_group_assignment_key": "new-assignment-generation",
        }
    test_db.commit()
    with pytest.raises(HTTPException) as denied:
        loop_item_executions.enqueue_execution_batch(
            int(group_round.group.id), batch_values(group_round), test_db, caller
        )
    assert denied.value.status_code in {403, 404}


@pytest.mark.parametrize("target_status", ["in_review", "completed"])
def test_group_manager_can_persist_its_current_status_decision(
    test_db, group_round, target_status
):
    values = LoopItemExecutionManagerDecision(
        loop_item_id=group_round.item.id,
        dispatch_id=group_round.dispatch_id,
        manager_agent_id=group_round.manager.id,
        idempotency_key="review-one",
        target_status=target_status,
        reason="Ready for review",
    )
    result = loop_item_executions.decide_collaboration_issue_status(
        int(group_round.group.id), values, test_db, group_round.owner
    )
    assert result["item"]["status"] == target_status
    test_db.refresh(group_round.dispatch)
    assert group_round.dispatch.status == "completed"


def test_group_member_round_callback_binds_exact_authorized_runtime_session(
    test_db, group_round
):
    values = batch_values(group_round).model_copy(
        update={
            "items": [
                LoopItemExecutionBatchItem(
                    assignment_id="agent-one",
                    assignee_type="agent",
                    assignee_id=group_round.worker.id,
                    title="Review",
                    instructions="Review the result",
                )
            ]
        }
    )
    loop_item_executions.enqueue_execution_batch(
        int(group_round.group.id), values, test_db, group_round.owner
    )
    reported = loop_item_executions.report_collaboration_assignment_status(
        int(group_round.group.id),
        LoopItemExecutionAssignmentStatus(
            loop_item_id=group_round.item.id,
            dispatch_id=group_round.dispatch_id,
            round_id="round-one",
            assignment_id="agent-one",
            runtime_device_id=group_round.dispatch.runtime_device_id,
            runtime_task_id="group-manager-runtime-member-round-one-agent-one",
            status="completed",
            result="Actual member result",
        ),
        test_db,
        group_round.owner,
    )
    assert reported["changed"] is True
    assert reported["message"]["content"] == "Actual member result"
    assert reported["message"]["taskId"] == group_round.item.id

    from app.models.project_chat_message import ProjectChatMessage
    from app.services.project_chat.runtime_binding import (
        resolve_collaboration_member_session,
    )

    message = (
        test_db.query(ProjectChatMessage)
        .filter_by(message_id=reported["message"]["messageId"])
        .one()
    )
    continuation = resolve_collaboration_member_session(
        test_db,
        ProjectChatCommentExecution(
            project_id=group_round.group.id,
            task_id=group_round.item.id,
            trigger_message_id=message.message_id,
        ),
        message,
    )
    assert continuation.agent_id == group_round.worker.id
    assert continuation.runtime_task_id == message.runtime_task_id
    assert continuation.assigner_user_id == group_round.actor.id
    assert continuation.runtime_request["cloudProjectId"] == group_round.group.id
