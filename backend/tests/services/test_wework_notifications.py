"""Inbox persistence, transaction, authorization and IM contracts."""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

from app.core.config import settings
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.user import User
from app.models.wework_notification import WeworkNotification
from app.schemas.base_role import BaseRole
from app.schemas.project_chat import LoopItemAssign
from app.schemas.wework_notification import NotificationCreate
from app.services.cloud_project_visibility import (
    AUTHENTICATED_ENTITY_ID,
    AUTHENTICATED_ENTITY_TYPE,
)
from app.services.loop_items.service import loop_item_service
from app.services.wework_notifications import (
    create_notification,
    deliver_notification,
    deliver_notification_payload,
    issue_url,
    notification_links,
    send_wework_notification,
)
from tests.services.test_loop_item_assignment import (
    _make_item,
    _make_member,
    _make_project,
)


@pytest.fixture(autouse=True)
def no_external_delivery():
    with patch("app.core.async_utils.schedule_async_task") as schedule:
        yield schedule


@pytest.mark.parametrize(
    "url", [None, "wework://boards", "wework://tasks/local/task-1"]
)
@pytest.mark.parametrize("explicit_self", [False, True])
def test_send_without_project_persists_in_own_inbox(
    test_client,
    test_db,
    test_user,
    test_token,
    no_external_delivery,
    explicit_self,
    url,
):
    headers = {"Authorization": f"Bearer {test_token}"}
    values = {"title": "Greeting", "body": "你好", "url": url}
    if explicit_self:
        values["recipient_user_id"] = test_user.id
    path = "/api/v1/wework-notifications"

    assert test_client.post(path, json=values).status_code == 401
    response = test_client.post(path, json=values, headers=headers)

    assert response.status_code == 201
    saved = response.json()
    assert saved["url"] == url
    assert saved["body"] == "你好"
    row = test_db.get(WeworkNotification, saved["id"])
    assert row.user_id == test_user.id
    assert row.url == (url or "")
    assert row.is_read is False
    assert row.read_status_changed_at == row.created_at
    assert saved["read_at"] is None
    no_external_delivery.assert_called_once_with(
        deliver_notification,
        saved["id"],
        {"in_app": True, "system": False, "im": True},
    )
    inbox = test_client.get(path, headers=headers).json()
    assert [row["id"] for row in inbox["items"]] == [saved["id"]]
    assert inbox["unread_count"] == 1
    read = test_client.post(f"{path}/{saved['id']}/read", headers=headers)
    assert read.status_code == 200
    read_at = read.json()["read_at"]
    assert read_at is not None
    assert (
        test_client.post(f"{path}/{saved['id']}/read", headers=headers).json()[
            "read_at"
        ]
        == read_at
    )
    assert test_client.post(f"{path}/read-all", headers=headers).status_code == 204
    assert (
        test_client.get(path, headers=headers).json()["items"][0]["read_at"] == read_at
    )
    assert test_client.get(path, headers=headers).json()["unread_count"] == 0


@pytest.mark.parametrize(
    "extra, status",
    [({"recipient_user_id": 999999}, 403), ({"item_id": "ISSUE-1"}, 422)],
)
def test_send_without_project_rejects_other_recipient_and_orphan_issue(
    test_client, test_db, test_token, no_external_delivery, extra, status
):
    response = test_client.post(
        "/api/v1/wework-notifications",
        json={"title": "Greeting", "body": "Hello", **extra},
        headers={"Authorization": f"Bearer {test_token}"},
    )
    assert response.status_code == status
    assert test_db.query(WeworkNotification).count() == 0
    no_external_delivery.assert_not_called()


def test_assignment_persists_once_and_honors_opt_out(test_db, test_user):
    project = _make_project(test_db, test_user)
    member = _make_member(test_db, project, "recipient", BaseRole.Developer)
    item = _make_item(test_db, project, test_user)
    for notify, target in [
        (False, member.id),
        (True, test_user.id),
        (True, member.id),
        (True, member.id),
    ]:
        loop_item_service.assign(
            test_db,
            project_id=project.id,
            item_id=item.id,
            user_id=test_user.id,
            values=LoopItemAssign(
                version=item.version,
                assignee_type="user",
                assignee_id=str(target),
                notify_assignee=notify,
            ),
        )
    rows = test_db.query(WeworkNotification).all()
    assert len(rows) == 1
    assert rows[0].user_id == member.id
    assert rows[0].url == issue_url(str(project.id), item.id)
    assert rows[0].payload["actorName"] == test_user.user_name


def test_version_conflict_rolls_back_notification(
    test_db, test_user, no_external_delivery
):
    project = _make_project(test_db, test_user)
    member = _make_member(test_db, project, "recipient", BaseRole.Developer)
    item = _make_item(test_db, project, test_user)
    with pytest.raises(HTTPException) as error:
        loop_item_service.assign(
            test_db,
            project_id=project.id,
            item_id=item.id,
            user_id=test_user.id,
            values=LoopItemAssign(
                version=item.version + 1,
                assignee_type="user",
                assignee_id=str(member.id),
            ),
        )
    assert error.value.status_code == 409
    assert test_db.query(WeworkNotification).count() == 0
    no_external_delivery.assert_not_called()


def test_ai_assignment_notifies_current_user(test_db, test_user):
    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)
    item.assignee_user_id = None
    test_db.commit()
    loop_item_service.assign(
        test_db,
        project_id=project.id,
        item_id=item.id,
        user_id=test_user.id,
        values=LoopItemAssign(
            version=item.version,
            assignee_type="user",
            assignee_id=str(test_user.id),
            notify_self=True,
        ),
    )
    assert test_db.query(WeworkNotification).one().user_id == test_user.id


def test_inbox_api_is_private_and_read_state_persists(
    test_client, test_db, test_user, test_token
):
    project = _make_project(test_db, test_user)
    member = _make_member(test_db, project, "recipient", BaseRole.Developer)
    own = send_wework_notification(
        test_db,
        user_id=test_user.id,
        values=NotificationCreate(
            project_id=project.id, title="Review", body="Review failed"
        ),
    )
    other = send_wework_notification(
        test_db,
        user_id=test_user.id,
        values=NotificationCreate(
            project_id=project.id,
            recipient_user_id=member.id,
            title="Review",
            body="Please review",
        ),
    )
    headers = {"Authorization": f"Bearer {test_token}"}
    path = "/api/v1/wework-notifications"
    assert test_client.get(path).status_code == 401
    response = test_client.get(path, headers=headers).json()
    assert [row["id"] for row in response["items"]] == [own.id]
    assert response["unread_count"] == 1
    assert (
        test_client.post(f"{path}/{other.id}/read", headers=headers).status_code == 404
    )
    for _ in range(2):
        assert (
            test_client.post(f"{path}/{own.id}/read", headers=headers).status_code
            == 200
        )
    assert test_client.get(path, headers=headers).json()["unread_count"] == 0
    assert test_client.post(f"{path}/read-all", headers=headers).status_code == 204
    assert test_db.get(WeworkNotification, other.id).read_at is None


def test_inbox_categories_have_independent_pagination_and_unread_counts(
    test_client, test_db, test_user, test_token
):
    rows = [
        create_notification(
            test_db,
            user_id=test_user.id,
            actor_user_id=test_user.id,
            title=kind,
            body=kind,
            kind=kind,
        )
        for kind in ("message", "assignment", "human_work", "new_kind")
    ]
    test_db.commit()
    headers = {"Authorization": f"Bearer {test_token}"}
    path = "/api/v1/wework-notifications"

    collaboration = test_client.get(
        f"{path}?category=collaboration&limit=1", headers=headers
    ).json()
    assert collaboration["unread_count"] == 2
    assert collaboration["next_offset"] == 1
    next_page = test_client.get(
        f"{path}?category=collaboration&limit=1&offset=1", headers=headers
    ).json()
    assert {collaboration["items"][0]["id"], next_page["items"][0]["id"]} == {
        rows[1].id,
        rows[2].id,
    }
    general = test_client.get(f"{path}?category=general", headers=headers).json()
    assert {item["id"] for item in general["items"]} == {rows[0].id, rows[3].id}
    assert general["unread_count"] == 2
    assert (
        test_client.get(f"{path}?category=unknown", headers=headers).status_code == 422
    )


def test_board_mentions_and_runs_join_the_collaboration_category(
    test_client, test_db, test_user, test_token
):
    """The bell files board work a member is pulled into under collaboration."""

    collaboration_kinds = (
        "mention",
        "execution",
        "issue_dispatch_assignment",
        "issue_dispatch_manager_turn",
    )
    rows = {
        kind: create_notification(
            test_db,
            user_id=test_user.id,
            actor_user_id=test_user.id,
            title=kind,
            body=kind,
            kind=kind,
        )
        for kind in (*collaboration_kinds, "message")
    }
    test_db.commit()
    headers = {"Authorization": f"Bearer {test_token}"}
    path = "/api/v1/wework-notifications"

    collaboration = test_client.get(
        f"{path}?category=collaboration", headers=headers
    ).json()
    assert {item["id"] for item in collaboration["items"]} == {
        rows[kind].id for kind in collaboration_kinds
    }
    general = test_client.get(f"{path}?category=general", headers=headers).json()
    assert {item["id"] for item in general["items"]} == {rows["message"].id}


def test_send_rejects_cross_project_item_and_nonmember(test_db, test_user):
    project = _make_project(test_db, test_user)
    other = _make_project(test_db, test_user)
    item = _make_item(test_db, other, test_user)
    outsider = _make_member(test_db, other, "outsider", BaseRole.Developer)
    for data in [{"item_id": item.id}, {"recipient_user_id": outsider.id}]:
        with pytest.raises(HTTPException):
            send_wework_notification(
                test_db,
                user_id=test_user.id,
                values=NotificationCreate(
                    project_id=project.id, title="Review", body="Please review", **data
                ),
            )
    assert test_db.query(WeworkNotification).count() == 0


def test_public_developer_cannot_send_project_notifications_without_membership(
    test_db, test_user
):
    project = _make_project(test_db, test_user)
    visitor = User(
        user_name="public-notification-visitor",
        password_hash="unused",
        email="public-notification-visitor@example.com",
        is_active=True,
    )
    test_db.add(visitor)
    test_db.flush()
    test_db.add(
        ResourceMember(
            resource_type=ResourceType.CLOUD_PROJECT.value,
            resource_id=project.id,
            entity_type=AUTHENTICATED_ENTITY_TYPE,
            entity_id=AUTHENTICATED_ENTITY_ID,
            role=BaseRole.Developer.value,
            status=MemberStatus.APPROVED.value,
        )
    )
    test_db.commit()

    for sender_id, recipient_id in (
        (visitor.id, test_user.id),
        (test_user.id, visitor.id),
    ):
        with pytest.raises(HTTPException) as error:
            send_wework_notification(
                test_db,
                user_id=sender_id,
                values=NotificationCreate(
                    project_id=project.id,
                    recipient_user_id=recipient_id,
                    title="Review",
                    body="Please review",
                ),
            )
        assert error.value.status_code == 403
    assert test_db.query(WeworkNotification).count() == 0


@pytest.mark.parametrize(
    "with_source, url", [(False, None), (True, None), (False, "wework://boards")]
)
async def test_im_receives_message_even_when_live_push_fails(
    test_db, test_user, with_source, url
):
    row = create_notification(
        test_db,
        user_id=test_user.id,
        actor_user_id=test_user.id,
        title="Review",
        body="Review failed",
        project_id="123" if with_source else None,
        item_id="ISSUE-1" if with_source else None,
        url=url,
    )
    test_db.commit()
    session = SimpleNamespace(channel_type="dingtalk", user_id=test_user.id)
    with (
        patch("app.db.session.SessionLocal", return_value=test_db),
        patch(
            "app.core.socketio.get_sio",
            return_value=SimpleNamespace(
                emit=AsyncMock(side_effect=RuntimeError("offline"))
            ),
        ),
        patch(
            "app.services.im.session_service.im_session_service.list_user_sessions",
            AsyncMock(return_value=[session]),
        ),
        patch(
            "app.services.im.notification_dispatcher.im_notification_dispatcher.send_notification",
            AsyncMock(return_value={"success": True}),
        ) as send,
    ):
        await deliver_notification(row.id)
    push = send.call_args.args[2]
    assert push.headline == "Review"
    assert push.card_headline == "Review"
    assert push.plain_text() == "Review failed"
    assert send.call_args.kwargs["links"] == notification_links(row)


async def test_im_push_closes_with_the_board_the_inbox_summarises(test_db, test_user):
    row = create_notification(
        test_db,
        user_id=test_user.id,
        actor_user_id=test_user.id,
        title="hajimi 在「修复登录」提到了你",
        body="麻烦看下这个改动",
        project_id="123",
        item_id="WEG-12",
        kind="mention",
        payload={"projectId": "123", "projectName": "test-pro"},
    )
    test_db.commit()
    session = SimpleNamespace(channel_type="dingtalk", user_id=test_user.id)
    with (
        patch("app.db.session.SessionLocal", return_value=test_db),
        patch(
            "app.core.socketio.get_sio",
            return_value=SimpleNamespace(emit=AsyncMock()),
        ),
        patch(
            "app.services.im.session_service.im_session_service.list_user_sessions",
            AsyncMock(return_value=[session]),
        ),
        patch(
            "app.services.im.notification_dispatcher.im_notification_dispatcher.send_notification",
            AsyncMock(return_value={"success": True}),
        ) as send,
    ):
        await deliver_notification(row.id)
    push = send.call_args.args[2]
    assert push.headline == "hajimi 在「修复登录」提到了你"
    assert push.facts == (("看板", "test-pro"),)
    assert push.detail_label == "评论内容"
    assert push.plain_text() == "看板：test-pro\n\n评论内容：麻烦看下这个改动"


def test_push_offers_the_desktop_deep_link_and_the_web_page(test_db, test_user):
    """A push must stay usable for a recipient who does not run Wework."""

    row = create_notification(
        test_db,
        user_id=test_user.id,
        actor_user_id=test_user.id,
        title="hajimi 在评论中提到了你",
        body="麻烦看下这个改动",
        project_id="123",
        item_id="WEG-12",
        kind="mention",
        payload={"projectId": "123", "itemId": "WEG-12", "projectName": "test-pro"},
    )
    test_db.commit()

    assert [(link.label, link.url) for link in notification_links(row)] == [
        ("在 Wework 中打开", row.url),
        (
            "查看任务",
            f"{settings.FRONTEND_URL.rstrip('/')}/collaboration/123/issues/WEG-12",
        ),
    ]


def test_push_without_a_board_item_has_nothing_to_open(test_db, test_user):
    row = create_notification(
        test_db,
        user_id=test_user.id,
        actor_user_id=test_user.id,
        title="Greeting",
        body="你好",
    )
    test_db.commit()

    assert notification_links(row) == []


def test_scheme_encodes_external_issue_identifiers():
    assert (
        issue_url("12", "gitlab:12/issue#3")
        == "wework://boards/12/issues/gitlab%3A12%2Fissue%233"
    )


def test_scheme_can_land_on_one_comment():
    assert (
        issue_url("12", "WEG-12", "3f/9")
        == "wework://boards/12/issues/WEG-12/comments/3f%2F9"
    )
    # A comment link is only meaningful inside an item.
    assert issue_url("12", None, "comment-1") == "wework://boards/12"


@pytest.mark.parametrize(
    "url",
    [
        "https://example.com",
        "wework://shell/run",
        "wework://boards/0",
        "wework://boards/12/../13",
        "wework://boards/12/issues/%00",
        "wework://boards/12/issues/%FF",
        "wework://boards/12/issues/%ZZ",
        "wework://boards/12/issues/WEG-12/comments",
        "wework://boards/12/comments/comment-1",
        "wework://boards/12/issues/WEG-12/notes/comment-1",
        "wework://boards/12/issues/WEG-12/comments/%00",
        "wework://user@boards/12",
        "wework://boards?redirect=x",
        123,
        " wework://boards",
        "wework://boards#",
        "wework://boards\n",
    ],
)
def test_notification_rejects_unsupported_click_targets(
    test_client, test_db, test_token, url
):
    response = test_client.post(
        "/api/v1/wework-notifications",
        json={"title": "Hello", "body": "你好", "url": url},
        headers={"Authorization": f"Bearer {test_token}"},
    )
    assert response.status_code == 422
    assert test_db.query(WeworkNotification).count() == 0


def test_explicit_click_target_overrides_source_link(test_db, test_user):
    project = _make_project(test_db, test_user)
    row = send_wework_notification(
        test_db,
        user_id=test_user.id,
        values=NotificationCreate(
            project_id=project.id, title="Hello", body="你好", url="wework://boards/"
        ),
    )
    assert row.url == "wework://boards"


def test_click_target_can_point_at_one_comment(test_client, test_db, test_token):
    url = "wework://boards/12/issues/WEG-12/comments/c-1"
    response = test_client.post(
        "/api/v1/wework-notifications",
        json={"title": "Hello", "body": "你好", "url": url},
        headers={"Authorization": f"Bearer {test_token}"},
    )
    assert response.status_code == 201
    assert test_db.query(WeworkNotification).one().url == url


def test_read_all_updates_only_unread_notifications_of_current_user(
    test_client, test_db, test_user, test_token
):
    project = _make_project(test_db, test_user)
    other = _make_member(test_db, project, "other-inbox", BaseRole.Developer)
    rows = [
        create_notification(
            test_db,
            user_id=recipient_id,
            actor_user_id=test_user.id,
            title="Read state",
            body="Hello",
        )
        for recipient_id in [test_user.id, test_user.id, other.id]
    ]
    test_db.commit()
    headers = {"Authorization": f"Bearer {test_token}"}
    path = "/api/v1/wework-notifications"
    first_read = test_client.post(f"{path}/{rows[0].id}/read", headers=headers).json()

    assert test_client.post(f"{path}/read-all", headers=headers).status_code == 204

    test_db.expire_all()
    assert rows[0].is_read and rows[1].is_read
    assert rows[1].read_at is not None
    assert rows[2].is_read is False
    assert rows[2].read_at is None
    inbox = test_client.get(path, headers=headers).json()
    assert inbox["unread_count"] == 0
    assert (
        next(row for row in inbox["items"] if row["id"] == rows[0].id)["read_at"]
        == first_read["read_at"]
    )


def test_notification_preferences_are_account_scoped_and_clear_category_unread(
    test_client, test_db, test_user, test_token
):
    rows = [
        create_notification(
            test_db,
            user_id=test_user.id,
            actor_user_id=test_user.id,
            title=kind,
            body=kind,
            kind=kind,
        )
        for kind in ("assignment", "message")
    ]
    test_db.commit()
    headers = {"Authorization": f"Bearer {test_token}"}
    path = "/api/v1/wework-notifications/preferences"

    defaults = test_client.get(path, headers=headers)
    assert defaults.status_code == 200
    assert defaults.json()["tasks"] == {
        "in_app": True,
        "system": False,
        "im": None,
    }

    updated = test_client.put(
        path,
        headers=headers,
        json={"category": "collaboration", "channel": "in_app", "enabled": False},
    )
    assert updated.status_code == 200
    assert updated.json()["collaboration"]["in_app"] is False
    test_db.expire_all()
    assert test_db.get(WeworkNotification, rows[0].id).is_read is True
    assert test_db.get(WeworkNotification, rows[1].id).is_read is False
    assert (
        json.loads(test_db.get(type(test_user), test_user.id).preferences)[
            "wework_notification_preferences"
        ]["collaboration"]["in_app"]
        is False
    )


def test_malformed_notification_preferences_fall_back_without_blocking_delivery(
    test_client, test_db, test_user, test_token, no_external_delivery
):
    test_user.preferences = json.dumps(
        {
            "wework_notification_preferences": {
                "collaboration": {
                    "in_app": "invalid",
                    "system": True,
                    "im": False,
                    "future_channel": True,
                },
                "future_category": {"in_app": False},
            }
        }
    )
    test_db.commit()
    headers = {"Authorization": f"Bearer {test_token}"}

    preferences = test_client.get(
        "/api/v1/wework-notifications/preferences",
        headers=headers,
    )
    notification = test_client.post(
        "/api/v1/wework-notifications",
        headers=headers,
        json={"title": "Available", "body": "Delivery still works"},
    )

    assert preferences.status_code == 200
    assert preferences.json()["collaboration"] == {
        "in_app": True,
        "system": True,
        "im": False,
    }
    assert notification.status_code == 201
    no_external_delivery.assert_called_once()


def test_disabling_local_task_inbox_does_not_clear_cloud_unread(
    test_client, test_db, test_user, test_token
):
    rows = [
        create_notification(
            test_db,
            user_id=test_user.id,
            actor_user_id=test_user.id,
            title=kind,
            body=kind,
            kind=kind,
        )
        for kind in ("assignment", "message")
    ]
    test_db.commit()

    response = test_client.put(
        "/api/v1/wework-notifications/preferences",
        headers={"Authorization": f"Bearer {test_token}"},
        json={"category": "tasks", "channel": "in_app", "enabled": False},
    )

    assert response.status_code == 200
    test_db.expire_all()
    assert all(
        test_db.get(WeworkNotification, notification.id).is_read is False
        for notification in rows
    )


def test_disabled_inbox_still_allows_enabled_im_delivery(
    test_client, test_db, test_user, test_token, no_external_delivery
):
    test_user.preferences = json.dumps(
        {
            "wework_notification_preferences": {
                "general": {"in_app": False, "system": None, "im": True}
            }
        }
    )
    test_db.commit()

    response = test_client.post(
        "/api/v1/wework-notifications",
        headers={"Authorization": f"Bearer {test_token}"},
        json={"title": "Quiet inbox", "body": "Still send IM"},
    )

    assert response.status_code == 201
    assert test_db.query(WeworkNotification).count() == 0
    no_external_delivery.assert_called_once()
    assert no_external_delivery.call_args.args[0] is deliver_notification_payload
    assert no_external_delivery.call_args.args[2] == {
        "in_app": False,
        "system": False,
        "im": True,
    }


async def test_disabled_collaboration_im_skips_dingtalk_push(
    test_db, test_user, no_external_delivery
):
    test_user.preferences = json.dumps(
        {
            "wework_notification_preferences": {
                "collaboration": {"in_app": True, "system": True, "im": False}
            }
        }
    )
    test_db.commit()
    row = create_notification(
        test_db,
        user_id=test_user.id,
        actor_user_id=test_user.id,
        title="Mention",
        body="Please review",
        kind="mention",
    )
    test_db.commit()
    channels = no_external_delivery.call_args.args[2]
    session = SimpleNamespace(channel_type="dingtalk", user_id=test_user.id)

    with (
        patch("app.db.session.SessionLocal", return_value=test_db),
        patch(
            "app.core.socketio.get_sio",
            return_value=SimpleNamespace(emit=AsyncMock()),
        ),
        patch(
            "app.services.im.session_service.im_session_service.list_user_sessions",
            AsyncMock(return_value=[session]),
        ) as list_sessions,
        patch(
            "app.services.im.notification_dispatcher.im_notification_dispatcher.send_notification",
            AsyncMock(return_value={"success": True}),
        ) as send,
    ):
        await deliver_notification(row.id, channels)

    assert channels == {"in_app": True, "system": True, "im": False}
    list_sessions.assert_not_awaited()
    send.assert_not_awaited()


def test_all_disabled_channels_drop_general_notification(
    test_client, test_db, test_user, test_token, no_external_delivery
):
    test_user.preferences = json.dumps(
        {
            "wework_notification_preferences": {
                "general": {"in_app": False, "system": None, "im": False}
            }
        }
    )
    test_db.commit()

    response = test_client.post(
        "/api/v1/wework-notifications",
        headers={"Authorization": f"Bearer {test_token}"},
        json={"title": "Muted", "body": "Do not deliver"},
    )

    assert response.status_code == 201
    assert test_db.query(WeworkNotification).count() == 0
    no_external_delivery.assert_not_called()
