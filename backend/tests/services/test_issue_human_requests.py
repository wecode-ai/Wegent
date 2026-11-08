"""Persistent handoffs use the original Issue and exact reply identity."""

from datetime import UTC, datetime

import pytest
from fastapi import HTTPException

from app.models.delivery import LoopItem
from app.models.project_chat_message import ProjectChatMessage
from app.models.wework_notification import WeworkNotification
from app.services.project_chat.human_requests import (
    claim_reply,
    record_delivery_failure,
    settle_reply,
)
from tests.services.test_project_chat_service import create_project


@pytest.fixture
def handoff(test_db, test_user):
    project = create_project(test_db, test_user)
    question = {
        "id": "question-a",
        "recipient_user_id": test_user.id,
        "root_comment_id": "root-a",
        "runtime_device_id": "device",
        "runtime_task_id": "runtime",
        "status": "pending",
        "version": 1,
    }
    item = LoopItem(
        id="HAND-1",
        cloud_project_id=project.id,
        sequence_number=1,
        title="Decision",
        status="in_progress",
        created_by_user_id=test_user.id,
        metadata_json={
            "human_requests": [question, {**question, "id": "question-b"}],
            "unrelated": {"preserve": True},
        },
    )
    message = ProjectChatMessage(
        message_id="answer-a",
        project_id=project.id,
        task_id=item.id,
        sender_type="user",
        sender_id=str(test_user.id),
        sender_name=test_user.user_name,
        content="Keep scope",
        thread_root_message_id="root-a",
        status="completed",
        metadata_json={},
        created_at=datetime.now(UTC).replace(tzinfo=None),
    )
    test_db.add_all([item, message])
    test_db.commit()
    return project, item, message


def claim(test_db, test_user, handoff, **overrides):
    project, item, message = handoff
    return claim_reply(
        test_db,
        **{
            "project_id": str(project.id),
            "issue_id": item.id,
            "request_id": "question-a",
            "user_id": test_user.id,
            "trigger": message,
            **overrides,
        },
    )


def test_unassigned_issue_response_includes_creator_name(test_db, test_user, handoff):
    from app.services.loop_items.service import loop_item_service

    _, item, _ = handoff
    assert item.assignee_user_id is None
    values = loop_item_service.response_values(test_db, item, test_user.id)
    assert values["created_by_user_id"] == test_user.id
    assert values["created_by_user_name"] == test_user.user_name


def test_answer_queue_and_read_state_do_not_complete_a_handoff(
    test_db, test_user, handoff
):
    _, item, message = handoff
    notice = WeworkNotification(
        id="handoff-notice",
        user_id=test_user.id,
        body="Choose scope",
        payload={"humanRequestId": "question-a"},
        is_read=False,
    )
    test_db.add(notice)
    assert claim(test_db, test_user, handoff)["status"] == "answering"
    test_db.commit()
    test_db.expire_all()
    current = test_db.get(LoopItem, item.id)
    assert current.metadata_json["human_requests"][0]["status"] == "answering"
    assert not test_db.get(WeworkNotification, notice.id).is_read
    assert claim(test_db, test_user, handoff)["answer_message_id"] == message.message_id
    settle_reply(
        test_db,
        issue_id=item.id,
        request_id="question-a",
        message_id=message.message_id,
    )
    test_db.commit()
    test_db.expire_all()
    current = test_db.get(LoopItem, item.id)
    assert [
        request["status"] for request in current.metadata_json["human_requests"]
    ] == ["resolved", "pending"]
    assert current.metadata_json["unrelated"] == {"preserve": True}
    assert [
        event["type"] for event in current.metadata_json["human_requests"][0]["events"]
    ] == ["answered", "accepted"]
    assert test_db.get(WeworkNotification, notice.id).is_read


@pytest.mark.parametrize(
    "change,code",
    [("recipient", 403), ("thread", 409), ("ended", 409), ("cancelled", 409)],
)
def test_answer_revalidates_recipient_thread_and_lifecycle(
    test_db, test_user, handoff, change, code
):
    _, item, message = handoff
    if change == "recipient":
        user_id = test_user.id + 1
    else:
        user_id = test_user.id
    if change == "thread":
        message.thread_root_message_id = "another-root"
    if change == "ended":
        item.status = "completed"
    if change == "cancelled":
        metadata = dict(item.metadata_json)
        metadata["human_requests"] = [
            {**request, "status": "cancelled"} for request in metadata["human_requests"]
        ]
        item.metadata_json = metadata
    test_db.commit()
    with pytest.raises(HTTPException) as failure:
        claim(test_db, test_user, handoff, user_id=user_id)
    assert failure.value.status_code == code


def test_competing_answer_and_wrong_acknowledgment_are_rejected(
    test_db, test_user, handoff
):
    _, item, message = handoff
    claim(test_db, test_user, handoff)
    test_db.commit()
    original_id = message.message_id
    message.message_id = "other-answer"
    with pytest.raises(HTTPException, match="already has an answer"):
        claim(test_db, test_user, handoff)
    message.message_id = original_id
    with pytest.raises(HTTPException, match="identity changed"):
        settle_reply(
            test_db,
            issue_id=item.id,
            request_id="question-a",
            message_id="other-answer",
        )


@pytest.mark.parametrize("rejected", [True, False])
def test_delivery_failure_preserves_question_and_only_rejection_allows_resend(
    test_db, test_user, handoff, rejected
):
    _, item, message = handoff
    claim(test_db, test_user, handoff)
    test_db.commit()
    record_delivery_failure(
        test_db,
        issue_id=item.id,
        request_id="question-a",
        message_id="wrong-answer",
        rejected=rejected,
    )
    assert "delivery_error" not in item.metadata_json["human_requests"][0]
    record_delivery_failure(
        test_db,
        issue_id=item.id,
        request_id="question-a",
        message_id=message.message_id,
        rejected=rejected,
    )
    test_db.commit()
    test_db.expire_all()
    question = test_db.get(LoopItem, item.id).metadata_json["human_requests"][0]
    assert question["status"] == ("pending" if rejected else "answering")
    assert question["delivery_error"] == ("rejected" if rejected else "uncertain")
    assert question["answer_message_id"] == (None if rejected else message.message_id)
    assert (
        test_db.get(LoopItem, item.id).metadata_json["human_requests"][1]["status"]
        == "pending"
    )
    if rejected:
        assert "delivery_error" not in claim(test_db, test_user, handoff)
    settle_reply(
        test_db,
        issue_id=item.id,
        request_id="question-a",
        message_id=message.message_id,
    )
    assert item.metadata_json["human_requests"][0]["status"] == "resolved"
    assert "delivery_error" not in item.metadata_json["human_requests"][0]
