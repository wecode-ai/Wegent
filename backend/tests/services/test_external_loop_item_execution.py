# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""External provider (GitHub/GitLab) robot assignment and execution contracts.

External tasks live only in the provider issue; Wegent keeps the run in the
execution table and never creates a local task row.
"""

import logging
import uuid
from concurrent.futures import Future, ThreadPoolExecutor
from threading import Event
from unittest.mock import patch

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, LoopItem, ProjectChatAgent
from app.models.kind import Kind
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.models.user import User
from app.schemas.base_role import BaseRole
from app.schemas.delivery import LoopItemCreate, LoopItemResponse, LoopItemUpdate
from app.schemas.project_chat import (
    LoopItemApproval,
    LoopItemAssign,
    ProjectChatAgentStart,
)
from app.services.loop_item_executions.service import (
    loop_item_execution_service,
)
from app.services.loop_items import external_provider as external_provider_module
from app.services.loop_items.external_provider import (
    ASSIGNEE_PREFIX,
    PARENT_MARKER,
    external_loop_item_provider,
)
from app.services.loop_items.provider_router import loop_item_provider_router
from app.services.project_chat.service import project_chat_service


def _make_gitlab_project(db: Session, user: User) -> CloudProject:
    public_id = str(uuid.uuid4())
    project = CloudProject(
        public_id=public_id,
        project_key=f"GL{uuid.uuid4().hex[:6].upper()}",
        name="GitLab board",
        description="",
        created_by_user_id=user.id,
        storage_prefix=f"projects/{public_id}",
        metadata_json={
            "task_provider": "gitlab",
            "provider_config": {"repository": "group/project"},
        },
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    return project


def _make_bot(
    db: Session,
    project: CloudProject,
    user: User,
    *,
    mode: str = "auto",
    runtime: str = "codex",
    wegent_team_id: int | None = None,
) -> ProjectChatAgent:
    device_id = f"cloud-{uuid.uuid4().hex[:10]}"
    db.add(
        Kind(
            kind="Device",
            name=device_id,
            namespace="default",
            user_id=user.id,
            is_active=True,
            json={"spec": {"deviceType": "cloud"}},
        )
    )
    bot = ProjectChatAgent(
        id=f"B{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        title="GitLab Bot",
        name="GitLab Bot",
        status="active",
        created_by_user_id=user.id,
        device_id=device_id if runtime == "codex" else None,
        metadata_json={
            "runtime": runtime,
            "wegent_team_id": wegent_team_id,
            "model": "test-model",
            "execution_mode": mode,
            "execution_environment": "cloud",
            "visibility": "public",
        },
    )
    db.add(bot)
    db.commit()
    db.refresh(bot)
    return bot


def _issue(number: int = 1) -> dict:
    return {
        "iid": number,
        "title": f"External task {number}",
        "description": "Do the thing",
        "state": "opened",
        "labels": [],
        "created_at": "2026-08-07T00:00:00Z",
        "updated_at": "2026-08-07T00:00:00Z",
        "closed_at": None,
    }


def _item_id(project: CloudProject) -> str:
    return f"{project.project_key}-1"


def _mock_issue(monkeypatch: pytest.MonkeyPatch) -> None:
    """Mock provider reads/writes with an in-memory issue (labels round-trip)."""

    state: dict[str, dict] = {"issue": _issue()}

    def get_issue(_project, number):
        return dict(state["issue"])

    def update_issue(_project, number, payload):
        issue = dict(state["issue"])
        if "labels" in payload:
            issue["labels"] = list(payload["labels"])
        if "title" in payload:
            issue["title"] = payload["title"]
        if payload.get("state_event") == "close":
            issue["state"] = "closed"
        issue["updated_at"] = "2026-08-07T00:01:00Z"
        state["issue"] = issue
        return dict(issue)

    def create_issue(_project, title, description, labels):
        issue = _issue()
        issue["title"] = title
        issue["description"] = description
        issue["labels"] = list(labels)
        state["issue"] = issue
        return dict(issue)

    monkeypatch.setattr(external_loop_item_provider, "_get_issue", get_issue)
    monkeypatch.setattr(external_loop_item_provider, "_update_issue", update_issue)
    monkeypatch.setattr(external_loop_item_provider, "_create_issue", create_issue)


def _active_execution(db: Session, item_id: str) -> LoopItemExecution | None:
    return (
        db.query(LoopItemExecution)
        .filter(
            LoopItemExecution.loop_item_id == item_id,
            LoopItemExecution.status.in_(["pending_approval", "queued"]),
        )
        .order_by(LoopItemExecution.id.desc())
        .first()
    )


def test_external_board_page_is_filtered_and_detail_is_lazy(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO)
    project = _make_gitlab_project(test_db, test_user)
    issues = []
    for number in range(1, 81):
        issue = _issue(number)
        issue["labels"] = [
            "wegent:status:pending" if number <= 60 else "wegent:status:in_progress"
        ]
        issues.append(issue)
    requests: list[dict[str, object]] = []

    def request(_project, _method, _path, *, params, **_kwargs):
        requests.append(dict(params))
        page = int(params["page"])
        per_page = int(params["per_page"])
        selected = [issue for issue in issues if params["labels"] in issue["labels"]]
        start = (page - 1) * per_page
        return selected[start : start + per_page]

    monkeypatch.setattr(
        external_loop_item_provider, "_repository", lambda _project: "repo"
    )
    monkeypatch.setattr(external_loop_item_provider, "_request", request)

    first, cursor = external_loop_item_provider.list_page(
        test_db,
        project.id,
        test_user.id,
        item_status="pending",
        parent_id=None,
        cursor=None,
        limit=50,
    )
    second, final_cursor = external_loop_item_provider.list_page(
        test_db,
        project.id,
        test_user.id,
        item_status="pending",
        parent_id=None,
        cursor=cursor,
        limit=50,
    )

    assert len(first) == 50
    assert cursor is not None
    assert len(second) == 10
    assert final_cursor is None
    assert {item["id"] for item in first}.isdisjoint({item["id"] for item in second})
    assert all(item["description"] == "" for item in first)
    assert all(item["detail_loaded"] is False for item in first)
    assert requests == [
        {
            "state": "opened",
            "per_page": 50,
            "page": 1,
            "labels": "wegent:status:pending",
            "not[search]": PARENT_MARKER,
            "not[in]": "description",
        },
        {
            "state": "opened",
            "per_page": 50,
            "page": 2,
            "labels": "wegent:status:pending",
            "not[search]": PARENT_MARKER,
            "not[in]": "description",
        },
    ]
    page_logs = [
        record.getMessage()
        for record in caplog.records
        if record.getMessage().startswith("[External board page]")
    ]
    assert len(page_logs) == 2
    assert "returned_ids=[1, 2" in page_logs[0]
    assert "returned_ids=[51, 52" in page_logs[1]


def test_external_issue_page_cache_reuses_provider_response(
    test_db: Session, test_user: User, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _make_gitlab_project(test_db, test_user)
    calls = 0

    def request(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        return [_issue()]

    external_loop_item_provider._invalidate_issue_page_cache(project.id)
    monkeypatch.setattr(
        external_loop_item_provider, "_repository", lambda _project: "repo"
    )
    monkeypatch.setattr(external_loop_item_provider, "_request", request)

    external_loop_item_provider._list_issue_page(project, "pending", None, 1, 10)
    external_loop_item_provider._list_issue_page(project, "pending", None, 1, 10)
    external_loop_item_provider._list_issue_page(project, "pending", None, 1, 5)

    assert calls == 2


def test_gitlab_child_page_filters_by_existing_parent_marker(
    test_db: Session, test_user: User, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _make_gitlab_project(test_db, test_user)
    parent_id = f"{project.project_key}-7"
    captured: dict[str, object] = {}

    def request(_project, _method, _path, *, params, **_kwargs):
        captured.update(params)
        return []

    external_loop_item_provider._invalidate_issue_page_cache(project.id)
    monkeypatch.setattr(
        external_loop_item_provider, "_repository", lambda _project: "repo"
    )
    monkeypatch.setattr(external_loop_item_provider, "_request", request)

    external_loop_item_provider._list_issue_page(project, "pending", parent_id, 1, 10)

    assert captured == {
        "state": "opened",
        "per_page": 10,
        "page": 1,
        "labels": "wegent:status:pending",
        "search": f"{PARENT_MARKER} {parent_id}",
        "in": "description",
    }


def test_external_issue_page_coalesces_concurrent_cache_misses(
    test_db: Session, test_user: User, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _make_gitlab_project(test_db, test_user)
    request_started = Event()
    release_request = Event()
    inflight_waiting = Event()
    calls = 0

    def request(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        request_started.set()
        assert release_request.wait(timeout=2)
        return [_issue()]

    class ObservedFuture(Future):
        def result(self, timeout=None):
            inflight_waiting.set()
            return super().result(timeout)

    external_loop_item_provider._invalidate_issue_page_cache(project.id)
    monkeypatch.setattr(
        external_loop_item_provider, "_repository", lambda _project: "repo"
    )
    monkeypatch.setattr(external_loop_item_provider, "_request", request)
    monkeypatch.setattr(external_provider_module, "Future", ObservedFuture)

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(
            external_loop_item_provider._list_issue_page,
            project,
            "pending",
            None,
            1,
            10,
        )
        assert request_started.wait(timeout=2)
        second = pool.submit(
            external_loop_item_provider._list_issue_page,
            project,
            "pending",
            None,
            1,
            10,
        )
        assert inflight_waiting.wait(timeout=2)
        release_request.set()
        assert first.result() == second.result()

    assert calls == 1


def test_external_parent_remains_stored_in_description(
    test_db: Session, test_user: User, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _make_gitlab_project(test_db, test_user)
    parent_id = f"{project.project_key}-7"
    captured: dict[str, object] = {}

    def create_issue(_project, title, description, labels):
        captured.update(
            title=title,
            description=description,
            labels=list(labels),
        )
        issue = _issue()
        issue["title"] = title
        issue["description"] = description
        issue["labels"] = list(labels)
        return issue

    monkeypatch.setattr(external_loop_item_provider, "_create_issue", create_issue)

    created = external_loop_item_provider.create(
        test_db,
        project.id,
        test_user.id,
        test_user.user_name,
        LoopItemCreate(
            title="Child issue",
            description="Child details",
            parent_id=parent_id,
        ),
    )

    assert captured["description"] == f"Child details\n\n{PARENT_MARKER} {parent_id}"
    assert created["parent_id"] == parent_id
    assert created["description"] == "Child details"


def test_completed_external_issue_stays_open_and_archive_closes_it(
    test_db: Session, test_user: User, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _make_gitlab_project(test_db, test_user)
    issue = _issue()
    writes: list[dict[str, object]] = []

    monkeypatch.setattr(
        external_loop_item_provider, "_get_issue", lambda _project, _number: issue
    )

    def update_issue(_project, _number, payload):
        writes.append(dict(payload))
        if "labels" in payload:
            issue["labels"] = list(payload["labels"])
        issue["state"] = payload.get("state", issue["state"])
        return dict(issue)

    monkeypatch.setattr(external_loop_item_provider, "_update_issue", update_issue)

    updated = external_loop_item_provider.update(
        test_db,
        _item_id(project),
        test_user.id,
        LoopItemUpdate(version=1, status="completed"),
    )
    external_loop_item_provider.archive(test_db, _item_id(project), test_user.id)

    assert updated["status"] == "completed"
    assert writes[0]["state"] == "opened"
    assert "wegent:status:completed" in writes[0]["labels"]
    assert writes[1] == {"state": "closed"}


def test_assign_robot_on_gitlab_creates_index_row_and_execution(
    test_db: Session, test_user: User, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _make_gitlab_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    _mock_issue(monkeypatch)

    response = external_loop_item_provider.assign(
        test_db,
        _item_id(project),
        test_user.id,
        LoopItemAssign(version=1, assignee_type="agent", assignee_id=bot.id),
    )

    assert response["assignee_agent_id"] == bot.id
    row = test_db.get(LoopItem, _item_id(project))
    assert row is not None
    assert row.metadata_json["external_index"] is True
    assert row.assignee_agent_id == bot.id
    # The index row never holds task status/title; those stay in the provider.
    assert row.title is None
    assert row.status is None
    execution = _active_execution(test_db, _item_id(project))
    assert execution is not None
    assert execution.status == "queued"
    assert execution.agent_id == bot.id


def test_assign_wegent_runtime_robot_on_gitlab_keeps_robot_identity(
    test_db: Session, test_user: User, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _make_gitlab_project(test_db, test_user)
    team = Kind(
        kind="Team",
        name=f"external-team-{uuid.uuid4().hex[:8]}",
        namespace="default",
        user_id=test_user.id,
        is_active=True,
        json={},
    )
    test_db.add(team)
    test_db.commit()
    test_db.refresh(team)
    _mock_issue(monkeypatch)
    bot = _make_bot(
        test_db,
        project,
        test_user,
        runtime="wegent",
        wegent_team_id=team.id,
    )

    response = external_loop_item_provider.assign(
        test_db,
        _item_id(project),
        test_user.id,
        LoopItemAssign(
            version=1,
            assignee_type="agent",
            assignee_id=bot.id,
        ),
    )

    assert response["assignee_team_id"] is None
    assert response["assignee_agent_id"] == bot.id
    row = test_db.get(LoopItem, _item_id(project))
    assert row is not None
    assert row.assignee_team_id is None
    assert row.assignee_agent_id == bot.id
    execution = _active_execution(test_db, _item_id(project))
    assert execution is not None
    assert execution.team_id == team.id
    assert execution.agent_id == bot.id
    assert execution.executor_type == "project_robot"


def test_create_gitlab_item_for_wegent_robot_returns_dispatchable_index(
    test_db: Session, test_user: User, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _make_gitlab_project(test_db, test_user)
    team = Kind(
        kind="Team",
        name=f"external-team-{uuid.uuid4().hex[:8]}",
        namespace="default",
        user_id=test_user.id,
        is_active=True,
        json={},
    )
    test_db.add(team)
    test_db.commit()
    test_db.refresh(team)
    _mock_issue(monkeypatch)
    bot = _make_bot(
        test_db,
        project,
        test_user,
        runtime="wegent",
        wegent_team_id=team.id,
    )

    created = loop_item_provider_router.create(
        test_db,
        project,
        test_user,
        LoopItemCreate(
            title="Created and assigned",
            assignee_agent_id=bot.id,
        ),
        automation_context={"run_id": "automation-run-1"},
        instruction="Handle the external issue",
    )

    assert created.values["assignee_agent_id"] == bot.id
    assert created.internal_item is not None
    assert created.internal_item.assignee_agent_id == bot.id
    execution = _active_execution(test_db, str(created.values["id"]))
    assert execution is not None
    assert execution.team_id == team.id
    assert execution.agent_id == bot.id
    assert execution.executor_type == "project_robot"


def test_assign_user_on_gitlab_creates_index_row_without_execution(
    test_db: Session, test_user: User, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.models.resource_member import MemberStatus, ResourceMember
    from app.models.share_link import ResourceType
    from app.schemas.base_role import BaseRole

    project = _make_gitlab_project(test_db, test_user)
    member = User(
        user_name="assignee",
        password_hash="unused",
        email="assignee@example.com",
        is_active=True,
    )
    test_db.add(member)
    test_db.flush()
    test_db.add(
        ResourceMember(
            resource_type=ResourceType.CLOUD_PROJECT.value,
            resource_id=project.id,
            entity_type="user",
            entity_id=str(member.id),
            role=BaseRole.Developer.value,
            status=MemberStatus.APPROVED.value,
        )
    )
    test_db.commit()
    _mock_issue(monkeypatch)

    with patch(
        "app.services.loop_items.external_provider.notify_project_task_assignee"
    ) as notify:
        response = external_loop_item_provider.assign(
            test_db,
            _item_id(project),
            test_user.id,
            LoopItemAssign(
                version=1,
                assignee_type="user",
                assignee_id=str(member.id),
            ),
        )

    assert response["assignee_user_id"] == member.id
    notify.assert_called_once_with(
        user_id=member.id,
        project_id=str(project.id),
        project_name=project.name,
        item_id=_item_id(project),
        item_title="External task 1",
        assigner_name=test_user.user_name,
    )
    row = test_db.get(LoopItem, _item_id(project))
    assert row is not None
    assert row.assignee_user_id == member.id
    assert row.assignee_agent_id == ""
    assert _active_execution(test_db, _item_id(project)) is None


def test_external_response_merges_execution_state(
    test_db: Session, test_user: User, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _make_gitlab_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user, mode="manual_approval")
    _mock_issue(monkeypatch)

    external_loop_item_provider.assign(
        test_db,
        _item_id(project),
        test_user.id,
        LoopItemAssign(version=1, assignee_type="agent", assignee_id=bot.id),
    )

    view = external_loop_item_provider.get(test_db, _item_id(project), test_user.id)
    assert view["assignee_agent_id"] == bot.id
    assert view["execution_state"] == "waiting_approval"
    assert view["execution_control_state"] == "pending_approval"
    assert isinstance(view["queued_at"], str)
    assert view["can_approve"] is True
    assert view["approval"]["status"] == "pending"
    assert view["ai_state"] is None


def test_list_filters_external_issues_by_assignee(
    test_db: Session, test_user: User, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _make_gitlab_project(test_db, test_user)
    my_issue = _issue(1)
    my_issue["labels"] = [f"{ASSIGNEE_PREFIX}user:{test_user.id}"]
    bot_issue = _issue(2)
    bot_issue["labels"] = [f"{ASSIGNEE_PREFIX}agent:bot-1"]
    unassigned = _issue(3)
    monkeypatch.setattr(
        external_loop_item_provider,
        "_list_issues",
        lambda _project: [my_issue, bot_issue, unassigned],
    )

    mine = external_loop_item_provider.list(
        test_db,
        project.id,
        test_user.id,
        assignee_type="user",
        assignee_id=str(test_user.id),
    )
    assert [item["id"] for item in mine] == [f"{project.project_key}-1"]

    bots = external_loop_item_provider.list(
        test_db,
        project.id,
        test_user.id,
        assignee_type="agent",
        assignee_id="bot-1",
    )
    assert [item["id"] for item in bots] == [f"{project.project_key}-2"]

    everything = external_loop_item_provider.list(test_db, project.id, test_user.id)
    assert [item["id"] for item in everything] == [
        f"{project.project_key}-1",
        f"{project.project_key}-2",
        f"{project.project_key}-3",
    ]


def test_approve_run_on_gitlab_project(
    test_db: Session, test_user: User, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _make_gitlab_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user, mode="manual_approval")
    _mock_issue(monkeypatch)
    external_loop_item_provider.assign(
        test_db,
        _item_id(project),
        test_user.id,
        LoopItemAssign(version=1, assignee_type="agent", assignee_id=bot.id),
    )

    response = external_loop_item_provider.approve_run(
        test_db,
        project_id=int(project.id),
        item_id=_item_id(project),
        user_id=test_user.id,
        values=LoopItemApproval(version=1),
    )

    execution = _active_execution(test_db, _item_id(project))
    assert execution is not None
    assert execution.status == "queued"
    assert execution.approval_status == "approved"
    assert response["execution_state"] == "queued"


def test_external_response_keeps_ai_state_after_run_completes(
    test_db: Session, test_user: User, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _make_gitlab_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    _mock_issue(monkeypatch)
    external_loop_item_provider.assign(
        test_db,
        _item_id(project),
        test_user.id,
        LoopItemAssign(version=1, assignee_type="agent", assignee_id=bot.id),
    )
    execution = _active_execution(test_db, _item_id(project))
    assert execution is not None
    loop_item_execution_service.complete(test_db, execution_id=execution.id)

    view = external_loop_item_provider.get(test_db, _item_id(project), test_user.id)

    assert view["execution_state"] == "succeeded"
    assert view["execution_control_state"] == "completed"
    assert view["ai_state"]["status"] == "succeeded"
    assert view["ai_state"]["agent_id"] == bot.id


def test_assign_response_roundtrip(
    test_db: Session, test_user: User, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Mirror the assign endpoint: provider response passes the response model."""

    project = _make_gitlab_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    _mock_issue(monkeypatch)

    response = external_loop_item_provider.assign(
        test_db,
        _item_id(project),
        test_user.id,
        LoopItemAssign(version=1, assignee_type="agent", assignee_id=bot.id),
    )
    parsed = LoopItemResponse.model_validate(response)

    assert parsed.assignee_agent_id == bot.id
    assert parsed.execution_state == "queued"


def test_unassign_on_gitlab_cancels_robot_run(
    test_db: Session, test_user: User, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _make_gitlab_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    _mock_issue(monkeypatch)
    external_loop_item_provider.assign(
        test_db,
        _item_id(project),
        test_user.id,
        LoopItemAssign(version=1, assignee_type="agent", assignee_id=bot.id),
    )

    response = external_loop_item_provider.update(
        test_db,
        _item_id(project),
        test_user.id,
        LoopItemUpdate(
            version=1,
            assignee_user_id=None,
            assignee_agent_id=None,
        ),
    )

    assert response["assignee_agent_id"] is None
    row = test_db.get(LoopItem, _item_id(project))
    assert row is not None
    assert row.deleted_at is not None
    execution = (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.loop_item_id == _item_id(project))
        .order_by(LoopItemExecution.id.desc())
        .first()
    )
    assert execution is not None
    assert execution.status == "cancelled"


def test_project_chat_scope_for_external_task_creates_no_shadow(
    test_db: Session, test_user: User, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _make_gitlab_project(test_db, test_user)
    _mock_issue(monkeypatch)

    result = project_chat_service._require_scope(
        test_db,
        user_id=test_user.id,
        project_id=str(project.id),
        task_id=_item_id(project),
        required_role=BaseRole.Developer,
    )

    assert result.id == str(project.id)
    assert test_db.get(LoopItem, _item_id(project)) is None


def test_external_assigned_task_chat_start_creates_message(
    test_db: Session, test_user: User, monkeypatch: pytest.MonkeyPatch
) -> None:
    """With an index row present, a runtime start writes the agent message."""

    project = _make_gitlab_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    _mock_issue(monkeypatch)
    external_loop_item_provider.assign(
        test_db,
        _item_id(project),
        test_user.id,
        LoopItemAssign(version=1, assignee_type="agent", assignee_id=bot.id),
    )

    response = project_chat_service.start_agent_response(
        test_db,
        user_id=test_user.id,
        request=ProjectChatAgentStart(
            projectId=project.id,
            taskId=_item_id(project),
            agentId=bot.id,
            runtimeDeviceId="local-device",
            runtimeTaskId="codex-queue-test",
        ),
    )

    assert response.message_id
    row = (
        test_db.query(ProjectChatMessage)
        .filter(ProjectChatMessage.task_id == _item_id(project))
        .first()
    )
    assert row is not None
    assert row.runtime_task_id == "codex-queue-test"
