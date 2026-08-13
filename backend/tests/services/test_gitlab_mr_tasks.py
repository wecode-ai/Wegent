# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""End-to-end test of the Celery event-processing path."""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from sqlalchemy.orm import Session

from app.models.cloud_project import CloudProject
from app.models.delivery import LoopItem
from app.models.gitlab_mr import MRIntegration
from app.models.user import User
from app.services.gitlab.client import ProjectScopedGitlabClient
from app.tasks.gitlab_mr_tasks import _process_integration_event

SHA1 = "a" * 40

DEFAULT_STATUSES = [
    {"id": "inbox", "name": "收集箱", "color": "gray"},
    {"id": "pending", "name": "待开始", "color": "blue"},
    {"id": "in_progress", "name": "进行中", "color": "orange"},
    {"id": "in_review", "name": "待确认", "color": "purple"},
    {"id": "completed", "name": "已完成", "color": "green"},
]


class FakeGitlab:
    def __init__(self) -> None:
        self.jobs: list[dict[str, Any]] = []
        self.notes: list[dict[str, Any]] = []
        self.traces: dict[str, str] = {}

    def request(
        self,
        method: str,
        path: str,
        *,
        json: object | None = None,
        params: dict[str, object] | None = None,
        files: dict[str, object] | None = None,
        not_found_ok: bool = False,
    ) -> Any:
        if "/pipelines/" in path and path.endswith("/jobs"):
            return list(self.jobs)
        if path.endswith("/merge_requests/1/notes"):
            return list(self.notes)
        return {}

    def text(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, object] | None = None,
        not_found_ok: bool = False,
    ) -> str | None:
        return self.traces.get(path, "")


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch, test_db: Session, test_user: User):
    project = CloudProject(
        public_id=str(uuid.uuid4()),
        project_key="PRJ",
        name="P",
        description="",
        created_by_user_id=test_user.id,
        status="active",
        next_item_number=1,
        metadata_json={
            "task_provider": "gitlab",
            "provider_config": {
                "repository": "group/project",
                "domain": "gitlab.internal",
                "api_base": "https://gitlab.internal/api/v4",
            },
            "board_config": {"group_by": "status", "statuses": DEFAULT_STATUSES},
        },
    )
    test_db.add(project)
    test_db.flush()
    integration = MRIntegration(
        cloud_project_id=str(project.id),
        project_key=project.project_key,
        repository="group/project",
        domain="gitlab.internal",
        api_base="https://gitlab.internal/api/v4",
        webhook_token="tok",
        webhook_secret="z",
        enabled=True,
        status="ok",
        created_by_user_id=test_user.id,
    )
    test_db.add(integration)
    test_db.commit()
    fake = FakeGitlab()
    monkeypatch.setattr(ProjectScopedGitlabClient, "request", fake.request)
    monkeypatch.setattr(ProjectScopedGitlabClient, "text", fake.text)
    monkeypatch.setattr(
        "app.services.gitlab.client.resolve_provider_config",
        lambda project_obj: (
            {
                "repository": "group/project",
                "domain": "gitlab.internal",
            },
            "fake-token",
        ),
    )
    return {"db": test_db, "project": project, "integration": integration, "fake": fake}


def test_event_processing_creates_card(
    env: dict[str, Any],
) -> None:
    db = env["db"]
    integration = env["integration"]
    fake: FakeGitlab = env["fake"]

    _process_integration_event(
        db,
        integration.id,
        "merge_request",
        {
            "object_kind": "merge_request",
            "object_attributes": {
                "iid": 1,
                "state": "opened",
                "title": "X",
                "source_branch": "feat/x",
                "target_branch": "main",
                "author_id": 11,
                "url": "https://gitlab.internal/group/project/-/merge_requests/1",
                "last_commit": {"id": SHA1},
            },
        },
    )
    fake.jobs = [{"id": 200, "name": "test", "stage": "test", "web_url": "u"}]
    fake.traces = {"/projects/group%2Fproject/jobs/200/trace": "boom"}
    _process_integration_event(
        db,
        integration.id,
        "pipeline",
        {
            "object_kind": "pipeline",
            "object_attributes": {
                "id": 100,
                "sha": SHA1,
                "status": "failed",
                "ref": "feat/x",
            },
        },
    )
    card = (
        db.query(LoopItem)
        .filter(LoopItem.cloud_project_id == str(env["project"].id))
        .first()
    )
    assert card is not None
    assert card.status == "inbox"
    assert "boom" in card.description
    assert card.source_task_binding_id == "gitlab:mr:group/project:1"
