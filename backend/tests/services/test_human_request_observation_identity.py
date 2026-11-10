"""A Runtime observation must prove which human answer it accepted."""

import json
from copy import deepcopy
from datetime import UTC, datetime
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import insert, select

from app.models.delivery import LoopItem
from app.models.project_chat_message import ProjectChatMessage
from app.models.wework_notification import WeworkNotification
from app.services.loop_item_executions.service import loop_item_execution_service
from app.services.project_chat.human_requests import settle_reply
from tests.services.test_issue_human_requests import claim, handoff
from tests.services.test_loop_item_executions import _make_bot, _make_execution


@pytest.fixture(autouse=True)
def isolated_notification_delivery(monkeypatch):
    monkeypatch.setattr(
        "app.services.wework_notifications.deliver_notification", AsyncMock()
    )


def test_settlement_acknowledges_only_recipient_and_responsible_inboxes(
    test_db, test_user, handoff
):
    _, item, message = handoff
    metadata = deepcopy(item.metadata_json)
    metadata["human_requests"][0]["responsible_user_id"] = test_user.id + 1
    item.metadata_json = metadata
    test_db.flush()
    for offset in range(3):
        test_db.add(
            WeworkNotification(
                id=f"scope-{offset}",
                user_id=test_user.id + offset,
                body="Choose scope",
                payload={"humanRequestId": "question-a"},
                is_read=False,
            )
        )
    claim(test_db, test_user, handoff)

    settle_reply(
        test_db,
        issue_id=item.id,
        request_id="question-a",
        message_id=message.message_id,
    )
    test_db.commit()
    test_db.expire_all()

    assert test_db.get(WeworkNotification, "scope-0").is_read
    assert test_db.get(WeworkNotification, "scope-1").is_read
    assert not test_db.get(WeworkNotification, "scope-2").is_read


@pytest.fixture
def claimed_answer_execution(test_db, test_user, handoff):
    project, item, message = handoff
    bot = _make_bot(test_db, project, test_user)
    execution = _make_execution(test_db, item, bot, test_user)
    execution.execution_payload = json.dumps(
        {
            **execution.execution_intent,
            "origin_context": {
                **execution.runtime_origin_context,
                "human_request_id": "question-a",
                "comment_trigger_message_id": message.message_id,
            },
        }
    )
    test_db.commit()
    claimed = loop_item_execution_service.claim(
        test_db,
        agent_id=bot.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-identity-test",
    )
    assert claimed is not None
    claim(test_db, test_user, handoff)
    test_db.commit()
    return claimed


@pytest.mark.parametrize("old_message_id", [None, "previous-turn-message"])
def test_old_observation_cannot_settle_new_answer(
    test_db, test_user, handoff, claimed_answer_execution, old_message_id
):
    project, item, message = handoff
    claimed = claimed_answer_execution
    table = LoopItem.__table__
    test_db.execute(
        insert(table).values(
            id="answer-question-index",
            resource_type="human_request_index",
            cloud_project_id=project.id,
            parent_id=item.id,
            name="question-a",
            description="",
        )
    )
    notice = WeworkNotification(
        id="new-answer-notice",
        user_id=test_user.id,
        body="Choose scope",
        payload={"humanRequestId": "question-a"},
        is_read=False,
    )
    test_db.add(notice)
    test_db.commit()

    for sequence, client_message_id in [(1, old_message_id), (2, message.message_id)]:
        observed = loop_item_execution_service.handle_runtime_event(
            test_db,
            device_id=claimed.runtime_device_id,
            runtime_task_id=claimed.runtime_task_id,
            event_name="response.output_text.delta",
            payload={
                "eventSeq": sequence,
                "subtaskId": "old-turn" if sequence == 1 else "new-turn",
                "clientUserMessageId": client_message_id,
                "data": {"delta": "Accepted observation"},
            },
            owner_user_id=test_user.id,
        )
        assert observed is not None
        test_db.expire_all()
        question = test_db.get(LoopItem, item.id).metadata_json["human_requests"][0]
        assert question["status"] == ("answering" if sequence == 1 else "resolved")
        assert test_db.get(WeworkNotification, notice.id).is_read is (sequence == 2)
        index = test_db.execute(
            select(table.c.id).where(table.c.id == "answer-question-index")
        ).scalar_one_or_none()
        assert index == ("answer-question-index" if sequence == 1 else None)


@pytest.mark.parametrize("ack_sequence", [1, 3])
@pytest.mark.parametrize(
    "identity",
    [
        "exact",
        "other-message",
        "other-turn",
        "other-owner",
        "other-execution",
        "unfinished",
    ],
)
def test_late_answer_acknowledgement_preserves_terminal_execution(
    test_db, test_user, handoff, claimed_answer_execution, ack_sequence, identity
):
    project, item, message = handoff
    execution = claimed_answer_execution
    # Completion was already elected using the native turn, before the exact
    # input acknowledgement arrived. Keep the earlier lifecycle transition out
    # of this regression's database precondition.
    test_db.add(
        ProjectChatMessage(
            message_id="late-ack-result",
            project_id=project.id,
            task_id=item.id,
            sender_type="agent",
            sender_id=execution.agent_id,
            sender_name="Test agent",
            content="Finished reply",
            status="running" if identity == "unfinished" else "completed",
            runtime_device_id=execution.runtime_device_id,
            runtime_task_id=execution.runtime_task_id,
            trigger_message_id=message.message_id,
            metadata_json={
                "execution_id": -1 if identity == "other-execution" else execution.id,
                "runtime_turn_id": "accepted-turn",
                "runtime_completed_at": datetime.now(UTC).isoformat(),
            },
        )
    )
    execution.status = "completed"
    execution.last_event_seq = 2
    test_db.commit()
    test_db.refresh(execution)
    assert execution.status == "completed"
    version, sequence = execution.version, execution.last_event_seq

    observed = loop_item_execution_service.handle_runtime_event(
        test_db,
        device_id=execution.runtime_device_id,
        runtime_task_id=execution.runtime_task_id,
        event_name="response.created",
        payload={
            "eventSeq": ack_sequence,
            "subtaskId": "other-turn" if identity == "other-turn" else "accepted-turn",
            "clientUserMessageId": (
                "previous-turn-message"
                if identity == "other-message"
                else message.message_id
            ),
        },
        owner_user_id=test_user.id + (1 if identity == "other-owner" else 0),
    )
    assert observed is None, "Late acceptance must not reopen a completed execution"
    test_db.expire_all()
    question = test_db.get(LoopItem, item.id).metadata_json["human_requests"][0]
    assert question["status"] == ("resolved" if identity == "exact" else "answering")
    assert question["answer_message_id"] == message.message_id
    assert execution.status == "completed"
    assert (execution.version, execution.last_event_seq) == (version, sequence)
