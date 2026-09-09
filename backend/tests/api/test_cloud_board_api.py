# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Public user API contracts for creating cloud boards and board tasks."""

import hashlib
from datetime import datetime, timedelta

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.api_key import KEY_TYPE_SERVICE, APIKey
from app.models.cloud_project import CloudProject
from app.models.delivery import LoopItem
from app.models.user import User
from app.services.auth import create_task_token


def test_personal_api_key_creates_board_and_task(
    test_client: TestClient,
    test_db: Session,
    test_api_key: tuple[str, APIKey],
) -> None:
    raw_key, api_key = test_api_key

    board_response = test_client.post(
        "/api/v1/cloud-projects",
        headers={"X-API-Key": raw_key},
        json={
            "project_key": "API",
            "name": "API board",
            "description": "Created through the public user API",
        },
    )

    assert board_response.status_code == 201
    board = board_response.json()
    assert board["created_by_user_id"] == api_key.user_id
    assert board["project_key"] == "API"

    task_response = test_client.post(
        f"/api/v1/cloud-projects/{board['id']}/loop-items",
        headers={"Authorization": f"Bearer {raw_key}"},
        json={
            "title": "Created by API",
            "description": "Keep the normal board task semantics",
            "priority": "high",
            "tags": ["api"],
        },
    )

    assert task_response.status_code == 201
    task = task_response.json()
    assert task["cloud_project_id"] == board["id"]
    assert task["created_by_user_id"] == api_key.user_id
    assert task["assignee_user_id"] == api_key.user_id
    assert task["status"] == "inbox"
    assert task["priority"] == "high"
    assert task["tags"] == ["api"]
    assert test_db.get(CloudProject, board["id"]) is not None
    assert test_db.get(LoopItem, task["id"]) is not None


def test_api_key_task_creation_uses_board_status_validation(
    test_client: TestClient,
    test_api_key: tuple[str, APIKey],
) -> None:
    raw_key, _ = test_api_key
    board = test_client.post(
        "/api/v1/cloud-projects",
        headers={"X-API-Key": raw_key},
        json={"name": "Status contract"},
    ).json()

    response = test_client.post(
        f"/api/v1/cloud-projects/{board['id']}/loop-items",
        headers={"X-API-Key": raw_key},
        json={"title": "Invalid lane", "status": "not-a-board-status"},
    )

    assert response.status_code == 422
    assert response.json()["detail"] == "Unknown board status"


def test_personal_api_key_cannot_create_task_in_another_private_board(
    test_client: TestClient,
    test_api_key: tuple[str, APIKey],
    test_admin_api_key: tuple[str, APIKey],
) -> None:
    user_key, _ = test_api_key
    admin_key, _ = test_admin_api_key
    board = test_client.post(
        "/api/v1/cloud-projects",
        headers={"X-API-Key": admin_key},
        json={"name": "Private admin board"},
    ).json()

    response = test_client.post(
        f"/api/v1/cloud-projects/{board['id']}/loop-items",
        headers={"X-API-Key": user_key},
        json={"title": "Forbidden task"},
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "Cloud project not found"


def test_service_api_key_cannot_create_user_board(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
) -> None:
    raw_key = "wg-service-board-key"
    test_db.add(
        APIKey(
            user_id=test_user.id,
            key_hash=hashlib.sha256(raw_key.encode()).hexdigest(),
            key_prefix="wg-service...",
            name="Board service key",
            key_type=KEY_TYPE_SERVICE,
            expires_at=datetime.utcnow() + timedelta(days=1),
            is_active=True,
        )
    )
    test_db.commit()

    response = test_client.post(
        "/api/v1/cloud-projects",
        headers={"X-API-Key": raw_key},
        json={"name": "Service-created board"},
    )

    assert response.status_code == 401
    assert response.json()["detail"] == "Invalid or expired API key"


def test_board_creation_endpoints_document_jwt_and_api_key_authentication(
    test_client: TestClient,
) -> None:
    paths = test_client.app.openapi()["paths"]

    for path in (
        "/api/v1/cloud-projects",
        "/api/v1/cloud-projects/{project_id}/loop-items",
    ):
        security = paths[path]["post"]["security"]
        assert {"OAuth2PasswordBearer": []} in security
        assert {"APIKeyHeader": []} in security


def test_runtime_task_token_supports_wework_space_board_flow(
    test_client: TestClient,
    test_user: User,
) -> None:
    task_token = create_task_token(
        task_id=0,
        subtask_id=0,
        user_id=test_user.id,
        user_name=test_user.user_name,
    )
    headers = {"Authorization": f"Bearer {task_token}"}

    project_response = test_client.post(
        "/api/v1/cloud-projects",
        headers=headers,
        json={"name": "Runtime board"},
    )
    assert project_response.status_code == 201
    project_id = project_response.json()["id"]

    list_response = test_client.get("/api/v1/cloud-projects", headers=headers)
    assert list_response.status_code == 200
    assert project_id in {item["id"] for item in list_response.json()["items"]}

    item_response = test_client.post(
        f"/api/v1/cloud-projects/{project_id}/loop-items",
        headers=headers,
        json={"title": "Created from a cloud Runtime"},
    )
    assert item_response.status_code == 201
    item_id = item_response.json()["id"]

    context_response = test_client.get(
        f"/api/v1/loop-items/{item_id}",
        headers=headers,
    )
    assert context_response.status_code == 200
    assert context_response.json()["id"] == item_id
