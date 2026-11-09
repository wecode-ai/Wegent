"""Public replies retain message identity and current Issue authority."""

import uuid
from datetime import datetime
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

from app.models.delivery import LoopItem, LoopItemTaskBinding, StandInIssueEvent
from app.models.kind import Kind
from app.models.project_chat_message import ProjectChatMessage
from app.models.wework_notification import WeworkNotification
from app.schemas.delivery import LoopItemTaskBind
from app.schemas.issue_activity_comment import StandInPublicReply
from app.schemas.project_chat import LoopItemAssign, ProjectChatMention, ProjectChatSend
from app.services.collaboration_human_assignments import human_task_bindings
from app.services.loop_item_unread import (
    content_revision,
    initialize_content_revision,
    is_unread,
)
from app.services.loop_items.service import loop_item_service
from app.services.project_chat.service import project_chat_service
from app.services.project_chat.stand_in_replies import publish_stand_in_reply
from tests.mcp_server.test_wework_space import _project


@pytest.fixture
def scope(test_db, test_user, monkeypatch):
    monkeypatch.setattr("app.core.async_utils.schedule_async_task", MagicMock())
    project = _project(test_db, test_user, provider="local")
    issue = LoopItem(
        id=f"{project.project_key}-1",
        cloud_project_id=project.id,
        title="Shared stand-in room",
        created_by_user_id=test_user.id,
        status="pending",
        priority="none",
    )
    device = Kind(
        kind="Device",
        name=f"stand-in-{uuid.uuid4().hex}",
        namespace="default",
        user_id=test_user.id,
        is_active=True,
        json={"spec": {"deviceType": "local"}},
    )
    test_db.add_all([issue, device])
    test_db.flush()
    binding = LoopItemTaskBinding(
        cloud_project_id=project.id,
        loop_item_id=issue.id,
        task_user_id=test_user.id,
        device_id=device.name,
        task_id="issue-conversation",
        linked_by_user_id=test_user.id,
    )
    test_db.add(binding)
    test_db.commit()
    trigger = project_chat_service.send(
        test_db,
        user_id=test_user.id,
        user_name=test_user.user_name,
        request=ProjectChatSend(
            client_message_id="mention",
            project_id=str(project.id),
            task_id=issue.id,
            content="Please investigate",
            mentions=[
                ProjectChatMention(type="user", id=str(test_user.id), label="Owner")
            ],
        ),
    ).message
    identity = StandInPublicReply(
        device_id=device.name,
        task_id=binding.task_id,
        role_id="review",
        role_name="Review stand-in",
        message_id="first",
        trigger_comment_id=trigger.message_id,
    )
    return project, issue, binding, device, identity


def publish(db, user, scope, identity=None, text="Received"):
    project, issue, _, _, default = scope
    return publish_stand_in_reply(
        db,
        user_id=user.id,
        project_id=str(project.id),
        item_id=issue.id,
        body=text,
        identity=identity or default,
    )


def test_public_messages_are_separate_and_redelivery_is_idempotent(
    test_db, test_user, scope
):
    first = publish(test_db, test_user, scope)
    assert publish(test_db, test_user, scope).message_id == first.message_id
    identity = scope[-1].model_copy(update={"message_id": "result"})
    result = publish(test_db, test_user, scope, identity, "Verified result")
    assert first.message_id != result.message_id
    assert first.sender["type"] == "agent"
    assert first.sender["name"] == "Review stand-in"
    assert (
        first.runtime_address is None
    ), "Publication must not expose a private transcript"
    assert first.metadata["execution_dispatch"] == "comment_only"
    assert result.sequence_number > first.sequence_number
    assert test_db.query(ProjectChatMessage).filter_by(sender_type="agent").count() == 2
    with pytest.raises(HTTPException) as error:
        publish(test_db, test_user, scope, text="Changed content")
    assert error.value.status_code == 409


def test_public_reply_advances_issue_unread_once_without_marking_its_owner_read(
    test_db, test_user, scope
):
    issue = scope[1]
    issue.metadata_json = initialize_content_revision(issue.metadata_json, test_user.id)
    test_db.commit()
    assert not is_unread(issue.metadata_json, test_user.id)
    before = content_revision(issue.metadata_json)
    first = publish(test_db, test_user, scope)
    test_db.refresh(issue)
    assert content_revision(issue.metadata_json) == before + 1
    assert is_unread(issue.metadata_json, test_user.id)
    version = issue.version
    assert publish(test_db, test_user, scope).message_id == first.message_id
    test_db.refresh(issue)
    assert content_revision(issue.metadata_json) == before + 1
    assert issue.version == version


@pytest.mark.parametrize(
    "field,value",
    [
        ("device_id", "foreign"),
        ("task_id", "foreign"),
        ("trigger_comment_id", "foreign"),
    ],
)
def test_publication_rejects_foreign_or_missing_source_identity(
    test_db, test_user, scope, field, value
):
    with pytest.raises(HTTPException) as error:
        publish(test_db, test_user, scope, scope[-1].model_copy(update={field: value}))
    assert error.value.status_code == 409
    assert test_db.query(ProjectChatMessage).filter_by(sender_type="agent").count() == 0


def test_assignment_revalidation_is_independent_of_persistent_conversation(
    test_db, test_user, scope
):
    project, issue, _, _, identity = scope
    assigned = loop_item_service.assign(
        test_db,
        project_id=project.id,
        item_id=issue.id,
        user_id=test_user.id,
        values=LoopItemAssign(
            version=issue.version, assignee_type="user", assignee_id=str(test_user.id)
        ),
    )
    current = human_task_bindings(
        test_db, [assigned], test_user.id, projects=[project]
    )[issue.id]
    identity = identity.model_copy(
        update={
            "human_assignment_id": current["humanAssignmentId"],
            "trigger_comment_id": None,
        }
    )
    publish(test_db, test_user, scope, identity)
    with pytest.raises(HTTPException) as error:
        publish(
            test_db,
            test_user,
            scope,
            identity.model_copy(
                update={"message_id": "late", "human_assignment_id": "superseded"}
            ),
        )
    assert error.value.status_code == 409
    assert test_db.query(ProjectChatMessage).filter_by(sender_type="agent").count() == 1


def test_revoked_device_binding_cannot_publish(test_db, test_user, scope):
    scope[3].is_active = False
    test_db.commit()
    with pytest.raises(HTTPException) as error:
        publish(test_db, test_user, scope)
    assert error.value.status_code == 409


def test_deleted_mention_cannot_authorize_a_late_public_reply(
    test_db, test_user, scope
):
    trigger = (
        test_db.query(ProjectChatMessage)
        .filter_by(message_id=scope[-1].trigger_comment_id)
        .one()
    )
    trigger.deleted_at = datetime.now()
    test_db.commit()
    with pytest.raises(HTTPException) as error:
        publish(test_db, test_user, scope)
    assert error.value.status_code == 409
    assert test_db.query(ProjectChatMessage).filter_by(sender_type="agent").count() == 0


def test_exact_message_lookup_is_independent_of_history_page_limit(
    test_db, test_user, scope
):
    from app.services.project_chat.issue_comments import list_issue_comments

    project, issue, _, _, _ = scope
    public = publish(test_db, test_user, scope)
    rows = list_issue_comments(
        test_db,
        user_id=test_user.id,
        project_id=str(project.id),
        item_id=issue.id,
        limit=1,
        message_id=public.message_id,
    )
    assert [row["id"] for row in rows] == [public.message_id]
    assert rows[0]["body"] == "Received"


def test_self_mention_has_a_durable_wakeup_but_no_human_reminder(
    test_db, test_user, scope
):
    events = test_db.query(StandInIssueEvent).filter_by(user_id=test_user.id).all()
    assert len(events) == 1
    assert events[0].metadata_json["commentId"] == scope[-1].trigger_comment_id
    assert (
        test_db.query(WeworkNotification).filter_by(user_id=test_user.id).count() == 0
    )


def test_issue_conversation_reservation_is_device_independent_and_idempotent(
    test_db, test_user, scope
):
    _, issue, binding, first_device, _ = scope
    second_device = Kind(
        kind="Device",
        name="second-stand-in-device",
        namespace="default",
        user_id=test_user.id,
        is_active=True,
        json={"spec": {"deviceType": "local"}},
    )
    test_db.add(second_device)
    test_db.commit()
    values = LoopItemTaskBind(
        device_id=first_device.name,
        task_id=binding.task_id,
        stand_in_conversation_id="review-issue-identity",
    )
    original = loop_item_service.bind_task(test_db, issue.id, values, test_user.id)
    assert (
        loop_item_service.bind_task(test_db, issue.id, values, test_user.id).id
        == original.id
    )
    for update in [{"device_id": second_device.name}, {"task_id": "different-task"}]:
        with pytest.raises(HTTPException) as error:
            loop_item_service.bind_task(
                test_db, issue.id, values.model_copy(update=update), test_user.id
            )
        assert error.value.status_code == 409
        test_db.rollback()
    assert (
        test_db.query(LoopItemTaskBinding).filter_by(loop_item_id=issue.id).count() == 1
    )


def test_issue_conversation_reservation_rejects_a_foreign_device(
    test_db, test_user, scope
):
    values = LoopItemTaskBind(
        device_id="foreign",
        task_id="new-task",
        stand_in_conversation_id="review-issue-identity",
    )
    with pytest.raises(HTTPException) as error:
        loop_item_service.bind_task(test_db, scope[1].id, values, test_user.id)
    assert error.value.status_code == 403


@pytest.mark.asyncio
async def test_reply_to_public_stand_in_message_continues_without_an_explicit_mention(
    test_db, test_user, scope
):
    from app.schemas.project_chat import ProjectChatCommentExecution
    from app.services.project_chat.comment_execution import execute_comment

    public = publish(test_db, test_user, scope)
    project, issue, _, _, _ = scope
    reply = project_chat_service.send(
        test_db,
        user_id=test_user.id,
        user_name=test_user.user_name,
        request=ProjectChatSend(
            client_message_id="reply",
            project_id=str(project.id),
            task_id=issue.id,
            content="Please explain the result",
            reply_to_message_id=public.message_id,
        ),
    ).message
    assert reply.metadata["stand_in_reply_to"]["role_id"] == "review"
    assert reply.metadata["execution_dispatch"] == "comment_only"
    assert (
        await execute_comment(
            test_db,
            user_id=test_user.id,
            request=ProjectChatCommentExecution(
                project_id=str(project.id),
                task_id=issue.id,
                trigger_message_id=reply.message_id,
            ),
        )
        == []
    )
    events = (
        test_db.query(StandInIssueEvent)
        .filter_by(user_id=test_user.id)
        .order_by(StandInIssueEvent.sort_order)
        .all()
    )
    assert len(events) == 2
    assert events[1].metadata_json["commentId"] == reply.message_id
    assert events[1].sort_order > events[0].sort_order
    assert (
        test_db.query(WeworkNotification).filter_by(user_id=test_user.id).count() == 0
    )
