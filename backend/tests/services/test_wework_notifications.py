"""Inbox persistence, transaction, authorization and IM contracts."""

from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

from app.models.wework_notification import WeworkNotification
from app.schemas.base_role import BaseRole
from app.schemas.project_chat import LoopItemAssign
from app.schemas.wework_notification import NotificationCreate
from app.services.loop_items.service import loop_item_service
from app.services.wework_notifications import (
    create_notification,
    deliver_notification,
    issue_url,
    send_project_notification,
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
    assert rows[0].payload["assignerName"] == test_user.user_name


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
    own = send_project_notification(
        test_db,
        user_id=test_user.id,
        values=NotificationCreate(
            project_id=project.id, title="Review", body="Review failed"
        ),
    )
    other = send_project_notification(
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


def test_send_rejects_cross_project_item_and_nonmember(test_db, test_user):
    project = _make_project(test_db, test_user)
    other = _make_project(test_db, test_user)
    item = _make_item(test_db, other, test_user)
    outsider = _make_member(test_db, other, "outsider", BaseRole.Developer)
    for data in [{"item_id": item.id}, {"recipient_user_id": outsider.id}]:
        with pytest.raises(HTTPException):
            send_project_notification(
                test_db,
                user_id=test_user.id,
                values=NotificationCreate(
                    project_id=project.id, title="Review", body="Please review", **data
                ),
            )
    assert test_db.query(WeworkNotification).count() == 0


async def test_im_receives_saved_link_even_when_live_push_fails(test_db, test_user):
    from types import SimpleNamespace

    row = create_notification(
        test_db,
        user_id=test_user.id,
        actor_user_id=test_user.id,
        title="Review",
        body="Review failed",
        project_id="123",
        item_id="ISSUE-1",
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
            "app.services.im.notification_dispatcher.im_notification_dispatcher.send_text",
            AsyncMock(return_value={"success": True}),
        ) as send,
    ):
        await deliver_notification(row.id)
    assert send.call_args.args[2] == f"Review failed\n\n{row.url}"


def test_scheme_encodes_external_issue_identifiers():
    assert (
        issue_url("12", "gitlab:12/issue#3")
        == "wework://boards/12/issues/gitlab%3A12%2Fissue%233"
    )
