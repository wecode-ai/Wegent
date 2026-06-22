# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.api.dependencies import get_db
from app.api.endpoints.adapter.tasks import router
from app.core import security
from app.models.user import User
from app.schemas.task_fork import TaskForkRequest


@pytest.fixture
def task_fork_client():
    user = User(id=7, user_name="alice", email="alice@example.com")
    app = FastAPI()
    app.include_router(router, prefix="/api/tasks")

    def override_get_db():
        yield SimpleNamespace()

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[security.get_current_user] = lambda: user

    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def _task_detail(task_id: int) -> dict:
    now = datetime(2026, 1, 1)
    return {
        "id": task_id,
        "title": "Fork",
        "git_url": "",
        "git_repo": "",
        "git_repo_id": None,
        "git_domain": "",
        "branch_name": "",
        "prompt": "Prompt",
        "status": "COMPLETED",
        "task_type": "code",
        "project_id": 3,
        "client_origin": "wework",
        "progress": 100,
        "result": None,
        "error_message": None,
        "created_at": now,
        "updated_at": now,
        "completed_at": None,
        "user": None,
        "team": None,
        "subtasks": [],
        "model_id": None,
        "force_override_bot_model_type": None,
        "model_options": None,
        "is_group_chat": False,
        "is_group_owner": False,
        "member_count": None,
        "app": None,
        "device_id": None,
        "execution_workspace_source": "git_worktree",
        "execution_workspace_path": "/tmp/worktree",
        "preserve_executor": False,
        "requested_skills": None,
    }


def test_fork_endpoint_calls_service_and_returns_task(task_fork_client, monkeypatch):
    task_detail = _task_detail(22)
    captured = {}

    def fork_task(*, db, source_task_id, user_id, request, client_origin):
        captured["source_task_id"] = source_task_id
        captured["user_id"] = user_id
        captured["request"] = request
        captured["client_origin"] = client_origin
        return SimpleNamespace(id=22)

    monkeypatch.setattr(
        "app.api.endpoints.adapter.tasks.task_fork_service",
        SimpleNamespace(fork_task=fork_task),
        raising=False,
    )
    monkeypatch.setattr(
        "app.api.endpoints.adapter.tasks.task_kinds_service.get_task_detail",
        lambda *, db, task_id, user_id, client_origin=None: task_detail,
    )

    response = task_fork_client.post(
        "/api/tasks/1/fork?client_origin=wework",
        json={"target": {"type": "managed"}},
    )

    assert response.status_code == 200
    assert response.json()["task_id"] == 22
    assert response.json()["task"]["id"] == 22
    assert captured == {
        "source_task_id": 1,
        "user_id": 7,
        "request": TaskForkRequest.model_validate({"target": {"type": "managed"}}),
        "client_origin": "wework",
    }


def test_fork_endpoint_preserves_service_error(task_fork_client, monkeypatch):
    def fork_task(*, db, source_task_id, user_id, request, client_origin):
        raise HTTPException(status_code=409, detail="task_is_running")

    monkeypatch.setattr(
        "app.api.endpoints.adapter.tasks.task_fork_service",
        SimpleNamespace(fork_task=fork_task),
        raising=False,
    )

    response = task_fork_client.post(
        "/api/tasks/1/fork?client_origin=wework",
        json={"target": {"type": "managed"}},
    )

    assert response.status_code == 409
    assert response.json()["detail"] == "task_is_running"
