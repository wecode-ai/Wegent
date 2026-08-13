# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""State machine tests for the GitLab MR -> board fix-task loop."""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.cloud_project import CloudProject
from app.models.delivery import LoopItem, ProjectChatAgent
from app.models.gitlab_mr import MRIntegration, MRRecord
from app.models.loop_item_execution import LoopItemExecution
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.user import User
from app.schemas.base_role import BaseRole
from app.services.gitlab.client import ProjectScopedGitlabClient
from app.services.gitlab.mr_service import mr_service
from app.services.gitlab.mr_templates import render_card_description, trace_tail
from app.services.loop_items.external_provider import external_loop_item_provider
from app.services.loop_items.service import loop_item_service

SHA1 = "a" * 40
SHA2 = "b" * 40
SHA3 = "c" * 40

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
        project_key="PRJTEST",
        name="Test Project",
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
    db.flush()
    return project


def _make_integration(db: Session, project: CloudProject, user: User) -> MRIntegration:
    integration = MRIntegration(
        cloud_project_id=str(project.id),
        project_key=project.project_key,
        repository="group/project",
        domain="gitlab.internal",
        api_base="https://gitlab.internal/api/v4",
        webhook_token="webhook-token-1",
        webhook_secret="s3cret",
        enabled=True,
        status="ok",
        created_by_user_id=user.id,
    )
    db.add(integration)
    db.flush()
    return integration


class FakeGitlab:
    def __init__(self) -> None:
        self.pipelines: list[dict[str, Any]] = []
        self.jobs: list[dict[str, Any]] = []
        self.notes: list[dict[str, Any]] = []
        self.traces: dict[str, str] = {}
        self.mr: dict[str, Any] = {
            "state": "opened",
            "title": "Add feature",
            "source_branch": "feat/x",
            "target_branch": "main",
            "web_url": "https://gitlab.internal/group/project/-/merge_requests/1",
            "sha": SHA1,
            "description": "",
            "author": {"id": 11, "username": "alice"},
        }

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
        if path.endswith("/merge_requests/1/notes"):
            return list(self.notes)
        if path.endswith("/merge_requests/1"):
            return dict(self.mr)
        if "/pipelines/" in path and path.endswith("/jobs"):
            return list(self.jobs)
        if path.endswith("/pipelines"):
            return list(self.pipelines)
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
    project = _make_project(test_db, test_user)
    integration = _make_integration(test_db, project, test_user)
    fake = FakeGitlab()
    monkeypatch.setattr(ProjectScopedGitlabClient, "request", fake.request)
    monkeypatch.setattr(ProjectScopedGitlabClient, "text", fake.text)
    monkeypatch.setattr(
        "app.services.gitlab.client.resolve_provider_config",
        lambda project: (
            {"repository": "group/project", "domain": "gitlab.internal"},
            "fake-token",
        ),
    )
    return {
        "db": test_db,
        "project": project,
        "integration": integration,
        "fake": fake,
    }


def _mr_event(iid: int, state: str, sha: str, branch: str = "feat/x") -> dict[str, Any]:
    return {
        "object_kind": "merge_request",
        "object_attributes": {
            "iid": iid,
            "state": state,
            "title": "Add feature",
            "source_branch": branch,
            "target_branch": "main",
            "author_id": 11,
            "url": f"https://gitlab.internal/group/project/-/merge_requests/{iid}",
            "last_commit": {"id": sha},
            "description": "",
        },
    }


def _pipeline_event(
    sha: str, status: str, pipeline_id: int = 100, ref: str = "feat/x"
) -> dict[str, Any]:
    return {
        "object_kind": "pipeline",
        "object_attributes": {
            "id": pipeline_id,
            "sha": sha,
            "status": status,
            "ref": ref,
        },
    }


def _note_event(
    iid: int, note_id: int, body: str, author: str = "alice"
) -> dict[str, Any]:
    return {
        "object_kind": "note",
        "object_attributes": {
            "id": note_id,
            "noteable_type": "MergeRequest",
            "system": False,
            "note": body,
            "author": {"username": author},
            "url": f"https://gitlab.internal/group/project/-/merge_requests/{iid}#note_{note_id}",
        },
        "merge_request": {"iid": iid},
    }


def _record(db: Session, integration: MRIntegration) -> MRRecord:
    return (
        db.query(MRRecord)
        .filter(MRRecord.integration_id == integration.id, MRRecord.mr_iid == 1)
        .one()
    )


def _card(db: Session, project: CloudProject) -> LoopItem | None:
    return (
        db.query(LoopItem).filter(LoopItem.cloud_project_id == str(project.id)).first()
    )


def test_open_mr_creates_evaluating_round(env: dict[str, Any]) -> None:
    db = env["db"]
    mr_service.handle_merge_request_event(
        db, env["integration"], env["project"], _mr_event(1, "opened", SHA1)
    )
    db.commit()
    record = _record(db, env["integration"])
    assert record.state == "evaluating"
    assert record.head_sha == SHA1
    assert record.round_number == 1
    assert _card(db, env["project"]) is None  # no feedback yet -> no card


def test_failed_pipeline_creates_card(env: dict[str, Any]) -> None:
    db = env["db"]
    fake: FakeGitlab = env["fake"]
    mr_service.handle_merge_request_event(
        db, env["integration"], env["project"], _mr_event(1, "opened", SHA1)
    )
    fake.jobs = [
        {"id": 200, "name": "test", "stage": "test", "web_url": "https://x/job/200"}
    ]
    fake.traces = {
        "/projects/group%2Fproject/jobs/200/trace": "line1\nline2\nAssertionError: boom"
    }
    mr_service.handle_pipeline_event(
        db, env["integration"], env["project"], _pipeline_event(SHA1, "failed")
    )
    db.commit()
    record = _record(db, env["integration"])
    assert record.state == "actionable"
    card = _card(db, env["project"])
    assert card is not None
    assert card.status == "inbox"
    assert "AssertionError" in card.description
    assert card.source == "gitlab"
    assert card.source_task_binding_id == "gitlab:mr:group/project:1"


def test_success_pipeline_with_notes_is_actionable(env: dict[str, Any]) -> None:
    db = env["db"]
    fake: FakeGitlab = env["fake"]
    mr_service.handle_merge_request_event(
        db, env["integration"], env["project"], _mr_event(1, "opened", SHA1)
    )
    fake.notes = [
        {
            "id": 5,
            "system": False,
            "body": "please rename X",
            "author": {"username": "bob"},
            "web_url": "https://x#note_5",
        }
    ]
    mr_service.handle_pipeline_event(
        db, env["integration"], env["project"], _pipeline_event(SHA1, "success")
    )
    db.commit()
    card = _card(db, env["project"])
    assert card is not None
    assert card.status == "inbox"
    assert "please rename X" in card.description


def test_note_during_evaluating_is_ignored(env: dict[str, Any]) -> None:
    db = env["db"]
    mr_service.handle_merge_request_event(
        db, env["integration"], env["project"], _mr_event(1, "opened", SHA1)
    )
    mr_service.handle_note_event(
        db,
        env["integration"],
        env["project"],
        _note_event(1, 5, "comment while CI runs"),
    )
    db.commit()
    assert _card(db, env["project"]) is None


def test_note_after_clean_creates_card(env: dict[str, Any]) -> None:
    db = env["db"]
    fake: FakeGitlab = env["fake"]
    mr_service.handle_merge_request_event(
        db, env["integration"], env["project"], _mr_event(1, "opened", SHA1)
    )
    fake.pipelines = []
    # settle_by_reconcile with no pipeline -> finalize as success -> clean
    record = _record(db, env["integration"])
    mr_service.settle_by_reconcile(db, env["integration"], env["project"], record)
    db.commit()
    assert _card(db, env["project"]) is None
    mr_service.handle_note_event(
        db, env["integration"], env["project"], _note_event(1, 9, "late review comment")
    )
    db.commit()
    card = _card(db, env["project"])
    assert card is not None
    assert card.status == "inbox"
    assert "late review comment" in card.description


def test_fix_push_moves_card_to_in_review_then_failure_updates(
    env: dict[str, Any],
) -> None:
    db = env["db"]
    fake: FakeGitlab = env["fake"]
    mr_service.handle_merge_request_event(
        db, env["integration"], env["project"], _mr_event(1, "opened", SHA1)
    )
    fake.jobs = [{"id": 200, "name": "test", "stage": "test", "web_url": "https://x"}]
    fake.traces = {"/projects/group%2Fproject/jobs/200/trace": "boom 1"}
    mr_service.handle_pipeline_event(
        db, env["integration"], env["project"], _pipeline_event(SHA1, "failed")
    )
    db.commit()
    card = _card(db, env["project"])
    assert card.status == "inbox"

    # human pushes a fix -> new round, card moves to in_review
    mr_service.handle_merge_request_event(
        db, env["integration"], env["project"], _mr_event(1, "opened", SHA2)
    )
    db.commit()
    card = _card(db, env["project"])
    assert card.status == "in_review"
    record = _record(db, env["integration"])
    assert record.round_number == 2

    # round 2 fails too -> card updated back to in_progress, rounds accumulate
    fake.traces = {"/projects/group%2Fproject/jobs/200/trace": "boom 2"}
    fake.pipelines = []
    mr_service.handle_pipeline_event(
        db,
        env["integration"],
        env["project"],
        _pipeline_event(SHA2, "failed", pipeline_id=101),
    )
    db.commit()
    card = _card(db, env["project"])
    assert card.status == "in_progress"
    assert "boom 2" in card.description
    assert "R2" in card.description


def test_trace_tail_strips_ansi_escapes() -> None:
    raw = "\x1b[0Ksection_start\x1b[36;1m Preparing runner \x1b[0;m\nAssertionError: boom\n"
    cleaned = trace_tail(raw)
    assert "\x1b[" not in cleaned
    assert "AssertionError: boom" in cleaned


def test_mr_card_appears_in_external_board_list(
    env: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    db = env["db"]
    fake: FakeGitlab = env["fake"]
    mr_service.handle_merge_request_event(
        db, env["integration"], env["project"], _mr_event(1, "opened", SHA1)
    )
    fake.jobs = [{"id": 200, "name": "test", "stage": "test", "web_url": "https://x"}]
    fake.traces = {"/projects/group%2Fproject/jobs/200/trace": "boom"}
    mr_service.handle_pipeline_event(
        db, env["integration"], env["project"], _pipeline_event(SHA1, "failed")
    )
    db.commit()
    monkeypatch.setattr(external_loop_item_provider, "_list_issues", lambda project: [])
    items = external_loop_item_provider.list(
        db, env["project"].id, env["integration"].created_by_user_id
    )
    assert any(
        item.get("source_task_binding_id") == "gitlab:mr:group/project:1"
        for item in items
    )


def test_rounds_json_persisted_after_finalize(env: dict[str, Any]) -> None:
    db = env["db"]
    fake: FakeGitlab = env["fake"]
    mr_service.handle_merge_request_event(
        db, env["integration"], env["project"], _mr_event(1, "opened", SHA1)
    )
    fake.jobs = [{"id": 200, "name": "test", "stage": "test", "web_url": "u"}]
    fake.traces = {"/projects/group%2Fproject/jobs/200/trace": "boom"}
    mr_service.handle_pipeline_event(
        db, env["integration"], env["project"], _pipeline_event(SHA1, "failed")
    )
    db.commit()
    # JSON columns do not track in-place nested mutations: the round entry must
    # survive a re-query so later re-renders do not lose the feedback.
    record = _record(db, env["integration"])
    stored_round = record.rounds_json[-1]
    assert stored_round["pipeline_status"] == "failed"
    assert stored_round["failed_jobs"]


def test_render_falls_back_to_previous_round_notes(env: dict[str, Any]) -> None:
    db = env["db"]
    fake: FakeGitlab = env["fake"]
    mr_service.handle_merge_request_event(
        db, env["integration"], env["project"], _mr_event(1, "opened", SHA1)
    )
    fake.jobs = [{"id": 200, "name": "test", "stage": "test", "web_url": "u"}]
    fake.traces = {"/projects/group%2Fproject/jobs/200/trace": "boom"}
    fake.notes = [
        {
            "id": 5,
            "system": False,
            "body": "please rename X",
            "author": {"username": "bob"},
            "web_url": "u",
        }
    ]
    mr_service.handle_pipeline_event(
        db, env["integration"], env["project"], _pipeline_event(SHA1, "failed")
    )
    db.commit()
    # New push -> round 2 is pending (no notes yet); round 1's review comment
    # must stay visible instead of being pushed out.
    mr_service.handle_merge_request_event(
        db, env["integration"], env["project"], _mr_event(1, "opened", SHA2)
    )
    db.commit()
    record = _record(db, env["integration"])
    desc = render_card_description(record)
    assert "please rename X" in desc
    assert "待处理" in desc


def test_clean_finalize_refreshes_card_description(env: dict[str, Any]) -> None:
    db = env["db"]
    fake: FakeGitlab = env["fake"]
    mr_service.handle_merge_request_event(
        db, env["integration"], env["project"], _mr_event(1, "opened", SHA1)
    )
    fake.jobs = [{"id": 200, "name": "test", "stage": "test", "web_url": "u"}]
    fake.traces = {"/projects/group%2Fproject/jobs/200/trace": "boom"}
    mr_service.handle_pipeline_event(
        db, env["integration"], env["project"], _pipeline_event(SHA1, "failed")
    )
    db.commit()
    # Fix push -> round 2; CI passes with no comments -> clean, but the existing
    # card must be refreshed to show the green result.
    mr_service.handle_merge_request_event(
        db, env["integration"], env["project"], _mr_event(1, "opened", SHA2)
    )
    fake.jobs = []
    mr_service.handle_pipeline_event(
        db, env["integration"], env["project"], _pipeline_event(SHA2, "success")
    )
    db.commit()
    record = _record(db, env["integration"])
    assert record.state == "clean"
    card = _card(db, env["project"])
    assert card is not None
    assert card.status == "in_review"
    assert "CI 状态：success" in card.description


def test_only_new_comments_keep_card_actionable(env: dict[str, Any]) -> None:
    db = env["db"]
    fake: FakeGitlab = env["fake"]
    # Round 1: CI failed + comment c1 -> actionable, card created
    mr_service.handle_merge_request_event(
        db, env["integration"], env["project"], _mr_event(1, "opened", SHA1)
    )
    fake.jobs = [{"id": 200, "name": "test", "stage": "test", "web_url": "u"}]
    fake.traces = {"/projects/group%2Fproject/jobs/200/trace": "boom"}
    fake.notes = [
        {
            "id": 5,
            "system": False,
            "body": "c1",
            "author": {"username": "bob"},
            "web_url": "u",
        }
    ]
    mr_service.handle_pipeline_event(
        db, env["integration"], env["project"], _pipeline_event(SHA1, "failed")
    )
    db.commit()
    # Round 2: fix push + CI success; only the OLD comment remains -> clean,
    # the card should stay in review instead of bouncing back to in-progress.
    mr_service.handle_merge_request_event(
        db, env["integration"], env["project"], _mr_event(1, "opened", SHA2)
    )
    fake.jobs = []
    mr_service.handle_pipeline_event(
        db, env["integration"], env["project"], _pipeline_event(SHA2, "success")
    )
    db.commit()
    record = _record(db, env["integration"])
    assert record.state == "clean"
    card = _card(db, env["project"])
    assert card.status == "in_review"
    # A brand-new comment in the current round makes it actionable again.
    mr_service.handle_note_event(
        db, env["integration"], env["project"], _note_event(1, 6, "c2 new")
    )
    db.commit()
    record = _record(db, env["integration"])
    assert record.state == "actionable"
    card = _card(db, env["project"])
    assert card.status == "in_progress"


def test_finalize_degrades_gracefully_on_fetch_failure(
    env: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    db = env["db"]
    mr_service.handle_merge_request_event(
        db, env["integration"], env["project"], _mr_event(1, "opened", SHA1)
    )

    def failing_request(
        self,
        method: str,
        path: str,
        *,
        json: object | None = None,
        params: dict[str, object] | None = None,
        files: dict[str, object] | None = None,
        not_found_ok: bool = False,
    ) -> Any:
        raise RuntimeError("transient network failure")

    monkeypatch.setattr(ProjectScopedGitlabClient, "request", failing_request)
    mr_service.handle_pipeline_event(
        db, env["integration"], env["project"], _pipeline_event(SHA1, "failed")
    )
    db.commit()
    record = _record(db, env["integration"])
    # The pipeline result is still recorded and the card updated even though the
    # jobs/notes fetch failed; reconcile re-fetches the round later.
    assert record.state == "actionable"
    assert record.rounds_json[-1]["pipeline_status"] == "failed"
    assert record.rounds_json[-1]["fetch_error"] is True
    card = _card(db, env["project"])
    assert card is not None
    assert card.status == "inbox"


def test_card_description_includes_task_instruction(env: dict[str, Any]) -> None:
    db = env["db"]
    fake: FakeGitlab = env["fake"]
    mr_service.handle_merge_request_event(
        db, env["integration"], env["project"], _mr_event(1, "opened", SHA1)
    )
    fake.jobs = [{"id": 200, "name": "test", "stage": "test", "web_url": "u"}]
    fake.traces = {"/projects/group%2Fproject/jobs/200/trace": "boom"}
    mr_service.handle_pipeline_event(
        db, env["integration"], env["project"], _pipeline_event(SHA1, "failed")
    )
    db.commit()
    card = _card(db, env["project"])
    assert "### 任务" in card.description
    assert "MR 修复任务" in card.description
    assert "repo: group/project" in card.description
    # Closing re-renders the instruction to the merged/closed form.
    mr_service.handle_merge_request_event(
        db, env["integration"], env["project"], _mr_event(1, "merged", SHA1)
    )
    db.commit()
    card = _card(db, env["project"])
    assert "已合并/关闭" in card.description


def test_mr_card_is_not_external_item(env: dict[str, Any]) -> None:
    db = env["db"]
    fake: FakeGitlab = env["fake"]
    mr_service.handle_merge_request_event(
        db, env["integration"], env["project"], _mr_event(1, "opened", SHA1)
    )
    fake.jobs = [{"id": 200, "name": "test", "stage": "test", "web_url": "u"}]
    fake.traces = {"/projects/group%2Fproject/jobs/200/trace": "boom"}
    mr_service.handle_pipeline_event(
        db, env["integration"], env["project"], _pipeline_event(SHA1, "failed")
    )
    db.commit()
    card = _card(db, env["project"])
    # MR cards share the <project_key>-<number> id shape but must route to the
    # internal board provider, not the external GitLab-issue provider.
    assert external_loop_item_provider.is_external_item(db, card.id) is False


def test_assign_guard_allows_mr_card_in_gitlab_project(
    env: dict[str, Any],
) -> None:
    db = env["db"]
    fake: FakeGitlab = env["fake"]
    mr_service.handle_merge_request_event(
        db, env["integration"], env["project"], _mr_event(1, "opened", SHA1)
    )
    fake.jobs = [{"id": 200, "name": "test", "stage": "test", "web_url": "u"}]
    fake.traces = {"/projects/group%2Fproject/jobs/200/trace": "boom"}
    mr_service.handle_pipeline_event(
        db, env["integration"], env["project"], _pipeline_event(SHA1, "failed")
    )
    db.commit()
    card = _card(db, env["project"])
    user_id = env["integration"].created_by_user_id
    # The gitlab project alone is rejected by the internal-task guard...
    with pytest.raises(HTTPException) as exc:
        loop_item_service._require_internal_task_project(
            db, env["project"].id, user_id, BaseRole.Reporter
        )
    assert exc.value.status_code == 409
    # ...but an MR fix-task card in it is allowed (so robots can be assigned).
    access = loop_item_service._require_internal_task_project(
        db, env["project"].id, user_id, BaseRole.Reporter, item_id=card.id
    )
    assert access.project.id == env["project"].id


def test_resolve_task_context_uses_internal_path_for_mr_card(
    env: dict[str, Any],
) -> None:
    from app.services.loop_item_executions.service import (
        loop_item_execution_service,
    )

    db = env["db"]
    fake: FakeGitlab = env["fake"]
    mr_service.handle_merge_request_event(
        db, env["integration"], env["project"], _mr_event(1, "opened", SHA1)
    )
    fake.jobs = [{"id": 200, "name": "test", "stage": "test", "web_url": "u"}]
    fake.traces = {"/projects/group%2Fproject/jobs/200/trace": "boom"}
    mr_service.handle_pipeline_event(
        db, env["integration"], env["project"], _pipeline_event(SHA1, "failed")
    )
    db.commit()
    card = _card(db, env["project"])
    execution = LoopItemExecution(
        loop_item_id=card.id,
        cloud_project_id=str(env["project"].id),
        status="queued",
    )
    db.add(execution)
    db.commit()
    ctx = loop_item_execution_service.resolve_task_context(
        db,
        execution=execution,
        user_id=env["integration"].created_by_user_id,
    )
    assert ctx is not None
    assert ctx.id == card.id
    assert "MR !1" in ctx.title
    assert "任务" in ctx.description


def test_instruction_distinguishes_ci_passed_with_comments(
    env: dict[str, Any],
) -> None:
    db = env["db"]
    fake: FakeGitlab = env["fake"]
    # Round 1: CI failed + comment c1 -> fix-instruction.
    mr_service.handle_merge_request_event(
        db, env["integration"], env["project"], _mr_event(1, "opened", SHA1)
    )
    fake.jobs = [{"id": 200, "name": "test", "stage": "test", "web_url": "u"}]
    fake.traces = {"/projects/group%2Fproject/jobs/200/trace": "boom"}
    fake.notes = [
        {
            "id": 5,
            "system": False,
            "body": "c1",
            "author": {"username": "bob"},
            "web_url": "u",
        }
    ]
    mr_service.handle_pipeline_event(
        db, env["integration"], env["project"], _pipeline_event(SHA1, "failed")
    )
    db.commit()
    # Round 2: fix push, CI success but a NEW comment c2 -> actionable with a
    # "CI passed, still new comments" instruction instead of the fix-CI one.
    mr_service.handle_merge_request_event(
        db, env["integration"], env["project"], _mr_event(1, "opened", SHA2)
    )
    fake.jobs = []
    fake.notes = [
        {
            "id": 5,
            "system": False,
            "body": "c1",
            "author": {"username": "bob"},
            "web_url": "u",
        },
        {
            "id": 6,
            "system": False,
            "body": "c2 new",
            "author": {"username": "bob"},
            "web_url": "u",
        },
    ]
    mr_service.handle_pipeline_event(
        db, env["integration"], env["project"], _pipeline_event(SHA2, "success")
    )
    db.commit()
    record = _record(db, env["integration"])
    assert record.state == "actionable"
    assert record.pipeline_status == "success"
    card = _card(db, env["project"])
    task = card.description[
        card.description.find("### 任务")
        + len("### 任务") : card.description.find("### 评审意见")
    ]
    assert "CI 已通过" in task
    assert "新的评审意见" in task


def test_retrigger_creates_run_then_respects_cap(env: dict[str, Any]) -> None:
    db = env["db"]
    fake: FakeGitlab = env["fake"]
    agent = ProjectChatAgent(
        id=f"B{uuid.uuid4().hex[:10]}",
        cloud_project_id=str(env["project"].id),
        title="FixBot",
        name="FixBot",
        status="active",
        created_by_user_id=env["integration"].created_by_user_id,
        metadata_json={"execution_mode": "auto", "execution_environment": "local"},
    )
    db.add(agent)
    db.commit()
    # Round 1: CI fail -> card created, then assign the robot.
    mr_service.handle_merge_request_event(
        db, env["integration"], env["project"], _mr_event(1, "opened", SHA1)
    )
    fake.jobs = [{"id": 200, "name": "test", "stage": "test", "web_url": "u"}]
    fake.traces = {"/projects/group%2Fproject/jobs/200/trace": "boom"}
    mr_service.handle_pipeline_event(
        db, env["integration"], env["project"], _pipeline_event(SHA1, "failed")
    )
    db.commit()
    card = _card(db, env["project"])
    card.assignee_agent_id = agent.id
    db.commit()
    # Round 2: CI fails again -> auto re-trigger a fresh run (count 0 < max 1).
    mr_service.handle_merge_request_event(
        db, env["integration"], env["project"], _mr_event(1, "opened", SHA2)
    )
    mr_service.handle_pipeline_event(
        db, env["integration"], env["project"], _pipeline_event(SHA2, "failed")
    )
    db.commit()
    record = _record(db, env["integration"])
    assert record.auto_retrigger_count == 1
    assert (
        db.query(LoopItemExecution)
        .filter(LoopItemExecution.loop_item_id == card.id)
        .count()
        == 1
    )
    # Round 3: CI fails again -> capped (count 1 >= max 1), no second run.
    mr_service.handle_merge_request_event(
        db, env["integration"], env["project"], _mr_event(1, "opened", SHA3)
    )
    mr_service.handle_pipeline_event(
        db, env["integration"], env["project"], _pipeline_event(SHA3, "failed")
    )
    db.commit()
    record = _record(db, env["integration"])
    assert record.auto_retrigger_count == 1
    assert (
        db.query(LoopItemExecution)
        .filter(LoopItemExecution.loop_item_id == card.id)
        .count()
        == 1
    )


def test_merge_closes_card(env: dict[str, Any]) -> None:
    db = env["db"]
    fake: FakeGitlab = env["fake"]
    mr_service.handle_merge_request_event(
        db, env["integration"], env["project"], _mr_event(1, "opened", SHA1)
    )
    fake.jobs = [{"id": 200, "name": "test", "stage": "test", "web_url": "https://x"}]
    fake.traces = {"/projects/group%2Fproject/jobs/200/trace": "boom"}
    mr_service.handle_pipeline_event(
        db, env["integration"], env["project"], _pipeline_event(SHA1, "failed")
    )
    db.commit()
    assert _card(db, env["project"]) is not None
    mr_service.handle_merge_request_event(
        db, env["integration"], env["project"], _mr_event(1, "merged", SHA1)
    )
    db.commit()
    record = _record(db, env["integration"])
    assert record.state == "closed"
    card = _card(db, env["project"])
    assert card is not None
    assert card.status == "completed"


def test_reopen_reactivates(env: dict[str, Any]) -> None:
    db = env["db"]
    fake: FakeGitlab = env["fake"]
    mr_service.handle_merge_request_event(
        db, env["integration"], env["project"], _mr_event(1, "opened", SHA1)
    )
    fake.jobs = [{"id": 200, "name": "test", "stage": "test", "web_url": "https://x"}]
    fake.traces = {"/projects/group%2Fproject/jobs/200/trace": "boom"}
    mr_service.handle_pipeline_event(
        db, env["integration"], env["project"], _pipeline_event(SHA1, "failed")
    )
    mr_service.handle_merge_request_event(
        db, env["integration"], env["project"], _mr_event(1, "closed", SHA1)
    )
    db.commit()
    mr_service.handle_merge_request_event(
        db, env["integration"], env["project"], _mr_event(1, "reopened", SHA1)
    )
    db.commit()
    record = _record(db, env["integration"])
    assert record.state == "evaluating"
    card = _card(db, env["project"])
    assert card.status == "in_progress"


def test_assignee_matches_git_info(env: dict[str, Any]) -> None:
    db = env["db"]
    fake: FakeGitlab = env["fake"]
    member = User(
        user_name="alice",
        password_hash="x",
        email="alice@example.com",
        is_active=True,
        git_info=[
            {
                "type": "gitlab",
                "git_domain": "gitlab.internal",
                "git_id": "11",
                "git_login": "alice",
                "git_email": "alice@example.com",
            }
        ],
    )
    db.add(member)
    db.flush()
    db.add(
        ResourceMember.create(
            resource_type=ResourceType.CLOUD_PROJECT.value,
            resource_id=env["project"].id,
            entity_id=str(member.id),
            role="developer",
            status=MemberStatus.APPROVED.value,
        )
    )
    mr_service.handle_merge_request_event(
        db, env["integration"], env["project"], _mr_event(1, "opened", SHA1)
    )
    fake.jobs = [{"id": 200, "name": "test", "stage": "test", "web_url": "https://x"}]
    fake.traces = {"/projects/group%2Fproject/jobs/200/trace": "boom"}
    mr_service.handle_pipeline_event(
        db, env["integration"], env["project"], _pipeline_event(SHA1, "failed")
    )
    db.commit()
    card = _card(db, env["project"])
    assert card is not None
    assert card.assignee_user_id == member.id


def test_reconcile_closes_merged_without_event(env: dict[str, Any]) -> None:
    db = env["db"]
    fake: FakeGitlab = env["fake"]
    mr_service.handle_merge_request_event(
        db, env["integration"], env["project"], _mr_event(1, "opened", SHA1)
    )
    fake.jobs = [{"id": 200, "name": "test", "stage": "test", "web_url": "https://x"}]
    fake.traces = {"/projects/group%2Fproject/jobs/200/trace": "boom"}
    mr_service.handle_pipeline_event(
        db, env["integration"], env["project"], _pipeline_event(SHA1, "failed")
    )
    db.commit()
    fake.mr["state"] = "merged"
    record = _record(db, env["integration"])
    mr_service.settle_by_reconcile(db, env["integration"], env["project"], record)
    db.commit()
    assert record.state == "closed"
    assert _card(db, env["project"]).status == "completed"
