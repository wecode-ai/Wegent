# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
from datetime import datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.constants import CLIENT_ORIGIN_FRONTEND, CLIENT_ORIGIN_WEWORK
from app.core.security import get_password_hash
from app.models.im_session import IMPrivateSession, IMSessionMode
from app.models.task import TaskResource
from app.models.user import User
from app.services.im.session_service import im_session_service


@pytest.fixture(autouse=True)
def use_fake_im_session_cache(fake_im_session_cache):
    return fake_im_session_cache


def _auth_header(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _task_json(task_id: int, title: str) -> dict:
    return {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Task",
        "metadata": {
            "name": f"task-{task_id}",
            "namespace": "default",
            "labels": {"taskType": "chat"},
        },
        "spec": {
            "title": title,
            "prompt": title,
            "teamRef": {"name": "assistant", "namespace": "default"},
            "workspaceRef": {"name": f"workspace-{task_id}", "namespace": "default"},
        },
        "status": {"status": "COMPLETED"},
    }


def _create_task(
    db: Session,
    *,
    task_id: int,
    user_id: int,
    title: str,
    client_origin: str = CLIENT_ORIGIN_WEWORK,
) -> TaskResource:
    task = TaskResource(
        id=task_id,
        user_id=user_id,
        kind="Task",
        name=f"task-{task_id}",
        namespace="default",
        json=_task_json(task_id, title),
        is_active=TaskResource.STATE_ACTIVE,
        client_origin=client_origin,
        is_group_chat=False,
        created_at=datetime.now(),
        updated_at=datetime.now(),
    )
    db.add(task)
    return task


def _create_session(
    db: Session,
    *,
    user_id: int,
    channel_type: str = "dingtalk",
    channel_id: int = 12,
    conversation_id: str,
) -> IMPrivateSession:
    return asyncio.run(
        im_session_service.get_or_create_private_session(
            db=db,
            user_id=user_id,
            channel_type=channel_type,
            channel_id=channel_id,
            conversation_id=conversation_id,
            sender_id=f"sender-{conversation_id}",
            display_name=f"User {conversation_id}",
        )
    )


def _get_session(session_key: str) -> IMPrivateSession:
    session = asyncio.run(im_session_service.get_session(session_key))
    assert session is not None
    return session


def _create_other_user(db: Session) -> User:
    other = User(
        user_name="other-im-user",
        password_hash=get_password_hash("testpassword123"),
        email="other-im@example.com",
        is_active=True,
        git_info=None,
    )
    db.add(other)
    db.commit()
    db.refresh(other)
    return other


def test_list_private_sessions_returns_current_user_sessions_with_channel_label(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
) -> None:
    mine = _create_session(
        test_db,
        user_id=test_user.id,
        conversation_id="mine-dingtalk",
    )
    telegram = _create_session(
        test_db,
        user_id=test_user.id,
        channel_type="telegram",
        channel_id=22,
        conversation_id="mine-telegram",
    )
    other_user = _create_other_user(test_db)
    _create_session(
        test_db,
        user_id=other_user.id,
        conversation_id="other-dingtalk",
    )
    test_db.commit()

    response = test_client.get(
        "/api/im/private-sessions",
        headers=_auth_header(test_token),
    )

    assert response.status_code == 200
    payload = response.json()
    item_keys = {item["session_key"] for item in payload["items"]}
    assert payload["total"] == 2
    assert item_keys == {mine.session_key, telegram.session_key}
    labels_by_key = {
        item["session_key"]: item["channel_label"] for item in payload["items"]
    }
    assert labels_by_key[mine.session_key] == "钉钉"
    assert labels_by_key[telegram.session_key] == "Telegram"


def test_list_private_sessions_returns_discord_channel_label(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
) -> None:
    session = _create_session(
        test_db,
        user_id=test_user.id,
        channel_type="discord",
        channel_id=88,
        conversation_id="discord-dm",
    )
    test_db.commit()

    response = test_client.get(
        "/api/im/private-sessions",
        headers=_auth_header(test_token),
    )

    assert response.status_code == 200
    payload = response.json()
    labels_by_key = {
        item["session_key"]: item["channel_label"] for item in payload["items"]
    }
    assert labels_by_key[session.session_key] == "Discord"


def test_bind_task_private_sessions_returns_bound_keys_and_notified_count(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    task = _create_task(
        test_db,
        task_id=9301,
        user_id=test_user.id,
        title="绑定 IM 会话",
    )
    first = _create_session(
        test_db,
        user_id=test_user.id,
        conversation_id="bind-a",
    )
    second = _create_session(
        test_db,
        user_id=test_user.id,
        conversation_id="bind-b",
    )
    test_db.commit()
    calls: list[dict[str, object]] = []

    async def fake_send_task_switched(db, sessions, task_title):
        calls.append(
            {
                "session_keys": [session.session_key for session in sessions],
                "task_title": task_title,
            }
        )
        return {"sent": len(sessions), "results": []}

    monkeypatch.setattr(
        "app.api.endpoints.im_sessions.im_notification_dispatcher.send_task_switched",
        fake_send_task_switched,
    )

    response = test_client.post(
        f"/api/tasks/{task.id}/im-sessions",
        headers=_auth_header(test_token),
        json={"session_keys": [second.session_key, first.session_key]},
    )

    assert response.status_code == 200
    assert response.json() == {
        "task_id": task.id,
        "bound_session_keys": [second.session_key, first.session_key],
        "notified_count": 2,
    }
    assert calls == [
        {
            "session_keys": [second.session_key, first.session_key],
            "task_title": "绑定 IM 会话",
        }
    ]
    bound_first = _get_session(first.session_key)
    bound_second = _get_session(second.session_key)
    assert bound_first.mode == IMSessionMode.TASK
    assert bound_first.active_task_id == task.id
    assert bound_second.mode == IMSessionMode.TASK
    assert bound_second.active_task_id == task.id


def test_bind_task_private_sessions_rejects_wrong_origin_task(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
) -> None:
    task = _create_task(
        test_db,
        task_id=9311,
        user_id=test_user.id,
        title="前端任务",
        client_origin=CLIENT_ORIGIN_FRONTEND,
    )
    session = _create_session(
        test_db,
        user_id=test_user.id,
        conversation_id="wrong-origin",
    )
    test_db.commit()

    response = test_client.post(
        f"/api/tasks/{task.id}/im-sessions",
        headers=_auth_header(test_token),
        json={"session_keys": [session.session_key]},
    )

    assert response.status_code == 404


def test_bind_task_private_sessions_rejects_missing_session(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
) -> None:
    task = _create_task(
        test_db,
        task_id=9321,
        user_id=test_user.id,
        title="缺失会话任务",
    )
    test_db.commit()

    response = test_client.post(
        f"/api/tasks/{task.id}/im-sessions",
        headers=_auth_header(test_token),
        json={"session_keys": ["missing-session-key"]},
    )

    assert response.status_code == 404
