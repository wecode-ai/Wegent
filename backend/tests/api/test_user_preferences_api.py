# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.api.endpoints.users import router
from app.core import security
from app.models.user import User


@pytest.fixture
def user_preferences_client(test_db: Session, test_user: User) -> TestClient:
    app = FastAPI()
    app.include_router(router, prefix="/api/users")

    def override_get_db():
        yield test_db

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[security.get_current_user] = lambda: test_user
    app.dependency_overrides[security.get_current_user_optional] = lambda: test_user

    return TestClient(app)


@pytest.mark.api
def test_read_current_user_accepts_runtime_model_selection(
    user_preferences_client: TestClient,
    test_db: Session,
    test_user: User,
):
    test_user.preferences = json.dumps(
        {
            "wework_new_chat_model_selection": {
                "modelName": "codex-gpt-5.5",
                "modelType": "runtime",
                "options": {"reasoning": "medium"},
            }
        }
    )
    test_db.add(test_user)
    test_db.commit()

    response = user_preferences_client.get("/api/users/me")

    assert response.status_code == 200
    assert (
        response.json()["preferences"]["wework_new_chat_model_selection"]["modelType"]
        == "runtime"
    )


@pytest.mark.api
def test_update_user_preferences_preserves_quick_access(
    user_preferences_client: TestClient,
    test_db: Session,
    test_user: User,
):
    response = user_preferences_client.put(
        "/api/users/me",
        json={
            "preferences": {
                "send_key": "enter",
                "search_key": "cmd_k",
                "memory_enabled": False,
                "mcp_provider_keys": None,
                "default_execution_target": "cloud",
                "wework_project_execution_mode": "git_worktree",
                "quick_access": {"teams": [188]},
            }
        },
    )

    assert response.status_code == 200
    assert response.json()["preferences"]["quick_access"]["teams"] == [188]

    test_db.refresh(test_user)
    stored_preferences = json.loads(test_user.preferences)
    assert stored_preferences["quick_access"]["teams"] == [188]
    assert stored_preferences["wework_project_execution_mode"] == "git_worktree"
