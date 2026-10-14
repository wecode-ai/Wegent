"""Runtime events belong to a turn, even when replies share one native session."""

from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from app.api.ws.device_namespace import _project_chat_runtime_event_sync
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.services.loop_item_executions.service import loop_item_execution_service
from app.services.project_chat.comment_execution import execute_comment
from tests.services.test_project_comment_execution import comment, scenario
from tests.services.test_project_group_comment_execution import (
    group_scenario,
    member_scenario,
)


@pytest.mark.asyncio
@pytest.mark.parametrize("accepted", [False, True])
async def test_original_member_events_do_not_start_or_complete_pending_replies(
    member_scenario, monkeypatch, accepted
):
    s = member_scenario
    s.root.status = "streaming"
    s.db.commit()
    responses = []
    for text in ("Check memory", "Check CPU again"):
        responses.extend(
            await execute_comment(
                s.db, user_id=s.member.id, request=comment(s, text=text)
            )
        )
    replies = [
        s.db.query(ProjectChatMessage).filter_by(message_id=response.message_id).one()
        for response in responses
    ]
    executions = [
        s.db.get(LoopItemExecution, response.metadata["execution_id"])
        for response in responses
    ]
    if accepted:
        first = loop_item_execution_service.claim_next_for_device(
            s.db,
            execution_device_id="admin-cloud",
            owner_user_id=s.owner.id,
            environment="cloud",
            runtime_instance_id="runner",
        )
        loop_item_execution_service.confirm_runtime_accepted(
            s.db,
            execution_id=first.id,
            runtime_device_id=first.runtime_device_id,
            runtime_task_id=first.runtime_task_id,
        )

    @contextmanager
    def same_session():
        yield s.db

    monkeypatch.setattr("app.api.ws.device_namespace.get_db_session", same_session)
    for sequence, event_name in enumerate(
        ("response.output_text.delta", "response.completed"), start=1
    ):
        _project_chat_runtime_event_sync(
            "admin-native",
            {
                "event": event_name,
                "payload": {
                    "taskId": s.root.runtime_task_id,
                    "subtaskId": "original-member-turn",
                    "eventSeq": sequence,
                    "data": {"delta": "Original evidence", "text": "Original result"},
                },
            },
            user_id=s.owner.id,
        )

    s.db.expire_all()
    assert s.root.status == "completed"
    assert s.root.content == "Original result"
    assert all(reply.status == "pending" and reply.content == "" for reply in replies)
    assert executions[0].status == ("claimed" if accepted else "queued")
    assert executions[1].status == "queued"


@pytest.mark.asyncio
async def test_three_replies_start_and_finish_in_order_on_the_original_session(
    member_scenario, monkeypatch
):
    s = member_scenario
    responses = []
    for text in ("Check memory", "Check CPU", "Check disks"):
        responses.extend(
            await execute_comment(
                s.db, user_id=s.member.id, request=comment(s, text=text)
            )
        )
    replies = [
        s.db.query(ProjectChatMessage).filter_by(message_id=r.message_id).one()
        for r in responses
    ]
    executions = [
        s.db.get(LoopItemExecution, r.metadata["execution_id"]) for r in responses
    ]
    monkeypatch.setattr(
        loop_item_execution_service,
        "_runtime_profile_and_context",
        lambda *_args, **_kwargs: pytest.fail(
            "A reply must not compile the current agent"
        ),
    )

    @contextmanager
    def same_session():
        yield s.db

    monkeypatch.setattr("app.api.ws.device_namespace.get_db_session", same_session)
    for index, (reply, execution) in enumerate(zip(replies, executions)):
        claimed = loop_item_execution_service.claim_next_for_device(
            s.db,
            execution_device_id="admin-cloud",
            owner_user_id=s.owner.id,
            environment="cloud",
            runtime_instance_id="runner",
        )
        assert claimed.id == execution.id
        loop_item_execution_service.accept_runtime_and_open_activity(
            s.db,
            execution_id=claimed.id,
            runtime_device_id=claimed.runtime_device_id,
            runtime_task_id=claimed.runtime_task_id,
            prompt="",
        )
        for status in ("running", "completed"):
            loop_item_execution_service.reconcile_runtime_snapshot(
                s.db,
                execution_id=claimed.id,
                runtime_status=status,
                running=status == "running",
            )
            assert claimed.status == "claimed"
            assert reply.status == "pending"
        for sequence, event_name in enumerate(
            ("response.created", "response.output_text.delta", "response.completed"), 1
        ):
            _project_chat_runtime_event_sync(
                "admin-native",
                {
                    "event": event_name,
                    "payload": {
                        "taskId": s.root.runtime_task_id,
                        "clientUserMessageId": reply.trigger_message_id,
                        "subtaskId": f"reply-turn-{index}",
                        "eventSeq": sequence,
                        "data": {"delta": f"delta-{index}", "text": f"result-{index}"},
                    },
                },
                user_id=s.owner.id,
            )
        s.db.expire_all()
        assert execution.status == "completed"
        assert reply.status == "completed"
        assert reply.content == f"result-{index}"
        assert reply.metadata_json["runtime_turn_id"] == f"reply-turn-{index}"
        assert execution.runtime_task_id == s.root.runtime_task_id
        assert (
            execution.runtime_origin_context["assignment_id"]
            == s.root.metadata_json["assignment_id"]
        )
        assert all(
            r.status == "pending" and e.status == "queued"
            for r, e in zip(replies[index + 1 :], executions[index + 1 :])
        )


@pytest.mark.asyncio
async def test_unverified_initial_member_does_not_bind_an_incoming_turn(
    member_scenario,
):
    from app.services.project_chat.service import project_chat_service

    s = member_scenario
    s.root.status = "streaming"
    s.root.metadata_json = {
        **s.root.metadata_json,
        "assignment_id": "forged-assignment",
    }
    s.db.commit()
    assert (
        project_chat_service.project_runtime_event(
            s.db,
            device_id="admin-native",
            runtime_task_id=s.root.runtime_task_id,
            event_name="response.created",
            payload={"subtaskId": "forged-turn"},
            owner_user_id=s.owner.id,
        )
        is None
    )
    assert "runtime_turn_id" not in s.root.metadata_json


@pytest.mark.asyncio
@pytest.mark.parametrize("result", [{}, {"accepted": True, "taskId": "another-task"}])
async def test_direct_reply_requires_acceptance_for_the_original_task(scenario, result):
    s = scenario
    s.rpc.return_value = result
    with pytest.raises(HTTPException) as error:
        await execute_comment(s.db, user_id=s.member.id, request=comment(s))
    assert error.value.status_code == 502


@pytest.mark.asyncio
async def test_reply_to_a_finished_followup_starts_with_a_fresh_turn(member_scenario):
    import json

    s = member_scenario
    first = (await execute_comment(s.db, user_id=s.member.id, request=comment(s)))[0]
    reply = s.db.query(ProjectChatMessage).filter_by(message_id=first.message_id).one()
    execution = s.db.get(LoopItemExecution, first.metadata["execution_id"])
    execution.status = "completed"
    execution.execution_payload = json.dumps(
        {
            **execution.execution_intent,
            "origin_context": {
                **execution.runtime_origin_context,
                "runtime_turn_id": "previous-turn",
            },
        }
    )
    reply.status = "completed"
    reply.metadata_json = {**reply.metadata_json, "runtime_turn_id": "previous-turn"}
    s.db.commit()
    next_response = (
        await execute_comment(
            s.db, user_id=s.member.id, request=comment(s, text="One more check")
        )
    )[0]
    next_execution = s.db.get(LoopItemExecution, next_response.metadata["execution_id"])
    assert "runtime_turn_id" not in next_execution.runtime_origin_context
    assert next_execution.runtime_task_id == execution.runtime_task_id
    assert (
        next_execution.runtime_origin_context["dispatch_id"]
        == execution.runtime_origin_context["dispatch_id"]
    )


@pytest.mark.asyncio
async def test_missing_session_completes_a_requested_followup_cancellation(
    member_scenario,
):
    s = member_scenario
    response = (await execute_comment(s.db, user_id=s.member.id, request=comment(s)))[0]
    claimed = loop_item_execution_service.claim_next_for_device(
        s.db,
        execution_device_id="admin-cloud",
        owner_user_id=s.owner.id,
        environment="cloud",
        runtime_instance_id="runner",
    )
    loop_item_execution_service.confirm_runtime_accepted(
        s.db,
        execution_id=claimed.id,
        runtime_device_id=claimed.runtime_device_id,
        runtime_task_id=claimed.runtime_task_id,
    )
    loop_item_execution_service.cancel(s.db, execution_id=claimed.id)
    assert claimed.status == "cancel_requested"
    recovered = loop_item_execution_service.reconcile_runtime_snapshot(
        s.db, execution_id=claimed.id, runtime_status="missing", running=False
    )
    assert recovered.status == "cancelled"
    reply = (
        s.db.query(ProjectChatMessage).filter_by(message_id=response.message_id).one()
    )
    assert reply.status == "cancelled"


@pytest.mark.asyncio
@pytest.mark.parametrize("matching_turn", [False, True])
async def test_device_reconciliation_requires_the_reply_trigger_in_history(
    member_scenario, monkeypatch, matching_turn
):
    from app.tasks.robot_queue_tasks import reconcile_device_executions

    s = member_scenario
    response = (await execute_comment(s.db, user_id=s.member.id, request=comment(s)))[0]
    reply = (
        s.db.query(ProjectChatMessage).filter_by(message_id=response.message_id).one()
    )
    claimed = loop_item_execution_service.claim_next_for_device(
        s.db,
        execution_device_id="admin-cloud",
        owner_user_id=s.owner.id,
        environment="cloud",
        runtime_instance_id="runner",
    )
    loop_item_execution_service.accept_runtime_and_open_activity(
        s.db,
        execution_id=claimed.id,
        runtime_device_id=claimed.runtime_device_id,
        runtime_task_id=claimed.runtime_task_id,
        prompt="",
    )
    monkeypatch.setattr(
        loop_item_execution_service,
        "_runtime_profile_and_context",
        lambda *_args, **_kwargs: pytest.fail(
            "Recovery must not compile the current agent"
        ),
    )

    @contextmanager
    def same_session():
        yield s.db

    monkeypatch.setattr("app.db.session.get_db_session", same_session)
    monkeypatch.setattr(
        "app.tasks.robot_queue_tasks.device_service.get_device_online_info",
        AsyncMock(return_value={"socket_id": "socket"}),
    )
    call = AsyncMock(
        side_effect=[
            {
                "success": True,
                "workspaces": [
                    {
                        "tasks": [
                            {
                                "taskId": s.root.runtime_task_id,
                                "status": "completed",
                                "running": False,
                            }
                        ]
                    }
                ],
            },
            {
                "success": True,
                "taskId": s.root.runtime_task_id,
                "turns": [
                    {
                        "id": "recovered-turn",
                        "status": "done",
                        "items": [
                            {
                                "type": "user_message",
                                "id": "provider-item-id",
                                "message": {
                                    "role": "user",
                                    "id": "provider-message-id",
                                    "clientUserMessageId": (
                                        reply.trigger_message_id
                                        if matching_turn
                                        else "original-trigger"
                                    ),
                                },
                            }
                        ],
                    }
                ],
            },
        ]
    )
    monkeypatch.setattr("app.core.socketio.get_sio", lambda: SimpleNamespace(call=call))
    count = await reconcile_device_executions(
        user_id=s.owner.id, device_id="admin-native"
    )
    s.db.expire_all()
    assert count == int(matching_turn)
    assert claimed.status == ("completed" if matching_turn else "claimed")
    assert reply.status == ("completed" if matching_turn else "pending")
    assert call.await_args_list[1].args[1]["method"] == "runtime.tasks.transcript"
