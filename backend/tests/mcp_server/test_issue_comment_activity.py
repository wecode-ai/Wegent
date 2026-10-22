# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""MCP comments must use the activity stream consumed by the Issue UI."""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.security import create_access_token
from app.mcp_server.tools import wework_space
from app.models.delivery import CloudProject, LoopItem
from app.models.resource_member import ResourceMember
from app.models.user import User
from app.schemas.project_chat import ProjectChatSend, ProjectChatSubscribe
from app.services.project_chat import issue_comments
from app.services.project_chat.service import project_chat_service
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
