# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""MCP comments must use the activity stream consumed by the Issue UI."""

from typing import Any

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from mcp.server.fastmcp import FastMCP
from sqlalchemy.orm import Session

from app.core.security import create_access_token
from app.mcp_server.tool_registry import _register_tool
from app.mcp_server.tools import wework_space
from app.models.delivery import CloudProject, LoopItem
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.models.resource_member import ResourceMember
from app.models.user import User
from app.models.wework_notification import WeworkNotification
from app.schemas.project_chat import ProjectChatSend, ProjectChatSubscribe
from app.services.project_chat import issue_comments
from app.services.project_chat.service import project_chat_service
from app.services.workspaces.storage import workspace_id_for_project
from tests.mcp_server.test_wework_space import _project, _SessionContext, _token


@pytest.fixture
def issue_context(
    test_db: Session, test_user: User, monkeypatch: pytest.MonkeyPatch
) -> tuple[CloudProject, LoopItem]:
    project = _project(test_db, test_user, provider="local")
    item = LoopItem(
        id=f"{project.project_key}-1",
        cloud_project_id=project.id,
        sequence_number=1,
        title="Review comments use the visible Issue activity",
        status="pending",
        priority="none",
        created_by_user_id=test_user.id,
    )
    test_db.add(item)
    test_db.commit()
    monkeypatch.setattr(wework_space, "SessionLocal", lambda: _SessionContext(test_db))
    monkeypatch.setattr(issue_comments, "push_project_chat_message", lambda *_: None)
    monkeypatch.setattr(
        wework_space,
        "_board_context",
        lambda *_: {"space_id": str(project.id), "item_id": item.id},
    )
    return project, item


def test_successful_mcp_comment_is_in_the_issue_ui_activity(
    test_db: Session, test_user: User, issue_context: tuple[CloudProject, LoopItem]
) -> None:
    project, item = issue_context
    comment = wework_space.add_board_item_comment(_token(test_user), "PR review report")

    activity = project_chat_service.subscribe(
        test_db,
        user_id=test_user.id,
        request=ProjectChatSubscribe(project_id=str(project.id), task_id=item.id),
    )

    assert comment["id"], "Tool returned no persisted comment ID"
    assert any(
        message.message_id == comment["id"] and message.content == "PR review report"
        for message in activity
    ), f"Comment {comment['id']} was reported successful but is absent from Issue activity"


def test_mcp_reads_pr_links_posted_through_the_issue_ui(
    test_db: Session, test_user: User, issue_context: tuple[CloudProject, LoopItem]
) -> None:
    project, item = issue_context
    written = project_chat_service.send(
        test_db,
        user_id=test_user.id,
        user_name=test_user.user_name,
        request=ProjectChatSend(
            client_message_id="review-pr-link",
            project_id=str(project.id),
            task_id=item.id,
            content="https://github.com/wecode-ai/Wegent/pull/3933",
        ),
    ).message

    comments = wework_space.list_board_item_comments(_token(test_user))

    assert any(
        comment["id"] == written.message_id and comment["body"] == written.content
        for comment in comments
    )


def test_native_comment_http_uses_activity_and_checks_project_scope(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
    issue_context: tuple[CloudProject, LoopItem],
) -> None:
    project, item = issue_context
    headers = {"Authorization": f"Bearer {test_token}"}
    path = f"/api/v1/cloud-projects/{project.id}/loop-items/{item.id}/activity-comments"
    response = test_client.post(
        path, headers=headers, json={"body": "Native MCP report"}
    )
    assert response.status_code == 200, response.text
    written = response.json()
    assert written in test_client.get(path, headers=headers).json()
    assert written["body"] == "Native MCP report"

    other = _project(test_db, test_user, provider="local")
    wrong_scope = (
        f"/api/v1/cloud-projects/{other.id}/loop-items/{item.id}/activity-comments"
    )
    assert test_client.get(wrong_scope, headers=headers).status_code == 404
    assert (
        test_client.post(
            wrong_scope, headers=headers, json={"body": "Wrong"}
        ).status_code
        == 404
    )


def test_viewer_can_read_activity_but_cannot_comment(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    issue_context: tuple[CloudProject, LoopItem],
) -> None:
    project, item = issue_context
    viewer = User(
        user_name="issue-comment-viewer", password_hash="unused", is_active=True
    )
    test_db.add(viewer)
    test_db.flush()
    test_db.add(
        ResourceMember.create(
            resource_type="CloudProject",
            resource_id=int(project.id),
            entity_id=str(viewer.id),
            role="Viewer",
            status="approved",
        )
    )
    test_db.commit()
    token = create_access_token(data={"sub": viewer.user_name})
    headers = {"Authorization": f"Bearer {token}"}
    path = f"/api/v1/cloud-projects/{project.id}/loop-items/{item.id}/activity-comments"
    assert test_client.get(path, headers=headers).status_code == 200
    assert (
        test_client.post(path, headers=headers, json={"body": "Denied"}).status_code
        == 403
    )


def _post_mention_comment(
    entry: str,
    client: TestClient,
    user: User,
    project: CloudProject,
    item: LoopItem,
    mentions: list[dict[str, str]],
) -> tuple[int, dict[str, Any]]:
    body = "@reviewer please review this PR"
    if entry == "mcp":
        try:
            return 200, wework_space.add_board_item_comment(
                _token(user), body, str(project.id), item.id, mentions=mentions
            )
        except HTTPException as error:
            return error.status_code, {"detail": error.detail}
    token = create_access_token(data={"sub": user.user_name})
    response = client.post(
        f"/api/v1/cloud-projects/{project.id}/loop-items/{item.id}/activity-comments",
        headers={"Authorization": f"Bearer {token}"},
        json={"body": body, "mentions": mentions},
    )
    return response.status_code, response.json()


@pytest.mark.asyncio
async def test_backend_mcp_publishes_structured_mention_fields() -> None:
    server = FastMCP("comment-schema-check")
    _register_tool(
        server, wework_space.add_board_item_comment._mcp_tool_info, "wework_space"
    )
    tool = next(
        item
        for item in await server.list_tools()
        if item.name == "add_board_item_comment"
    )
    assert tool.inputSchema["properties"]["mentions"]["anyOf"] == [
        {"type": "array", "items": {"$ref": "#/$defs/ProjectChatMention"}},
        {"type": "null"},
    ]
    mention = tool.inputSchema["$defs"]["ProjectChatMention"]
    assert set(mention["required"]) == {"type", "id", "label"}
    assert mention["properties"]["type"]["enum"] == ["user", "agent"]
    assert "mentions" not in tool.inputSchema["required"]


@pytest.fixture
def inherited_comment_recipient(
    test_db: Session, issue_context: tuple[CloudProject, LoopItem]
) -> User:
    project, _ = issue_context
    user = User(
        user_name="mcp-mention-recipient", password_hash="unused", is_active=True
    )
    test_db.add(user)
    test_db.flush()
    test_db.add(
        ResourceMember.create(
            resource_type="Workspace",
            resource_id=workspace_id_for_project(test_db, int(project.id)),
            entity_id=str(user.id),
            role="Viewer",
            status="approved",
        )
    )
    test_db.commit()
    return user


@pytest.mark.parametrize("entry", ["mcp", "native_http"])
def test_mcp_member_mentions_persist_and_notify_once(
    entry: str,
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    issue_context: tuple[CloudProject, LoopItem],
    inherited_comment_recipient: User,
) -> None:
    project, item = issue_context
    recipient = inherited_comment_recipient
    mention = {"type": "user", "id": str(recipient.id), "label": recipient.user_name}
    status, written = _post_mention_comment(
        entry, test_client, test_user, project, item, [mention, mention]
    )
    assert status == 200, written
    assert written["mentions"] == [mention, mention]
    message = (
        test_db.query(ProjectChatMessage).filter_by(message_id=written["id"]).one()
    )
    assert message.metadata_json["mentions"] == written["mentions"]
    assert message.metadata_json["execution_dispatch"] == "comment_only"
    notification = test_db.query(WeworkNotification).one()
    assert notification.user_id == recipient.id
    assert notification.actor_user_id == test_user.id
    assert notification.kind == "mention"
    assert notification.payload["commentId"] == written["id"]
    assert notification.payload["itemId"] == item.id
    assert notification.payload["projectId"] == str(project.id)
    assert test_db.query(LoopItemExecution).count() == 0
    comments = wework_space.list_board_item_comments(_token(test_user))
    assert (
        next(row for row in comments if row["id"] == written["id"])["mentions"]
        == written["mentions"]
    )


@pytest.mark.parametrize("entry", ["mcp", "native_http"])
@pytest.mark.parametrize("self_mention", [False, True])
def test_mcp_plain_text_and_self_mentions_do_not_notify(
    entry: str,
    self_mention: bool,
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    issue_context: tuple[CloudProject, LoopItem],
) -> None:
    project, item = issue_context
    mentions = (
        [{"type": "user", "id": str(test_user.id), "label": test_user.user_name}]
        if self_mention
        else []
    )
    status, written = _post_mention_comment(
        entry, test_client, test_user, project, item, mentions
    )
    assert status == 200, written
    assert test_db.query(ProjectChatMessage).count() == 1
    assert test_db.query(WeworkNotification).count() == 0


@pytest.mark.parametrize("entry", ["mcp", "native_http"])
@pytest.mark.parametrize(
    "denial", ["nonmember", "inactive", "restricted", "related", "invalid"]
)
def test_mcp_denied_recipient_rolls_back_comment_and_notifications(
    entry: str,
    denial: str,
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    issue_context: tuple[CloudProject, LoopItem],
    inherited_comment_recipient: User,
) -> None:
    project, item = issue_context
    recipient = inherited_comment_recipient
    if denial == "nonmember":
        test_db.query(ResourceMember).filter_by(entity_id=str(recipient.id)).delete()
    elif denial == "inactive":
        recipient.is_active = False
    elif denial == "restricted":
        project.membership_mode = "restricted"
    elif denial == "related":
        item.metadata_json = {"security_level": "related"}
    test_db.commit()
    mentions = [
        {
            "type": "user",
            "id": "not-a-user" if denial == "invalid" else str(recipient.id),
            "label": recipient.user_name,
        },
    ]
    status, result = _post_mention_comment(
        entry, test_client, test_user, project, item, mentions
    )
    assert status == 422, result
    assert test_db.query(ProjectChatMessage).count() == 0
    assert test_db.query(WeworkNotification).count() == 0


@pytest.mark.parametrize("entry", ["mcp", "native_http"])
def test_mcp_viewer_cannot_send_mentions(
    entry: str,
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    issue_context: tuple[CloudProject, LoopItem],
    inherited_comment_recipient: User,
) -> None:
    project, item = issue_context
    mentions = [{"type": "user", "id": str(test_user.id), "label": test_user.user_name}]
    status, result = _post_mention_comment(
        entry, test_client, inherited_comment_recipient, project, item, mentions
    )
    assert status == 403, result
    assert test_db.query(ProjectChatMessage).count() == 0
    assert test_db.query(WeworkNotification).count() == 0
