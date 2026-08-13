# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the MR integration lifecycle service (hook reconcile + sweep)."""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from sqlalchemy.orm import Session

from app.models.cloud_project import CloudProject
from app.models.delivery import LoopItem
from app.models.gitlab_mr import MRIntegration, MRRecord
from app.models.user import User
from app.services.gitlab.client import ProjectScopedGitlabClient
from app.services.gitlab.integration_service import mr_integration_service
from app.services.gitlab.mr_service import mr_service

SHA1 = "a" * 40

DEFAULT_STATUSES = [
    {"id": "inbox", "name": "收集箱", "color": "gray"},
    {"id": "pending", "name": "待开始", "color": "blue"},
    {"id": "in_progress", "name": "进行中", "color": "orange"},
    {"id": "in_review", "name": "待确认", "color": "purple"},
    {"id": "completed", "name": "已完成", "color": "green"},
]


def _make_project(
    db: Session, user: User, repository: str = "group/project"
) -> CloudProject:
    project = CloudProject(
        public_id=str(uuid.uuid4()),
        project_key="PRJ",
        name="P",
        description="",
        created_by_user_id=user.id,
        status="active",
        next_item_number=1,
        metadata_json={
            "task_provider": "gitlab",
            "provider_config": {
                "repository": repository,
                "domain": "gitlab.internal",
                "api_base": "https://gitlab.internal/api/v4",
            },
            "board_config": {"group_by": "status", "statuses": DEFAULT_STATUSES},
        },
    )
    db.add(project)
    db.commit()
    return project


def _make_integration(db: Session, project: CloudProject, user: User) -> MRIntegration:
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
        gitlab_hook_id=111,
        created_by_user_id=user.id,
    )
    db.add(integration)
    db.commit()
    return integration


class FakeGitlab:
    def __init__(self) -> None:
        self.hooks: list[dict[str, Any]] = []
        self.open_mrs: list[dict[str, Any]] = []
        self.mr_detail: dict[str, Any] = {"state": "opened"}
        self.pipelines: list[dict[str, Any]] = []
        self.jobs: list[dict[str, Any]] = []
        self.notes: list[dict[str, Any]] = []
        self.traces: dict[str, str] = {}

    def text(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, object] | None = None,
        not_found_ok: bool = False,
    ) -> str | None:
        return self.traces.get(path, "")

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
        if method == "POST" and path.endswith("/hooks"):
            self.hooks = [{"id": 222}]
            return {"id": 222}
        if path.endswith("/hooks"):
            return list(self.hooks)
        if path.endswith("/merge_requests/1/notes"):
            return list(self.notes)
        if path.endswith("/merge_requests/1"):
            return dict(self.mr_detail)
        if path.endswith("/merge_requests"):
            return list(self.open_mrs)
        if "/pipelines/" in path and path.endswith("/jobs"):
            return list(self.jobs)
        if path.endswith("/pipelines"):
            return list(self.pipelines)
        return {}


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch, test_db: Session, test_user: User):
    project = _make_project(test_db, test_user)
    integration = _make_integration(test_db, project, test_user)
    fake = FakeGitlab()
    monkeypatch.setattr(ProjectScopedGitlabClient, "request", fake.request)
    monkeypatch.setattr(ProjectScopedGitlabClient, "text", fake.text)

    def fake_config(project_obj: CloudProject) -> tuple[dict[str, object], str]:
        metadata = (
            project_obj.metadata_json
            if isinstance(project_obj.metadata_json, dict)
            else {}
        )
        config = metadata.get("provider_config")
        return (dict(config) if isinstance(config, dict) else {}), "fake-token"

    monkeypatch.setattr(
        "app.services.gitlab.client.resolve_provider_config", fake_config
    )
    return {"db": test_db, "project": project, "integration": integration, "fake": fake}


def _mr_event(iid: int, state: str, sha: str) -> dict[str, Any]:
    return {
        "object_kind": "merge_request",
        "object_attributes": {
            "iid": iid,
            "state": state,
            "title": "X",
            "source_branch": "feat/x",
            "target_branch": "main",
            "author_id": 11,
            "url": f"https://gitlab.internal/group/project/-/merge_requests/{iid}",
            "last_commit": {"id": sha},
        },
    }


def test_reconcile_recreates_missing_hook(env: dict[str, Any]) -> None:
    db = env["db"]
    integration = env["integration"]
    assert integration.gitlab_hook_id == 111
    mr_integration_service.reconcile(db, integration)
    db.commit()
    assert integration.gitlab_hook_id == 222
    assert integration.status == "ok"


def test_reconcile_bootstraps_open_mr_with_no_pipeline(env: dict[str, Any]) -> None:
    db = env["db"]
    fake: FakeGitlab = env["fake"]
    fake.open_mrs = [
        {
            "iid": 1,
            "title": "X",
            "state": "opened",
            "source_branch": "feat/x",
            "target_branch": "main",
            "sha": SHA1,
            "web_url": "u",
            "author": {"id": 11, "username": "alice"},
        }
    ]
    fake.pipelines = []
    mr_integration_service.reconcile(db, env["integration"])
    db.commit()
    record = db.query(MRRecord).filter(MRRecord.mr_iid == 1).one()
    assert record.state == "clean"
    assert (
        db.query(LoopItem)
        .filter(LoopItem.cloud_project_id == str(env["project"].id))
        .first()
        is None
    )


def test_reconcile_closes_mr_that_merged_without_event(env: dict[str, Any]) -> None:
    db = env["db"]
    fake: FakeGitlab = env["fake"]
    integration = env["integration"]
    project = env["project"]
    mr_service.handle_merge_request_event(
        db, integration, project, _mr_event(1, "opened", SHA1)
    )
    fake.jobs = [{"id": 200, "name": "test", "stage": "test", "web_url": "u"}]
    fake.traces = {"/projects/group%2Fproject/jobs/200/trace": "boom"}
    fake.pipelines = []
    mr_service.handle_pipeline_event(
        db,
        integration,
        project,
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
    db.commit()
    assert (
        mr_service._get_or_bootstrap_record(db, integration, project, 1).state
        == "actionable"
    )

    # The MR is gone from the open list: reconcile should close the card.
    fake.open_mrs = []
    fake.mr_detail = {"state": "merged"}
    mr_integration_service.reconcile(db, integration)
    db.commit()
    record = mr_service._get_or_bootstrap_record(db, integration, project, 1)
    assert record.state == "closed"
    card = (
        db.query(LoopItem).filter(LoopItem.cloud_project_id == str(project.id)).first()
    )
    assert card is not None
    assert card.status == "completed"


def test_reconcile_marks_repository_drift(
    monkeypatch: pytest.MonkeyPatch,
    test_db: Session,
    test_user: User,
) -> None:
    project = _make_project(test_db, test_user, repository="new/repo")
    integration = _make_integration(test_db, project, test_user)

    def fake_config(project_obj: CloudProject) -> tuple[dict[str, object], str]:
        metadata = (
            project_obj.metadata_json
            if isinstance(project_obj.metadata_json, dict)
            else {}
        )
        config = metadata.get("provider_config")
        return (dict(config) if isinstance(config, dict) else {}), "fake-token"

    monkeypatch.setattr(
        "app.services.gitlab.client.resolve_provider_config", fake_config
    )
    mr_integration_service.reconcile(test_db, integration)
    test_db.commit()
    assert integration.status == "error"
    assert "Repository changed" in integration.last_error
