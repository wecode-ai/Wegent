# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import hashlib
from datetime import datetime, timedelta

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.api_key import KEY_TYPE_PERSONAL, APIKey
from app.models.task import TaskResource
from app.models.user import User


def _create_task(
    db: Session,
    *,
    user_id: int,
    task_id: int,
    state: int = TaskResource.STATE_ACTIVE,
) -> TaskResource:
    task = TaskResource(
        id=task_id,
        user_id=user_id,
        kind="Task",
        name=f"task-{task_id}",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Task",
            "metadata": {"name": f"task-{task_id}", "namespace": "default"},
            "spec": {"title": f"task-{task_id}", "prompt": ""},
            "status": {"state": "Available", "status": "COMPLETED"},
        },
        is_active=state,
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    return task


def _create_user(db: Session, username: str) -> User:
    user = User(
        user_name=username,
        password_hash="test",
        email=f"{username}@example.com",
        is_active=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def _create_personal_api_key(db: Session, user_id: int, raw_key: str) -> APIKey:
    api_key = APIKey(
        user_id=user_id,
        key_hash=hashlib.sha256(raw_key.encode()).hexdigest(),
        key_prefix=f"{raw_key[:8]}...",
        name="External Task Test Key",
        key_type=KEY_TYPE_PERSONAL,
        expires_at=datetime.utcnow() + timedelta(days=1),
        is_active=True,
    )
    db.add(api_key)
    db.commit()
    db.refresh(api_key)
    return api_key


def test_external_task_share_accepts_owner_personal_api_key(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
) -> None:
    task = _create_task(test_db, user_id=test_user.id, task_id=91001)
    raw_key = "wg-external-task-share-owner"
    _create_personal_api_key(test_db, test_user.id, raw_key)

    response = test_client.post(
        f"/api/external/tasks/{task.id}/share",
        headers={"X-API-Key": raw_key},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["share_url"]
    assert body["share_token"]


def test_external_task_share_rejects_non_owner_personal_api_key(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
) -> None:
    task = _create_task(test_db, user_id=test_user.id, task_id=91002)
    other_user = _create_user(test_db, "external-task-share-other")
    raw_key = "wg-external-task-share-other"
    _create_personal_api_key(test_db, other_user.id, raw_key)

    response = test_client.post(
        f"/api/external/tasks/{task.id}/share",
        headers={"X-API-Key": raw_key},
    )

    assert response.status_code == 404


def test_external_task_share_rejects_inactive_owner_task(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
) -> None:
    task = _create_task(
        test_db,
        user_id=test_user.id,
        task_id=91003,
        state=TaskResource.STATE_DELETED,
    )
    raw_key = "wg-external-task-share-inactive"
    _create_personal_api_key(test_db, test_user.id, raw_key)

    response = test_client.post(
        f"/api/external/tasks/{task.id}/share",
        headers={"X-API-Key": raw_key},
    )

    assert response.status_code == 404
