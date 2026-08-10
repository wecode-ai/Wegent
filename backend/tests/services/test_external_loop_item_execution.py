# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""External provider (GitHub/GitLab) robot assignment and execution contracts.

External tasks live only in the provider issue; Wegent keeps the run in the
execution table and never creates a local task row.
"""

import uuid

import pytest
from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, LoopItem, ProjectChatAgent
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.models.user import User
from app.schemas.base_role import BaseRole
from app.schemas.delivery import LoopItemResponse, LoopItemUpdate
from app.schemas.project_chat import (
    LoopItemApproval,
    LoopItemAssign,
    ProjectChatAgentStart,
)
from app.services.loop_item_executions.service import (
    loop_item_execution_service,
)
from app.services.loop_items.external_provider import (
    ASSIGNEE_PREFIX,
    external_loop_item_provider,
)
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
    db: Session, project: CloudProject, user: User, *, mode: str = "auto"
) -> ProjectChatAgent:
    bot = ProjectChatAgent(
        id=f"B{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        title="GitLab Bot",
        name="GitLab Bot",
        status="active",
        created_by_user_id=user.id,
        metadata_json={
            "runtime": "codex",
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

    monkeypatch.setattr(external_loop_item_provider, "_get_issue", get_issue)
    monkeypatch.setattr(external_loop_item_provider, "_update_issue", update_issue)


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

    response = external_loop_item_provider.assign(
        test_db,
        _item_id(project),
        test_user.id,
        LoopItemAssign(version=1, assignee_type="user", assignee_id=str(member.id)),
    )

    assert response["assignee_user_id"] == member.id
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
    assert view["execution_state"] == "pending_approval"
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

    assert view["execution_state"] == "completed"
    assert view["ai_state"]["status"] == "completed"
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
