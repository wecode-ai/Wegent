"""Subscribed group readers receive messages without inviting the whole roster."""

import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.models.delivery import LoopItemComment, StandInIssueEvent, ThreadParticipant
from app.models.resource_member import ResourceMember
from app.models.wework_notification import WeworkNotification
from app.schemas.project_chat import ProjectChatSend
from app.services.project_chat.service import project_chat_service
from app.services.thread_notifications import thread_notification_recipients
from app.services.thread_participation import join_thread, participant_id
from tests.services.test_thread_participation import make_group, make_thread, person


@pytest.fixture(autouse=True)
def no_external_delivery(monkeypatch):
    monkeypatch.setattr("app.core.async_utils.schedule_async_task", MagicMock())
    monkeypatch.setattr(
        "app.services.project_chat.push.push_project_chat_message", MagicMock()
    )


@pytest.mark.parametrize(
    "kind", ["assignment", "execution", "issue_dispatch_assignment"]
)
def test_shared_notification_target_keeps_group_provenance_after_deletion(
    test_db, test_user, kind
):
    from datetime import datetime

    from app.services.notification_target import board_notification_target
    from app.services.thread_notifications import group_notification_readable
    from app.services.wework_notifications import create_notification

    group = make_group(test_db, test_user, [])
    thread = make_thread(test_db, group, test_user)
    target = board_notification_target(test_db, group, thread)
    notification = create_notification(
        test_db,
        user_id=test_user.id,
        actor_user_id=test_user.id,
        title="Thread update",
        body="Changed",
        kind=kind,
        project_id=str(group.id),
        item_id=thread.id,
        payload=target.payload(),
    )
    assert notification.payload["groupId"] == str(group.id)
    assert notification.url == f"wework://groups/backend/{group.id}/threads/{thread.id}"
    assert group_notification_readable(test_db, test_user.id, notification.payload)
    group.deleted_at = datetime(2026, 11, 11)
    test_db.flush()
    assert not group_notification_readable(test_db, test_user.id, notification.payload)


@pytest.mark.parametrize("mentioned", [False, True])
@pytest.mark.parametrize(
    "state", ["joined", "observer", "muted", "left", "removed", "inactive"]
)
def test_thread_message_follows_current_subscription(
    test_db, test_user, mentioned, state
):
    reader = person(test_db, "reader")
    group = make_group(test_db, test_user, [(reader, "Developer")])
    thread = make_thread(test_db, group, test_user)
    if state != "observer":
        join_thread(test_db, thread, reader.id)
        test_db.flush()
    participant = test_db.get(ThreadParticipant, participant_id(thread.id, reader.id))
    if state == "muted":
        participant.metadata_json = {"notifications": "muted"}
    elif state == "left":
        participant.status = "left"
    elif state == "removed":
        test_db.query(ResourceMember).filter_by(
            resource_type="CollaborationChatGroup",
            resource_id=int(group.id),
            entity_id=str(reader.id),
        ).delete()
    elif state == "inactive":
        reader.is_active = False
    test_db.flush()
    # Removed and inactive users cannot be mentioned; use a plain message there.
    mentions = (
        [{"type": "user", "id": str(reader.id), "label": reader.user_name}]
        if mentioned and state not in {"removed", "inactive"}
        else []
    )
    result = project_chat_service.send(
        test_db,
        user_id=test_user.id,
        user_name=test_user.user_name,
        request=ProjectChatSend(
            project_id=group.id,
            task_id=thread.id,
            content="A new discussion message",
            client_message_id="notification-test",
            mentions=mentions,
        ),
    )
    rows = test_db.query(WeworkNotification).all()
    if state == "joined":
        assert len(rows) == 1
        assert rows[0].user_id == reader.id
        assert rows[0].kind == ("mention" if mentioned else "thread_message")
        assert rows[0].payload["commentId"] == result.message.message_id
        assert rows[0].payload["itemId"] == thread.id
    else:
        assert rows == []
    if mentioned and state in {"observer", "left"}:
        assert test_db.query(StandInIssueEvent).count() == 0
    if mentioned and state in {"joined", "muted"}:
        assert test_db.query(StandInIssueEvent).count() == 1


def test_completed_thread_keeps_subscription_and_rejoin_preserves_mute(
    test_db, test_user
):
    reader = person(test_db, "reader")
    group = make_group(test_db, test_user, [(reader, "Viewer")])
    thread = make_thread(test_db, group, test_user)
    join_thread(test_db, thread, reader.id)
    thread.status = "completed"
    test_db.flush()
    assert reader.id in thread_notification_recipients(test_db, thread)
    participant = test_db.get(ThreadParticipant, participant_id(thread.id, reader.id))
    participant.status = "left"
    participant.metadata_json = {"notifications": "muted"}
    test_db.flush()
    join_thread(test_db, thread, reader.id)
    test_db.flush()
    assert reader.id not in thread_notification_recipients(test_db, thread)
    assert participant.metadata_json == {"notifications": "muted"}


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["muted", "left", "removed"])
async def test_delayed_delivery_rechecks_subscription_before_transport(
    test_db, test_user, monkeypatch, change
):
    from app.services.wework_notifications import _deliver_notification_payload

    reader = person(test_db, "reader")
    group = make_group(test_db, test_user, [(reader, "Developer")])
    thread = make_thread(test_db, group, test_user, reader)
    project_chat_service.send(
        test_db,
        user_id=test_user.id,
        user_name=test_user.user_name,
        request=ProjectChatSend(
            project_id=group.id,
            task_id=thread.id,
            client_message_id="delayed",
            content="Before change",
        ),
    )
    notification = test_db.query(WeworkNotification).one()
    participant = test_db.get(ThreadParticipant, participant_id(thread.id, reader.id))
    if change == "muted":
        participant.metadata_json = {"notifications": "muted"}
    elif change == "left":
        participant.status = "left"
    else:
        test_db.query(ResourceMember).filter_by(
            resource_type="CollaborationChatGroup",
            resource_id=int(group.id),
            entity_id=str(reader.id),
        ).delete()
    test_db.commit()
    sio = AsyncMock()
    im_sessions = AsyncMock()
    monkeypatch.setattr("app.core.socketio.get_sio", lambda: sio)
    monkeypatch.setattr(
        "app.services.im.session_service.im_session_service.list_user_sessions",
        im_sessions,
    )
    await _deliver_notification_payload(
        test_db,
        {
            "id": notification.id,
            "user_id": reader.id,
            "kind": notification.kind,
            "payload": notification.payload,
            "title": notification.title,
            "body": notification.body,
        },
        {"in_app": True, "system": True, "im": True},
        emit_inbox=True,
    )
    sio.emit.assert_not_awaited()
    im_sessions.assert_not_awaited()


def test_public_comment_notifies_subscriber_in_owning_group(test_db, test_user):
    from app.services.loop_items.service import loop_item_service

    reader = person(test_db, "reader")
    group = make_group(test_db, test_user, [(reader, "Viewer")])
    thread = make_thread(test_db, group, test_user)
    join_thread(test_db, thread, reader.id)
    test_db.flush()
    comment = loop_item_service.add_comment(
        test_db, thread.id, test_user.id, "A public comment"
    )
    row = test_db.query(WeworkNotification).one()
    assert row.user_id == reader.id
    assert row.body == "A public comment"
    assert row.payload["commentId"] == str(comment["id"])
    assert row.payload["groupId"] == str(group.id)
    assert row.url.startswith(
        f"wework://groups/backend/{group.id}/threads/{thread.id}/comments/"
    )
    assert test_db.query(LoopItemComment).filter_by(loop_item_id=thread.id).count() == 0
    assert (
        loop_item_service.list_comments(test_db, thread.id, reader.id)[0]["id"]
        == comment["id"]
    )
    from app.schemas.project_chat import ProjectChatSubscribe

    history = project_chat_service.subscribe(
        test_db,
        user_id=reader.id,
        request=ProjectChatSubscribe(project_id=group.id, task_id=thread.id),
    )
    assert [(message.message_id, message.content) for message in history] == [
        (comment["id"], "A public comment")
    ]


def test_duplicate_chat_send_does_not_duplicate_notifications(test_db, test_user):
    reader = person(test_db, "reader")
    group = make_group(test_db, test_user, [(reader, "Developer")])
    thread = make_thread(test_db, group, test_user, reader)
    request = ProjectChatSend(
        project_id=group.id,
        task_id=thread.id,
        content="Only once",
        client_message_id="deduplicate",
    )
    for _ in range(2):
        project_chat_service.send(
            test_db,
            user_id=test_user.id,
            user_name=test_user.user_name,
            request=request,
        )
    assert test_db.query(WeworkNotification).count() == 1


def test_notification_read_endpoint_denies_removed_group_member(
    test_db, test_user, test_client, test_token
):
    owner = person(test_db, "owner")
    group = make_group(test_db, owner, [(test_user, "Developer")])
    thread = make_thread(test_db, group, owner, test_user)
    project_chat_service.send(
        test_db,
        user_id=owner.id,
        user_name=owner.user_name,
        request=ProjectChatSend(
            project_id=group.id,
            task_id=thread.id,
            content="Group-only content",
            client_message_id="protected",
        ),
    )
    row = test_db.query(WeworkNotification).one()
    path = f"/api/v1/wework-notifications/{row.id}/read"
    headers = {"Authorization": f"Bearer {test_token}"}
    assert test_client.post(path, headers=headers).status_code == 200
    test_db.query(ResourceMember).filter_by(
        resource_type="CollaborationChatGroup",
        resource_id=int(group.id),
        entity_id=str(test_user.id),
    ).delete()
    test_db.commit()
    denied = test_client.post(path, headers=headers)
    assert denied.status_code == 404
    assert "Group-only content" not in denied.text


def test_unmute_recovers_future_messages_in_completed_thread(test_db, test_user):
    reader = person(test_db, "reader")
    group = make_group(test_db, test_user, [(reader, "Viewer")])
    thread = make_thread(test_db, group, test_user)
    join_thread(test_db, thread, reader.id)
    test_db.flush()
    participant = test_db.get(ThreadParticipant, participant_id(thread.id, reader.id))
    participant.metadata_json = {"notifications": "muted"}
    thread.status = "completed"
    for index, preference in enumerate(["muted", "all"]):
        participant.metadata_json = {"notifications": preference}
        test_db.flush()
        project_chat_service.send(
            test_db,
            user_id=test_user.id,
            user_name=test_user.user_name,
            request=ProjectChatSend(
                project_id=group.id,
                task_id=thread.id,
                client_message_id=f"recover-{index}",
                content=f"Message {index}",
            ),
        )
    notification = test_db.query(WeworkNotification).one()
    assert notification.body == "Message 1"
    assert thread.status == "completed"


def test_thread_messages_honor_account_collaboration_channel_preferences(
    test_db, test_user
):
    reader = person(test_db, "reader")
    reader.preferences = json.dumps(
        {
            "wework_notification_preferences": {
                "collaboration": {"in_app": False, "system": False, "im": False},
            }
        }
    )
    group = make_group(test_db, test_user, [(reader, "Developer")])
    thread = make_thread(test_db, group, test_user, reader)
    project_chat_service.send(
        test_db,
        user_id=test_user.id,
        user_name=test_user.user_name,
        request=ProjectChatSend(
            project_id=group.id,
            task_id=thread.id,
            client_message_id="preferences",
            content="No channels enabled",
        ),
    )
    assert test_db.query(WeworkNotification).count() == 0
