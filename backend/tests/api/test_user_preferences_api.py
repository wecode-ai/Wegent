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
                "follow_up_behavior": "guide",
                "search_key": "cmd_k",
                "memory_enabled": False,
                "mcp_provider_keys": None,
                "default_execution_target": "cloud",
                "wework_new_chat_model_selection": {
                    "modelName": "codex-gpt-5.5",
                    "modelType": "runtime",
                    "options": {"reasoning": "medium"},
                },
                "wework_project_execution_mode": "git_worktree",
                "wework_project_work_preferences": {
                    "project:7": {
                        "executionMode": "git_worktree",
                        "worktreeBranch": "feature/alpha",
                    }
                },
                "quick_access": {"teams": [188]},
            }
        },
    )

    assert response.status_code == 200
    assert response.json()["preferences"]["quick_access"]["teams"] == [188]
    assert response.json()["preferences"]["follow_up_behavior"] == "guide"

    test_db.refresh(test_user)
    stored_preferences = json.loads(test_user.preferences)
    assert stored_preferences["quick_access"]["teams"] == [188]
    assert stored_preferences["follow_up_behavior"] == "guide"
    assert stored_preferences["wework_new_chat_model_selection"]["options"] == {
        "reasoning": "medium"
    }
    assert stored_preferences["wework_project_execution_mode"] == "git_worktree"
    assert stored_preferences["wework_project_work_preferences"]["project:7"] == {
        "executionMode": "git_worktree",
        "worktreeBranch": "feature/alpha",
    }

    read_response = user_preferences_client.get("/api/users/me")
    assert read_response.status_code == 200
    assert read_response.json()["preferences"]["wework_project_work_preferences"][
        "project:7"
    ] == {
        "executionMode": "git_worktree",
        "worktreeBranch": "feature/alpha",
    }


@pytest.mark.api
def test_update_user_preferences_preserves_weibo_binding(
    user_preferences_client: TestClient,
    test_db: Session,
    test_user: User,
):
    test_user.preferences = json.dumps(
        {
            "send_key": "enter",
            "search_key": "cmd_k",
            "weibo_binding": {
                "uid": "1234567890",
                "screen_name": "微博用户",
                "avatar_url": "https://weibo.com/avatar.jpg",
                "bound_at": "2026-06-03T00:00:00+00:00",
            },
        }
    )
    test_db.add(test_user)
    test_db.commit()

    response = user_preferences_client.put(
        "/api/users/me",
        json={"preferences": {"send_key": "cmd_enter"}},
    )

    assert response.status_code == 200
    assert response.json()["weibo_uid"] == "1234567890"

    test_db.refresh(test_user)
    stored_preferences = json.loads(test_user.preferences)
    assert stored_preferences["send_key"] == "cmd_enter"
    assert stored_preferences["weibo_binding"] == {
        "uid": "1234567890",
        "screen_name": "微博用户",
        "avatar_url": "https://weibo.com/avatar.jpg",
        "bound_at": "2026-06-03T00:00:00+00:00",
    }


@pytest.mark.api
def test_update_user_preferences_ignores_weibo_binding_payload(
    user_preferences_client: TestClient,
    test_db: Session,
    test_user: User,
):
    test_user.preferences = json.dumps(
        {
            "weibo_binding": {
                "uid": "1234567890",
                "bound_at": "2026-06-03T00:00:00+00:00",
            },
        }
    )
    test_db.add(test_user)
    test_db.commit()

    response = user_preferences_client.put(
        "/api/users/me",
        json={
            "preferences": {
                "send_key": "cmd_enter",
                "weibo_binding": None,
            }
        },
    )

    assert response.status_code == 200

    test_db.refresh(test_user)
    stored_preferences = json.loads(test_user.preferences)
    assert stored_preferences["send_key"] == "cmd_enter"
    assert stored_preferences["weibo_binding"]["uid"] == "1234567890"


@pytest.mark.api
def test_read_current_user_accepts_uid_only_weibo_binding(
    user_preferences_client: TestClient,
    test_db: Session,
    test_user: User,
):
    test_user.preferences = json.dumps(
        {
            "weibo_binding": {
                "uid": "1234567890",
            },
        }
    )
    test_db.add(test_user)
    test_db.commit()

    response = user_preferences_client.get("/api/users/me")

    assert response.status_code == 200
    body = response.json()
    assert body["weibo_uid"] == "1234567890"
    assert body["weibo_bound_at"] is None
    assert body["preferences"]["weibo_binding"]["uid"] == "1234567890"
