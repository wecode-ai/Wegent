"""Exact human answers retain the source grant without sharing private resources."""

import json
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

from app.models.delivery import LoopItemTaskBinding
from app.models.kind import Kind
from app.models.loop_item_execution import LoopItemExecution
from app.models.resource_member import ResourceMember
from app.models.user import User
from app.schemas.runner_routing import RunnerCatalog
from app.services.collaboration_permissions import collaboration_permission_service
from app.services.loop_item_executions.service import loop_item_execution_service
from app.services.project_chat.comment_execution import execute_comment
from app.services.runner_routing import save_catalog
from tests.services.test_project_comment_execution import comment, create_scenario


@pytest.fixture
def private_answer(test_db, monkeypatch, runtime_transcript_sessions):
    monkeypatch.setattr(
        "app.services.loop_item_executions.service.notify_execution_lifecycle",
        MagicMock(),
    )
    member = User(id=7, user_name="recipient", password_hash="unused", is_active=True)
    owner = User(id=9, user_name="source-owner", password_hash="unused", is_active=True)
    test_db.add_all([member, owner])
    test_db.flush()
    scenario = create_scenario(test_db, member, owner, monkeypatch)
    scenario.agent.metadata_json = {
        **scenario.agent.metadata_json,
        "visibility": "private",
    }
    scenario.issue.metadata_json = {
        "human_requests": [
            {
                "id": "business-answer",
                "recipient_user_id": 7,
                "root_comment_id": scenario.root.message_id,
                "runtime_device_id": scenario.execution.runtime_device_id,
                "runtime_task_id": scenario.execution.runtime_task_id,
                "status": "pending",
                "version": 1,
            }
        ],
    }
    test_db.commit()
    return scenario


def answer_request(scenario):
    return comment(scenario).model_copy(update={"human_request_id": "business-answer"})


@pytest.mark.asyncio
async def test_cp09_exact_answer_continues_private_source_without_granting_use(
    private_answer,
):
    s = private_answer
    with pytest.raises(HTTPException) as denied:
        await execute_comment(s.db, user_id=7, request=comment(s))
    assert denied.value.status_code == 403
    s.db.rollback()
    result = await execute_comment(s.db, user_id=7, request=answer_request(s))
    assert result
    assert s.compiler.call_args.kwargs["user_id"] == 9
    assert s.rpc.call_args.kwargs["user_id"] == 9
    assert s.rpc.call_args.kwargs["payload"]["taskId"] == "original-session"
    assert s.issue.metadata_json["human_requests"][0]["status"] == "resolved"
    with pytest.raises(HTTPException) as still_private:
        collaboration_permission_service.require_project_agent(
            s.db, s.project.id, s.agent.id, user_id=7
        )
    assert still_private.value.status_code == 403


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "invalid", ["recipient", "thread", "runtime", "revoked", "assigner"]
)
async def test_cp13_exact_answer_never_substitutes_revoked_or_unbound_authority(
    private_answer, invalid
):
    s = private_answer
    question = dict(s.issue.metadata_json["human_requests"][0])
    if invalid == "recipient":
        question["recipient_user_id"] = 9
    elif invalid == "thread":
        question["root_comment_id"] = "another-thread"
    elif invalid == "runtime":
        question["runtime_task_id"] = "another-runtime"
    elif invalid == "assigner":
        s.execution.assigner_user_id = 7
    else:
        s.db.query(ResourceMember).filter_by(
            entity_type="project_agent", entity_id=s.agent.id
        ).update({"status": "rejected"})
    s.issue.metadata_json = {"human_requests": [question]}
    s.db.commit()
    with pytest.raises(HTTPException) as denied:
        await execute_comment(s.db, user_id=7, request=answer_request(s))
    assert denied.value.status_code == (
        409 if invalid in {"thread", "runtime"} else 403
    )
    s.rpc.assert_not_called()
    s.compiler.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("revoke", [False, True])
async def test_cp15_queued_answer_preserves_original_assigner_and_current_revocation(
    private_answer,
    revoke,
):
    s = private_answer
    device = (
        s.db.query(Kind)
        .filter_by(kind="Device", namespace="default", name="admin-cloud", user_id=9)
        .one()
    )
    model = {"runtime": "codex", "provider": "openai", "model_id": "native-model"}
    save_catalog(
        s.db,
        device,
        RunnerCatalog(
            models=[
                {
                    **model,
                    "label": "Native",
                    "local_model_id": "native-model",
                }
            ]
        ),
    )
    s.agent.metadata_json = {
        **s.agent.metadata_json,
        "execution_policy": {"mode": "project_pool"},
        "model_policy": {"mode": "fixed", "model": model},
    }
    s.issue.metadata_json = {
        **s.issue.metadata_json,
        "runner_binding": {"environment_id": str(device.id)},
    }
    s.execution.execution_payload = json.dumps(
        {
            **s.execution.execution_intent,
            "runtime_selection": {
                "runner_routing": {
                    "execution_policy": {"mode": "project_pool"},
                    "model": model,
                },
                "resolved_environment_id": str(device.id),
            },
        }
    )
    s.db.commit()
    result = await execute_comment(s.db, user_id=7, request=answer_request(s))
    queued = s.db.query(LoopItemExecution).order_by(LoopItemExecution.id.desc()).first()
    assert result
    assert queued.id != s.execution.id
    assert queued.assigner_user_id == 9
    assert queued.executor_owner_user_id == 9
    assert queued.runtime_origin_context["comment_user_id"] == 7
    assert queued.runtime_origin_context["human_request_id"] == "business-answer"
    assert (
        queued.runtime_selection["assignment_request"]["continuation"]["execution_id"]
        == s.execution.id
    )
    s.db.refresh(s.issue)
    assert s.issue.metadata_json["human_requests"][0]["status"] == "answering"
    if revoke:
        s.db.query(ResourceMember).filter_by(
            entity_type="project_agent", entity_id=s.agent.id
        ).update({"status": "rejected"})
        s.db.commit()
    loop_item_execution_service.prepare_queued_assignments(s.db)
    s.db.refresh(queued)
    if revoke:
        assert queued.status == "cancelled"
        assert queued.execution_note == "Execution authorization revoked"
    else:
        assert queued.status == "queued"
        assert not queued.assignment_pending
        assert queued.assigner_user_id == 9
        assert queued.executor_owner_user_id == 9
        assert queued.runtime_task_id == "original-session"
        assert queued.runtime_request["newSession"] is False
    s.rpc.assert_not_called()


@pytest.mark.asyncio
async def test_cp15_bound_session_without_original_assigner_cannot_borrow_owner(
    private_answer,
):
    s = private_answer
    s.root.metadata_json = {}
    s.db.delete(s.execution)
    s.db.add(
        LoopItemTaskBinding(
            cloud_project_id=s.project.id,
            loop_item_id=s.issue.id,
            device_id="admin-cloud",
            task_id="original-session",
            task_user_id=9,
            linked_by_user_id=9,
            metadata_json={},
        )
    )
    s.db.commit()
    with pytest.raises(HTTPException) as denied:
        await execute_comment(s.db, user_id=7, request=answer_request(s))
    assert denied.value.status_code == 409
    assert "original execution authority" in denied.value.detail
    s.rpc.assert_not_called()
