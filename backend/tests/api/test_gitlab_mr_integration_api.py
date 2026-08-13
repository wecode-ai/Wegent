# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""API tests for cloud-project GitLab MR integration management endpoints."""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.cloud_project import CloudProject
from app.models.gitlab_mr import MRIntegration
from app.models.user import User
from app.services.gitlab.client import ProjectScopedGitlabClient

DEFAULT_STATUSES = [
    {"id": "inbox", "name": "收集箱", "color": "gray"},
    {"id": "pending", "name": "待开始", "color": "blue"},
    {"id": "in_progress", "name": "进行中", "color": "orange"},
    {"id": "in_review", "name": "待确认", "color": "purple"},
    {"id": "completed", "name": "已完成", "color": "green"},
]


def _make_project(db: Session, user: User) -> CloudProject:
    project = CloudProject(
        public_id=str(uuid.uuid4()),
        project_key="MRPRJ",
        name="MR Project",
        description="",
        created_by_user_id=user.id,
        status="active",
        next_item_number=1,
        metadata_json={
            "project_store": "backend",
            "task_provider": "gitlab",
            "provider_config": {
                "repository": "group/project",
                "domain": "gitlab.internal",
                "api_base": "https://gitlab.internal/api/v4",
            },
            "board_config": {"group_by": "status", "statuses": DEFAULT_STATUSES},
        },
    )
    db.add(project)
    db.commit()
    return project


def _auth(test_token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {test_token}"}


@pytest.fixture
def fake_hooks(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    state: dict[str, Any] = {"hooks": [{"id": 123, "url": "https://gitlab.internal/x"}]}

    def fake_request(
        self,
        method: str,
        path: str,
        *,
        json: object | None = None,
        params: dict[str, object] | None = None,
        files: dict[str, object] | None = None,
        not_found_ok: bool = False,
    ) -> Any:
        if method == "POST" and path.endswith("/hooks"):
            state["hooks"] = [{"id": 456, "url": "https://gitlab.internal/y"}]
            return {"id": 456, "url": "https://gitlab.internal/y"}
        if method == "DELETE" and "/hooks/" in path:
            state["hooks"] = []
            return {}
        if path.endswith("/hooks"):
            return list(state["hooks"])
        return {}

    monkeypatch.setattr(ProjectScopedGitlabClient, "request", fake_request)
    monkeypatch.setattr(
        "app.services.gitlab.client.resolve_provider_config",
        lambda project: (
            {"repository": "group/project", "domain": "gitlab.internal"},
            "fake-token",
        ),
    )
    return state


def test_enable_installs_hook(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
    fake_hooks: dict[str, Any],
) -> None:
    project = _make_project(test_db, test_user)
    response = test_client.post(
        f"/api/v1/cloud-projects/{project.id}/gitlab/mr-integration",
        headers=_auth(test_token),
    )
    assert response.status_code == 200
    body = response.json()
    assert body["enabled"] is True
    assert body["repository"] == "group/project"
    assert body["hook_id"] == 456
    assert "/v1/webhooks/gitlab/mr/" in body["webhook_url"]
    row = (
        test_db.query(MRIntegration)
        .filter(MRIntegration.cloud_project_id == str(project.id))
        .one()
    )
    assert row.enabled is True
    assert row.created_by_user_id == test_user.id


def test_status_reports_enabled_with_hook(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
    fake_hooks: dict[str, Any],
) -> None:
    project = _make_project(test_db, test_user)
    test_client.post(
        f"/api/v1/cloud-projects/{project.id}/gitlab/mr-integration",
        headers=_auth(test_token),
    )
    response = test_client.get(
        f"/api/v1/cloud-projects/{project.id}/gitlab/mr-integration",
        headers=_auth(test_token),
    )
    assert response.status_code == 200
    body = response.json()
    assert body["enabled"] is True
    assert body["hook_installed"] is True
    assert body["status"] == "ok"


def test_disable_removes_hook_and_records(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
    fake_hooks: dict[str, Any],
) -> None:
    project = _make_project(test_db, test_user)
    test_client.post(
        f"/api/v1/cloud-projects/{project.id}/gitlab/mr-integration",
        headers=_auth(test_token),
    )
    response = test_client.delete(
        f"/api/v1/cloud-projects/{project.id}/gitlab/mr-integration",
        headers=_auth(test_token),
    )
    assert response.status_code == 204
    status_response = test_client.get(
        f"/api/v1/cloud-projects/{project.id}/gitlab/mr-integration",
        headers=_auth(test_token),
    )
    assert status_response.json()["enabled"] is False
    assert fake_hooks["hooks"] == []


def test_non_gitlab_project_conflict(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
    fake_hooks: dict[str, Any],
) -> None:
    project = CloudProject(
        public_id=str(uuid.uuid4()),
        project_key="LOCAL",
        name="Local",
        description="",
        created_by_user_id=test_user.id,
        status="active",
        next_item_number=1,
        metadata_json={"task_provider": "local"},
    )
    test_db.add(project)
    test_db.commit()
    response = test_client.post(
        f"/api/v1/cloud-projects/{project.id}/gitlab/mr-integration",
        headers=_auth(test_token),
    )
    assert response.status_code == 409
