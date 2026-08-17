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
from app.models.delivery import LoopItem, ProjectAutomationRule, ProjectChatAgent
from app.models.gitlab_mr import MRIntegration
from app.models.kind import Kind
from app.models.loop_item_execution import LoopItemExecution
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


def test_process_gitlab_event_reraises_instead_of_swallowing(
    monkeypatch: pytest.MonkeyPatch,
    env: dict[str, Any],
) -> None:
    """A failed webhook apply must surface for celery retry, not ack as ok."""
    import contextlib

    from app.db import session as db_session_module
    from app.tasks.gitlab_mr_tasks import process_gitlab_event

    monkeypatch.setattr(
        db_session_module,
        "get_db_session",
        lambda: contextlib.nullcontext(env["db"]),
    )

    def boom(db, integration_id, event_kind, payload):
        raise RuntimeError("transient provider failure")

    monkeypatch.setattr("app.tasks.gitlab_mr_tasks._process_integration_event", boom)
    with pytest.raises(RuntimeError):
        process_gitlab_event(env["integration"].id, "merge_request", {})


def _create_card(db: Session, integration: MRIntegration, fake: FakeGitlab) -> None:
    """Bootstrap the MR and drive a failed pipeline so a fix card is created."""
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


def _note_payload(note_id: int, body: str) -> dict[str, Any]:
    return {
        "object_kind": "note",
        "object_attributes": {
            "id": note_id,
            "noteable_type": "MergeRequest",
            "system": False,
            "note": body,
            "author": {"username": "alice"},
            "url": f"https://gitlab.internal/group/project/-/merge_requests/1#note_{note_id}",
        },
        "merge_request": {"iid": 1},
    }


def test_card_create_emits_task_created_event(
    env: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A freshly created MR fix card must notify the assignment flow once."""
    db = env["db"]
    emitted: list[Any] = []
    monkeypatch.setattr(
        "app.tasks.gitlab_mr_tasks._emit_task_created_event",
        lambda _db, _integration, record: emitted.append(record),
    )

    _create_card(db, env["integration"], env["fake"])

    assert len(emitted) == 1


def test_card_update_does_not_emit_task_created_event_again(
    env: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """New feedback on an existing card updates it in place; the automation
    assignment flow is only entered once at creation."""
    db = env["db"]
    emitted: list[Any] = []
    monkeypatch.setattr(
        "app.tasks.gitlab_mr_tasks._emit_task_created_event",
        lambda _db, _integration, record: emitted.append(record),
    )

    _create_card(db, env["integration"], env["fake"])
    _process_integration_event(
        db, env["integration"].id, "note", _note_payload(12, "please fix")
    )

    assert len(emitted) == 1


def test_emit_task_created_event_payload(
    env: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The emitted task.created event carries the fields automation rules match
    on (source/status/priority/tags) plus the MR identity."""
    from app.services.project_automations import project_automation_processor

    captured: list[Any] = []

    async def fake_process(_db, event, *, automation_id=None) -> int:
        captured.append(event)
        return 0

    monkeypatch.setattr(project_automation_processor, "process", fake_process)

    db = env["db"]
    _create_card(db, env["integration"], env["fake"])

    assert len(captured) == 1
    event = captured[0]
    assert event.event_type == "task.created"
    assert event.source == "gitlab"
    assert event.payload["tags"] == ["mr-fix"]
    assert event.payload["status"] == "inbox"
    assert event.payload["priority"] == "none"
    card = (
        db.query(LoopItem)
        .filter(LoopItem.cloud_project_id == str(env["project"].id))
        .one()
    )
    assert event.subject_id == card.id
    assert event.payload["mr_iid"] == 1


def test_manual_rule_assigns_mr_card_to_robot(
    env: dict[str, Any],
    test_db: Session,
    test_user: User,
) -> None:
    """A manual assignment rule matching the MR card must queue a project-robot
    run through the real processor (end to end)."""
    db = env["db"]
    project = env["project"]
    integration = env["integration"]

    device_id = f"local-{uuid.uuid4().hex[:10]}"
    db.add(
        Kind(
            kind="Device",
            name=device_id,
            namespace="default",
            user_id=test_user.id,
            is_active=True,
            json={"spec": {"deviceType": "local"}},
        )
    )
    bot = ProjectChatAgent(
        id=f"B{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        title="MR Fix Bot",
        name="MR Fix Bot",
        status="active",
        created_by_user_id=test_user.id,
        device_id=device_id,
        metadata_json={
            "runtime": "codex",
            "execution_mode": "auto",
            "execution_environment": "local",
            "visibility": "public",
        },
    )
    rule = ProjectAutomationRule(
        id=f"rule-{uuid.uuid4().hex[:8]}",
        cloud_project_id=project.id,
        title="MR fix rule",
        description="Assign MR fix cards",
        status="enabled",
        assignee_agent_id=bot.id,
        created_by_user_id=test_user.id,
        metadata_json={
            "assignment_mode": "manual",
            "trigger_type": "event",
            "event_type": "task.created",
            "event_config": {"sources": ["gitlab"], "tags": ["mr-fix"]},
        },
    )
    db.add_all([bot, rule])
    db.commit()

    _create_card(db, integration, env["fake"])

    card = db.query(LoopItem).filter(LoopItem.cloud_project_id == str(project.id)).one()
    execution = (
        db.query(LoopItemExecution)
        .filter(LoopItemExecution.loop_item_id == card.id)
        .first()
    )
    assert execution is not None
    assert execution.executor_type == "project_robot"
    assert execution.status in {"queued", "pending_approval"}


def test_process_integration_event_ignores_archived_project(
    env: dict[str, Any],
    test_db: Session,
) -> None:
    """A webhook that lingers after the project was archived must not touch the
    board."""
    db = env["db"]
    env["project"].status = "archived"
    test_db.commit()

    _process_integration_event(
        db,
        env["integration"].id,
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

    card = (
        db.query(LoopItem)
        .filter(LoopItem.cloud_project_id == str(env["project"].id))
        .first()
    )
    assert card is None


def test_reconcile_skips_archived_projects(
    env: dict[str, Any],
    test_db: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Reconcile must not revive integrations of archived projects."""
    import contextlib

    from app.db import session as db_session_module
    from app.tasks.gitlab_mr_tasks import reconcile_gitlab_mr_integrations

    env["project"].status = "archived"
    test_db.commit()
    monkeypatch.setattr(
        db_session_module,
        "get_db_session",
        lambda: contextlib.nullcontext(env["db"]),
    )

    assert reconcile_gitlab_mr_integrations() == {
        "status": "ok",
        "reconciled": 0,
    }
