"""Explicit children preserve existing assignment, consent and attempt fences."""

import json

import pytest
from fastapi import HTTPException

from app.models.loop_item_execution import LoopItemExecution
from app.schemas.delivery import LoopItemTaskBind
from app.services.async_assistant_requests import terminal_is_current
from app.services.human_assistant_dispatch import (
    current_dispatch,
    execution_current,
    publish_result,
)
from app.services.loop_item_executions.service import loop_item_execution_service
from app.services.loop_items.service import loop_item_service
from tests.services.test_human_assistant_dispatch import (
    _assign,
    _device,
    dispatch_enabled,
    isolate_background_delivery,
)
from tests.services.test_loop_item_assignment import _make_item, _make_project


def child(db, item, owner, request_id="a" * 32):
    root = db.query(LoopItemExecution).filter_by(loop_item_id=item.id).first()
    context = {**root.runtime_origin_context, "assistant_request_id": request_id}
    context["comment_continue_task_id"] = f"assistant-request-{request_id}"
    execution = LoopItemExecution(
        loop_item_id=item.id,
        cloud_project_id=str(item.cloud_project_id),
        executor_owner_user_id=owner.id,
        assigner_user_id=owner.id,
        execution_environment="local",
        execution_device_id=root.execution_device_id,
        runtime_task_id=context["comment_continue_task_id"],
        execution_scope=f"assistant-request:{request_id}",
        status="waiting_runtime",
        max_retries=0,
        execution_payload=json.dumps(
            {
                "runtime_selection": {"executor_kind": "human_assistant"},
                "origin_context": context,
                "assistant_request": {"requestId": request_id, "commands": []},
            }
        ),
    )
    db.add(execution)
    db.commit()
    return execution


def bind(db, item, owner, execution, **overrides):
    values = loop_item_service.response_values(db, item, owner.id)["human_task_binding"]
    fields = {
        **values,
        "deviceId": "assistant-device",
        "taskId": execution.runtime_task_id,
        "standInConversationId": execution.runtime_task_id,
        "humanAssistantDispatchId": current_dispatch(db, item)["dispatchId"],
        "assistantRequestId": execution.runtime_origin_context["assistant_request_id"],
        **overrides,
    }
    return loop_item_service.bind_task(
        db, item.id, LoopItemTaskBind(**fields), owner.id
    )


@pytest.fixture
def assigned(test_db, test_user, dispatch_enabled):
    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)
    _device(test_db, test_user)
    _assign(test_db, project, item, test_user, test_user)
    return item


def test_parallel_children_bind_independently_without_replacing_parent(
    test_db, test_user, assigned
):
    original = current_dispatch(test_db, assigned)
    first = child(test_db, assigned, test_user)
    second = child(test_db, assigned, test_user, "b" * 32)

    binding_a = bind(test_db, assigned, test_user, first)
    binding_b = bind(test_db, assigned, test_user, second)
    repeated = bind(test_db, assigned, test_user, first)

    assert binding_a.id == repeated.id
    assert binding_a.task_id != binding_b.task_id
    assert binding_a.metadata_json["execution_id"] == str(first.id)
    assert binding_b.metadata_json["execution_id"] == str(second.id)
    assert current_dispatch(test_db, assigned)["executionId"] == original["executionId"]
    root = test_db.get(LoopItemExecution, original["executionId"])
    assert root.status == "waiting_runtime"


@pytest.mark.parametrize(
    "field,value", [("taskId", "foreign-task"), ("deviceId", "foreign-device")]
)
def test_child_cannot_bind_a_foreign_task_or_device(
    test_db, test_user, assigned, field, value
):
    execution = child(test_db, assigned, test_user)
    with pytest.raises(HTTPException):
        bind(test_db, assigned, test_user, execution, **{field: value})
    test_db.refresh(execution)
    assert execution.status == "waiting_runtime"


def test_cancelled_child_does_not_revoke_the_parallel_child(
    test_db, test_user, assigned
):
    first = child(test_db, assigned, test_user)
    second = child(test_db, assigned, test_user, "b" * 32)
    bind(test_db, assigned, test_user, first)
    bind(test_db, assigned, test_user, second)
    first.status = "cancel_requested"
    test_db.commit()

    assert not execution_current(test_db, first)
    assert execution_current(test_db, second)


def test_completed_parent_does_not_block_child_or_its_final_summary(
    test_db, test_user, assigned
):
    original = current_dispatch(test_db, assigned)
    root = test_db.get(LoopItemExecution, original["executionId"])
    root.status = "completed"
    test_db.commit()
    execution = child(test_db, assigned, test_user)
    bind(test_db, assigned, test_user, execution)
    execution.status = "completed"
    test_db.commit()

    assert not execution_current(test_db, execution)
    message = publish_result(test_db, execution, "Final result", "completed")
    assert message.content == "Final result"
    assert message.runtime_task_id in {None, ""}


def test_revoking_assignment_cancels_children_after_parent_completed(
    test_db, test_user, assigned
):
    from app.services.human_assistant_dispatch import cancel_assignment_dispatch
    from app.services.issue_assignments import issue_assignment_service

    execution = child(test_db, assigned, test_user)
    bind(test_db, assigned, test_user, execution)
    root = test_db.get(
        LoopItemExecution, current_dispatch(test_db, assigned)["executionId"]
    )
    root.status = "completed"
    test_db.commit()
    event = issue_assignment_service.active(
        test_db,
        issue_id=assigned.id,
        member_type="human",
        member_id=str(test_user.id),
        workflow_step=None,
    )
    cancel_assignment_dispatch(test_db, event)
    test_db.flush()

    assert execution.status == "cancel_requested"
    assert execution.id in test_db.info["human_assistant_cancellations"]


def test_retry_attempt_rejects_previous_attempt_identity(test_db, test_user, assigned):
    previous = child(test_db, assigned, test_user)
    bind(test_db, assigned, test_user, previous)
    previous.status = "failed"
    test_db.commit()
    latest = child(test_db, assigned, test_user)

    assert not execution_current(test_db, previous, allow_terminal=True)
    binding = bind(test_db, assigned, test_user, latest)
    assert binding.metadata_json["execution_id"] == str(latest.id)
    assert binding.task_id == previous.runtime_task_id


@pytest.mark.parametrize("earlier_waiting", [False, True])
def test_accepted_followup_fences_original_completion(
    test_db, test_user, assigned, earlier_waiting
):
    execution = child(test_db, assigned, test_user)
    bind(test_db, assigned, test_user, execution)
    intent = execution.execution_intent
    intent["assistant_request"]["commands"] = [
        {
            "id": "followup-1",
            "action": "followup",
            "executionId": str(execution.id),
            "acknowledged": False,
        }
    ]
    execution.execution_payload = json.dumps(intent)
    test_db.commit()
    earlier = {"assistantRequestCommandId": f"assistant-start:{execution.id}"}
    assert not terminal_is_current(execution, earlier)
    assert terminal_is_current(execution, {"assistantRequestCommandId": "followup-1"})

    for sequence, command, expected in [
        (1, f"assistant-start:{execution.id}", "running"),
        (2, "followup-1", "completed"),
    ]:
        result = loop_item_execution_service.handle_runtime_event(
            test_db,
            device_id="assistant-device",
            runtime_task_id=execution.runtime_task_id,
            event_name="response.completed",
            payload={
                "executionId": str(execution.id),
                "assistantRequestCommandId": command,
                "conversationContext": "private_discussion",
                "eventSeq": sequence,
                "data": (
                    {
                        "silent_exit": True,
                        "silent_exit_reason": "waiting_for_user_input",
                    }
                    if sequence == 1 and earlier_waiting
                    else {"text": "Done"}
                ),
            },
            owner_user_id=test_user.id,
        )
        assert result.status == expected
        if sequence == 1:
            assert result.observed_state == "running"
    assert (
        test_db.query(LoopItemExecution)
        .filter_by(execution_scope=execution.execution_scope)
        .count()
        == 1
    )
