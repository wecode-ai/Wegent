# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Wegent board automation MCP provider-routing contracts."""

from __future__ import annotations

import uuid
from datetime import datetime
from types import SimpleNamespace

import pytest
from sqlalchemy.orm import Session

from app.mcp_server.auth import MCPAuthInfo
from app.mcp_server.tools import wework_space
from app.models.delivery import (
    CloudProject,
    LoopItem,
    ProjectAutomationRule,
    ProjectAutomationRun,
    ProjectChatAgent,
)
from app.models.project_chat_message import ProjectChatMessage
from app.models.user import User
from app.schemas.issue_workflow import WorkflowPlanSubmit
from app.services.issue_workflow_planning import issue_workflow_planning_service


class _SessionContext:
    def __init__(self, db: Session) -> None:
        self._db = db

    def __enter__(self) -> Session:
        return self._db

    def __exit__(self, exc_type: object, *_args: object) -> None:
        if exc_type is not None:
            self._db.rollback()


def _project(db: Session, user: User, *, provider: str) -> CloudProject:
    public_id = str(uuid.uuid4())
    project = CloudProject(
        public_id=public_id,
        project_key=f"MCP{uuid.uuid4().hex[:6].upper()}",
        name="Managed board",
        description="",
        created_by_user_id=user.id,
        storage_prefix=f"projects/{public_id}",
        metadata_json={"task_provider": provider},
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    return project


def _token(user: User) -> MCPAuthInfo:
    return MCPAuthInfo(
        user_id=user.id,
        user_name=user.user_name,
        auth_type="task",
        task_id=1,
        subtask_id=2,
    )


def _workflow_issue(
    db: Session,
    project: CloudProject,
    user: User,
) -> tuple[LoopItem, ProjectChatAgent]:
    robot = ProjectChatAgent(
        id=f"robot-{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        title="Implementation robot",
        name="Implementation robot",
        status="active",
        created_by_user_id=user.id,
        metadata_json={
            "runtime": "codex",
            "execution_mode": "auto",
            "execution_environment": "local",
        },
    )
    item = LoopItem(
        id=f"{project.project_key}-1",
        cloud_project_id=project.id,
        sequence_number=1,
        title="Coordinate this task",
        description="Implement and verify the requested change.",
        status="pending",
        priority="medium",
        created_by_user_id=user.id,
        metadata_json={
            "workflow": {
                "version": 1,
                "definition_version": 1,
                "stage_mode": "none",
                "advancement_policy": "ai",
                "approval_policy": "required",
                "ai_automation_rule_id": "rule-1",
                "orchestration_status": "idle",
                "nodes": [],
            }
        },
    )
    db.add_all([robot, item])
    project.next_item_number = 2
    db.commit()
    db.refresh(item)
    return item, robot


def _workflow_plan(robot: ProjectChatAgent) -> dict[str, object]:
    return {
        "summary": "Implement, then verify.",
        "items": [
            {
                "client_key": "implement",
                "title": "Implement the change",
                "description": "Implement the requested change and add tests.",
                "assignee_type": "agent",
                "assignee_id": robot.id,
                "assignee_name": robot.name,
                "rationale": "The robot has implementation capability.",
            }
        ],
    }


def _manager_run(
    db: Session,
    project: CloudProject,
    item: LoopItem,
    user: User,
    *,
    status: str = "running",
    workflow_run_id: str = "",
) -> tuple[ProjectAutomationRun, ProjectChatMessage]:
    rule = ProjectAutomationRule(
        id=f"rule-{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        title="Managed planning",
        status="enabled",
        created_by_user_id=user.id,
        metadata_json={"assignment_mode": "ai_managed", "manager_type": "custom"},
    )
    run = ProjectAutomationRun(
        cloud_project_id=project.id,
        parent_id=rule.id,
        task_id=item.id,
        title="Managed run",
        status=status,
        created_by_user_id=user.id,
        metadata_json={},
    )
    message_id = str(uuid.uuid4())
    activity = ProjectChatMessage(
        message_id=message_id,
        client_message_id=message_id,
        project_id=str(project.id),
        task_id=item.id,
        sender_type="agent",
        sender_id=f"automation_manager:{rule.id}",
        sender_name="AI manager",
        message_type="agent_status",
        content="",
        metadata_json={
            "automation_run_id": str(run.id),
            "run_status": status,
        },
        status="streaming" if status == "running" else "failed",
    )
    run.metadata_json = {
        "activity_message_id": message_id,
        "event": {"payload": {"workflow_run_id": workflow_run_id}},
    }
    db.add_all([rule, run, activity])
    db.commit()
    return run, activity


def test_local_project_tools_use_canonical_loop_item_service(
    test_db: Session, test_user: User, monkeypatch
) -> None:
    project = _project(test_db, test_user, provider="local")
    item = LoopItem(
        id=f"{project.project_key}-1",
        cloud_project_id=str(project.id),
        sequence_number=1,
        title="Read the real board task",
        description="Full details",
        status="inbox",
        priority="high",
        created_by_user_id=test_user.id,
        metadata_json={"tags": ["automation"]},
    )
    test_db.add(item)
    test_db.commit()
    monkeypatch.setattr(wework_space, "SessionLocal", lambda: _SessionContext(test_db))

    listed = wework_space.list_board_items(_token(test_user), str(project.id))
    detail = wework_space.get_board_item(_token(test_user), str(project.id), item.id)

    assert [value["id"] for value in listed] == [item.id]
    assert detail["description"] == "Full details"
    assert detail["tags"] == ["automation"]


def test_current_context_resolves_space_and_item_from_authenticated_task(
    test_db: Session, test_user: User, monkeypatch
) -> None:
    project = _project(test_db, test_user, provider="local")
    item = LoopItem(
        id=f"{project.project_key}-1",
        cloud_project_id=str(project.id),
        sequence_number=1,
        title="Bound board task",
        status="inbox",
        priority="none",
        created_by_user_id=test_user.id,
    )
    test_db.add(item)
    test_db.commit()
    monkeypatch.setattr(wework_space, "SessionLocal", lambda: _SessionContext(test_db))
    monkeypatch.setattr(
        wework_space.task_store,
        "get_by_id",
        lambda *_args, **_kwargs: SimpleNamespace(
            json={
                "metadata": {
                    "labels": {
                        "source": "board_team_assignment",
                        "boardTeamExecutionId": "42",
                        "weworkSpaceProjectId": str(project.id),
                        "weworkSpaceTaskId": item.id,
                    }
                }
            }
        ),
    )

    context = wework_space.get_current_context(_token(test_user))

    assert context["space_id"] == str(project.id)
    assert context["item_id"] == item.id
    assert context["board_team_execution_id"] == "42"
    assert context["space"]["name"] == "Managed board"
    assert context["item"]["title"] == "Bound board task"


def test_project_details_expose_assignable_members(
    test_db: Session, test_user: User, monkeypatch
) -> None:
    project = _project(test_db, test_user, provider="local")
    project.metadata_json = {
        **dict(project.metadata_json or {}),
        "member_capabilities": {str(test_user.id): "Owns product decisions"},
    }
    test_db.commit()
    monkeypatch.setattr(wework_space, "SessionLocal", lambda: _SessionContext(test_db))
    monkeypatch.setattr(
        wework_space.project_chat_service,
        "list_agents",
        lambda *_args, **_kwargs: [
            SimpleNamespace(
                id="robot-1",
                name="Backend robot",
                runtime="wegent",
                capability_description="Builds Python APIs",
            )
        ],
    )

    details = wework_space.get_assignment_candidates(_token(test_user), str(project.id))

    assert details["members"] == [
        {
            "id": test_user.id,
            "name": test_user.user_name,
            "role": "Owner",
            "capability": "Owns product decisions",
        }
    ]
    assert details["robots"] == [
        {
            "id": "robot-1",
            "name": "Backend robot",
            "runtime": "wegent",
            "capability": "Builds Python APIs",
        }
    ]


async def test_ai_manager_submits_structured_plan_for_current_issue(
    test_db: Session, test_user: User, monkeypatch
) -> None:
    project = _project(test_db, test_user, provider="local")
    item, robot = _workflow_issue(test_db, project, test_user)
    workflow_run = issue_workflow_planning_service.ensure_run(
        test_db,
        issue=item,
        user_id=test_user.id,
    )
    manager_run, activity = _manager_run(
        test_db,
        project,
        item,
        test_user,
        workflow_run_id=workflow_run.id,
    )
    test_db.commit()
    monkeypatch.setattr(wework_space, "SessionLocal", lambda: _SessionContext(test_db))
    monkeypatch.setattr(
        wework_space,
        "_board_context",
        lambda *_args, **_kwargs: {
            "source": "project_automation",
            "space_id": str(project.id),
            "item_id": item.id,
            "project_automation_run_id": str(manager_run.id),
        },
    )

    submitted = await wework_space.submit_workflow_plan(
        _token(test_user),
        _workflow_plan(robot),
    )

    test_db.refresh(workflow_run)
    test_db.refresh(activity)
    assert submitted["run_id"] == workflow_run.id
    assert submitted["stage_id"] == "__issue__"
    assert submitted["items"][0]["stage_id"] == "__issue__"
    assert submitted["status"] == "awaiting_approval"
    assert submitted["items"][0]["task_id"] is None
    assert workflow_run.metadata_json["project_automation_run_id"] == manager_run.id
    assert activity.metadata_json["workflow_plan_run_id"] == workflow_run.id
    assert activity.metadata_json["workflow_plan_version"] == 1


async def test_ai_manager_plan_submission_rolls_back_when_run_binding_fails(
    test_db: Session, test_user: User, monkeypatch
) -> None:
    project = _project(test_db, test_user, provider="local")
    item, robot = _workflow_issue(test_db, project, test_user)
    workflow_run = issue_workflow_planning_service.ensure_run(
        test_db,
        issue=item,
        user_id=test_user.id,
    )
    manager_run, _activity = _manager_run(
        test_db,
        project,
        item,
        test_user,
        status="failed",
        workflow_run_id=workflow_run.id,
    )
    test_db.commit()
    monkeypatch.setattr(wework_space, "SessionLocal", lambda: _SessionContext(test_db))
    monkeypatch.setattr(
        wework_space,
        "_board_context",
        lambda *_args, **_kwargs: {
            "source": "project_automation",
            "space_id": str(project.id),
            "item_id": item.id,
            "project_automation_run_id": str(manager_run.id),
        },
    )

    with pytest.raises(RuntimeError, match="not active"):
        await wework_space.submit_workflow_plan(
            _token(test_user),
            _workflow_plan(robot),
        )

    test_db.expire_all()
    restored = issue_workflow_planning_service.get(
        test_db,
        issue_id=item.id,
        user_id=test_user.id,
    )
    assert restored is not None
    assert restored.run_id == workflow_run.id
    assert restored.status == "planning"
    assert restored.items == []


async def test_workflow_child_reports_one_parent_review_outcome(
    test_db: Session, test_user: User, monkeypatch
) -> None:
    project = _project(test_db, test_user, provider="local")
    item, robot = _workflow_issue(test_db, project, test_user)
    issue_workflow_planning_service.ensure_run(
        test_db,
        issue=item,
        user_id=test_user.id,
    )
    test_db.commit()
    issue_workflow_planning_service.submit(
        test_db,
        issue_id=item.id,
        user_id=test_user.id,
        values=WorkflowPlanSubmit.model_validate(_workflow_plan(robot)),
    )
    approved = issue_workflow_planning_service.approve(
        test_db,
        issue_id=item.id,
        user_id=test_user.id,
    )
    child_id = approved.items[0].task_id
    assert child_id is not None
    monkeypatch.setattr(wework_space, "SessionLocal", lambda: _SessionContext(test_db))
    monkeypatch.setattr(
        wework_space,
        "_board_context",
        lambda *_args, **_kwargs: {
            "source": "board_team_assignment",
            "space_id": str(project.id),
            "item_id": child_id,
            "board_team_execution_id": "42",
        },
    )

    reported = await wework_space.report_workflow_outcome(
        _token(test_user),
        "passed",
        "Implementation and tests passed.",
    )

    assert reported["issue_id"] == item.id
    assert reported["status"] == "awaiting_review"
    assert test_db.get(LoopItem, child_id).status == "in_review"
    assert test_db.get(LoopItem, item.id).status == "in_review"


async def test_external_project_tools_route_list_read_and_assignment_to_provider(
    test_db: Session, test_user: User, monkeypatch
) -> None:
    project = _project(test_db, test_user, provider="gitlab")
    item_id = f"{project.project_key}-7"
    current = {
        "id": item_id,
        "cloud_project_id": str(project.id),
        "sequence_number": 7,
        "parent_id": None,
        "title": "Provider issue",
        "description": "Provider-owned details",
        "status": "in_progress",
        "priority": "medium",
        "tags": ["external"],
        "assignee_user_id": None,
        "assignee_agent_id": None,
        "assignee_team_id": None,
        "due_at": None,
        "sort_order": 0,
        "created_by_user_id": test_user.id,
        "current_delivery_id": None,
        "version": 7,
        "created_at": datetime.now(),
        "updated_at": datetime.now(),
        "completed_at": None,
    }
    calls: list[tuple[str, object]] = []

    def list_items(_db, project_id, user_id):
        calls.append(("list", (project_id, user_id)))
        return [dict(current)]

    def get_item(_db, requested_id, user_id):
        calls.append(("get", (requested_id, user_id)))
        return dict(current)

    def assign_from_manager(_db, **values):
        calls.append(("assign", values))
        return {**current, "assignee_user_id": int(values["assignee_id"])}

    monkeypatch.setattr(wework_space, "SessionLocal", lambda: _SessionContext(test_db))
    monkeypatch.setattr(wework_space.external_loop_item_provider, "list", list_items)
    monkeypatch.setattr(wework_space.external_loop_item_provider, "get", get_item)
    monkeypatch.setattr(
        wework_space,
        "_board_context",
        lambda *_args, **_kwargs: {
            "source": "project_automation",
            "space_id": str(project.id),
            "item_id": item_id,
            "project_automation_run_id": "run-1",
        },
    )
    monkeypatch.setattr(
        wework_space.project_automation_execution,
        "assign_from_manager",
        assign_from_manager,
    )

    listed = wework_space.list_board_items(_token(test_user), str(project.id))
    detail = wework_space.get_board_item(_token(test_user), str(project.id), item_id)
    assigned = await wework_space.assign_board_item(
        _token(test_user),
        "user",
        str(test_user.id),
        str(project.id),
        item_id,
    )

    assert listed[0]["description"] == "Provider-owned details"
    assert detail["id"] == item_id
    assert assigned["assignee_user_id"] == test_user.id
    assert [name for name, _ in calls] == ["list", "get", "get", "assign"]
    assign_values = calls[-1][1]
    assert assign_values["run_id"] == "run-1"
    assert assign_values["assignee_type"] == "user"
    assert assign_values["task_id"] == item_id


async def test_board_robot_task_can_assign_item_to_another_project_robot(
    test_db: Session, test_user: User, monkeypatch, mocker
) -> None:
    project = _project(test_db, test_user, provider="local")
    robot = ProjectChatAgent(
        id="robot-2",
        cloud_project_id=project.id,
        title="Implementation robot",
        name="Implementation robot",
        status="active",
        created_by_user_id=test_user.id,
        metadata_json={"runtime": "codex"},
    )
    item = LoopItem(
        id=f"{project.project_key}-2",
        cloud_project_id=str(project.id),
        sequence_number=2,
        title="Delegate this task",
        status="inbox",
        priority="none",
        created_by_user_id=test_user.id,
    )
    test_db.add_all([robot, item])
    test_db.commit()
    monkeypatch.setattr(wework_space, "SessionLocal", lambda: _SessionContext(test_db))
    monkeypatch.setattr(
        wework_space,
        "_board_context",
        lambda *_args, **_kwargs: {
            "source": "board_team_assignment",
            "space_id": str(project.id),
            "item_id": item.id,
        },
    )
    dispatch = mocker.patch(
        "app.services.board_team_execution.dispatch_board_team_assignment",
        return_value=None,
    )

    assigned = await wework_space.assign_board_item(
        _token(test_user), "agent", robot.id
    )

    assert assigned["assignee_agent_id"] == robot.id
    dispatch.assert_awaited_once()
