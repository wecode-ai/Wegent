"""Comment delivery is independent of runtime readiness and queue consumption."""

import json
import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import update

from app.models.delivery import LoopItem
from app.models.kind import Kind
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.models.resource_member import ResourceMember
from app.schemas.project_chat import ProjectChatCommentExecution, ProjectChatSend
from app.services.loop_item_executions.service import loop_item_execution_service
from app.services.project_chat.comment_execution import execute_comment
from app.services.project_chat.service import project_chat_service
from tests.services.test_project_chat_mentions import (
    assigned_mention_scope as assigned_mention_scope,
)
from tests.services.test_project_chat_mentions import mention_scope as mention_scope


async def submit(db, user, project, item, agent, *, reply_to=None):
    saved = project_chat_service.send(
        db,
        user_id=user.id,
        user_name=user.user_name,
        request=ProjectChatSend(
            project_id=project.id,
            task_id=item.id,
            client_message_id=str(uuid.uuid4()),
            content="Please continue",
            reply_to_message_id=reply_to,
            mentions=[{"type": "agent", "id": agent.id, "label": agent.name}],
        ),
    )
    request = ProjectChatCommentExecution(
        project_id=project.id,
        task_id=item.id,
        trigger_message_id=saved.message.message_id,
    )
    responses = await execute_comment(db, user_id=user.id, request=request)
    return (
        saved.message,
        responses[0],
        db.get(LoopItemExecution, responses[0].metadata["execution_id"]),
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["model", "migration", "profile"])
async def test_runtime_configuration_cannot_reject_comment(
    test_db, test_user, assigned_mention_scope, failure
):
    project, _, item, agent, _ = assigned_mention_scope
    test_db.execute(
        update(LoopItem).where(LoopItem.id == item.id).values(metadata_json={})
    )
    if failure == "migration":
        agent.metadata_json = {
            **agent.metadata_json,
            "routing_configuration_required": True,
        }
    elif failure == "profile":
        agent.metadata_json = {
            **agent.metadata_json,
            "default_runtime_profile_id": "missing-profile",
            "execution_policy": None,
            "model_policy": None,
            "model": "queued-model",
        }
    test_db.commit()

    saved, response, execution = await submit(test_db, test_user, project, item, agent)
    assert saved.status == "completed"
    assert response.metadata["run_status"] == "queued"
    assert execution.status == "queued"
    assert execution.assignment_pending

    loop_item_execution_service.prepare_queued_assignments(test_db)
    test_db.refresh(execution)
    assert execution.status == "failed"
    assert execution.assignment_pending
    assert execution.error_message.startswith(
        {
            "model": "RUNNER_MODEL_UNAVAILABLE:",
            "migration": "RUNNER_CONFIGURATION_REQUIRED:",
            "profile": "Execution dependencies",
        }[failure]
    )
    assert (
        test_db.query(ProjectChatMessage)
        .filter_by(message_id=saved.message_id)
        .one()
        .status
        == "completed"
    )
    assert (
        test_db.query(ProjectChatMessage)
        .filter_by(message_id=response.message_id)
        .one()
        .status
        == "failed"
    )


@pytest.mark.asyncio
async def test_manual_approval_is_preserved_before_runtime_preparation(
    test_db, test_user, assigned_mention_scope
):
    project, _, item, agent, _ = assigned_mention_scope
    agent.metadata_json = {**agent.metadata_json, "execution_mode": "manual_approval"}
    test_db.commit()
    _, response, execution = await submit(test_db, test_user, project, item, agent)
    assert response.metadata["run_status"] == "pending_approval"
    assert loop_item_execution_service.prepare_queued_assignments(test_db) == 0
    assert execution.assignment_pending

    loop_item_execution_service.approve(
        test_db, execution_id=execution.id, user_id=test_user.id
    )
    test_db.commit()
    assert execution.status == "queued"
    assert loop_item_execution_service.prepare_queued_assignments(test_db) == 1
    test_db.refresh(execution)
    assert execution.status == "failed"
    assert execution.error_message.startswith("ISSUE_RUNNER_CONFLICT:")


@pytest.mark.asyncio
async def test_current_manual_approval_policy_is_not_bypassed_by_a_queued_request(
    test_db, test_user, assigned_mention_scope
):
    project, _, item, agent, _ = assigned_mention_scope
    _, _, execution = await submit(test_db, test_user, project, item, agent)
    agent.metadata_json = {**agent.metadata_json, "execution_mode": "manual_approval"}
    test_db.commit()
    assert loop_item_execution_service.prepare_queued_assignments(test_db) == 1
    test_db.refresh(execution)
    assert execution.status == "pending_approval"
    assert execution.approval_status == "pending"
    assert execution.assignment_pending


def test_pending_assignment_sql_matches_persisted_intent(test_db):
    payloads = [
        "",
        "invalid-json",
        "[]",
        "{}",
        json.dumps({"runtime_selection": {"assignment_request": {}}}),
        json.dumps({"runtime_selection": {"assignment_request": None}}),
        json.dumps({"runtime_selection": "invalid"}),
    ]
    rows = [
        LoopItemExecution(
            loop_item_id="missing", cloud_project_id="0", execution_payload=value
        )
        for value in payloads
    ]
    test_db.add_all(rows)
    test_db.commit()
    assert test_db.query(LoopItemExecution).filter(
        LoopItemExecution.assignment_pending
    ).all() == [rows[4]]
    assert [row for row in rows if row.assignment_pending] == [rows[4]]


@pytest.mark.asyncio
async def test_revoked_agent_cannot_be_dispatched_after_comment_acceptance(
    test_db, test_user, assigned_mention_scope
):
    project, _, item, agent, _ = assigned_mention_scope
    _, _, execution = await submit(test_db, test_user, project, item, agent)
    grant = (
        test_db.query(ResourceMember)
        .filter_by(
            resource_type="Workspace",
            entity_type="project_agent",
            entity_id=agent.id,
        )
        .one()
    )
    test_db.delete(grant)
    test_db.commit()

    loop_item_execution_service.prepare_queued_assignments(test_db)
    test_db.refresh(execution)
    assert execution.status == "cancelled"
    assert execution.runtime_device_id == ""
    assert (
        loop_item_execution_service.claim_next_for_device(
            test_db,
            execution_device_id="mention-runner",
            owner_user_id=test_user.id,
            environment="cloud",
            runtime_instance_id="runner",
        )
        is None
    )


@pytest.mark.asyncio
async def test_unprepared_work_cannot_be_claimed_when_the_preparation_batch_is_full(
    test_db, test_user, assigned_mention_scope, monkeypatch
):
    from app.services.loop_item_executions.queued_assignment import (
        prepare_queued_assignments,
    )

    project, _, item, agent, _ = assigned_mention_scope
    _, _, execution = await submit(test_db, test_user, project, item, agent)
    monkeypatch.setattr(
        loop_item_execution_service,
        "prepare_queued_assignments",
        lambda db: prepare_queued_assignments(loop_item_execution_service, db, limit=0),
    )
    arguments = dict(
        execution_device_id="mention-runner",
        owner_user_id=test_user.id,
        environment="cloud",
        runtime_instance_id="runner",
    )
    assert (
        loop_item_execution_service.claim_next_for_device(test_db, **arguments) is None
    )
    assert (
        loop_item_execution_service.claim(test_db, agent_id=agent.id, **arguments)
        is None
    )
    test_db.refresh(execution)
    assert execution.status == "queued"
    assert execution.assignment_pending


@pytest.mark.parametrize("denial", ["viewer", "private", "revoked"])
def test_cp07_cp09_cp11_queue_admission_preserves_use_authority(
    test_db, assigned_mention_scope, denial
):
    project, member, item, agent, _ = assigned_mention_scope
    if denial == "private":
        agent.metadata_json = {**agent.metadata_json, "visibility": "private"}
    elif denial == "viewer":
        test_db.query(ResourceMember).filter_by(
            resource_type="Workspace",
            resource_id=project.workspace_id,
            entity_type="user",
            entity_id=str(member.id),
        ).one().role = "Viewer"
    else:
        test_db.query(ResourceMember).filter_by(
            resource_type="Workspace",
            entity_type="project_agent",
            entity_id=agent.id,
        ).one().status = "rejected"
    test_db.commit()
    with pytest.raises(HTTPException):
        loop_item_execution_service.enqueue_for_assignment(
            test_db,
            loop_item_id=item.id,
            cloud_project_id=project.id,
            agent=agent,
            assigner_user_id=member.id,
            environment="cloud",
            execution_device_id=None,
            priority=None,
        )
    assert test_db.query(LoopItemExecution).count() == 0


@pytest.mark.asyncio
async def test_offline_root_and_early_reply_are_durable_and_keep_one_session(
    test_db, test_user, assigned_mention_scope
):
    project, _, item, agent, _ = assigned_mention_scope
    device = (
        test_db.query(Kind)
        .filter_by(kind="Device", user_id=test_user.id, name="mention-runner")
        .one()
    )
    model = {"runtime": "codex", "provider": "openai", "model_id": "queued-model"}
    device.json = {
        "spec": {
            "deviceType": "cloud",
            "runnerCatalog": {
                "models": [
                    {
                        **model,
                        "label": "Queued model",
                        "local_model_id": "queued-model",
                        "is_default": True,
                    }
                ]
            },
        }
    }
    agent.metadata_json = {
        **agent.metadata_json,
        "execution_policy": {"mode": "fixed", "environment_id": str(device.id)},
        "model_policy": {"mode": "fixed", "model": model},
    }
    test_db.execute(
        update(LoopItem).where(LoopItem.id == item.id).values(metadata_json={})
    )
    test_db.commit()
    _, root_message, root = await submit(test_db, test_user, project, item, agent)
    _, _, reply = await submit(
        test_db, test_user, project, item, agent, reply_to=root_message.message_id
    )
    assert root.status == reply.status == "queued"
    assert root.runtime_task_id == reply.runtime_task_id
    prepared = loop_item_execution_service.prepare_queued_assignments(test_db)
    assert prepared == 1, [
        (row.id, row.status, row.error_message)
        for row in test_db.query(LoopItemExecution).all()
    ]
    test_db.refresh(reply)
    assert reply.assignment_pending
    assert root.status == "queued"

    from app.services.loop_item_executions.queued_assignment import (
        prepare_queued_assignments,
    )

    _, _, later_root = await submit(test_db, test_user, project, item, agent)
    assert (
        prepare_queued_assignments(loop_item_execution_service, test_db, limit=1) == 1
    )
    test_db.refresh(later_root)
    assert not later_root.assignment_pending
    assert later_root.runtime_task_id != root.runtime_task_id

    claimed = loop_item_execution_service.claim_next_for_device(
        test_db,
        execution_device_id=device.name,
        owner_user_id=test_user.id,
        environment="cloud",
        runtime_instance_id="runner-online",
    )
    assert claimed.id == root.id
    loop_item_execution_service._persist_runtime_request_intent(
        test_db, execution=claimed
    )
    # Model completion is synthetic here; no real Runtime or model service runs.
    claimed.status = "completed"
    test_db.commit()
    assert loop_item_execution_service.prepare_queued_assignments(test_db) == 1
    claimed_reply = loop_item_execution_service.claim_next_for_device(
        test_db,
        execution_device_id=device.name,
        owner_user_id=test_user.id,
        environment="cloud",
        runtime_instance_id="runner-online",
    )
    assert claimed_reply.id == reply.id
    assert claimed_reply.runtime_task_id == root.runtime_task_id
    assert claimed_reply.runtime_request["newSession"] is False
