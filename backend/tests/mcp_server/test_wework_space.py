# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Wegent board automation MCP provider-routing contracts."""

from __future__ import annotations

import json
import uuid
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy.orm import Session

from app.mcp_server.auth import MCPAuthInfo
from app.mcp_server.tools import wework_space
from app.models.delivery import (
    CloudProject,
    LoopItem,
    ProjectChatAgent,
)
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.models.user import User
from app.services import collaboration_manager_decisions


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


def test_update_issue_status_is_scoped_to_manager_board_task(
    test_db: Session, test_user: User, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(test_db, test_user, provider="local")
    manager = ProjectChatAgent(
        id="manager-agent",
        cloud_project_id=project.id,
        title="Issue manager",
        name="Issue manager",
        status="active",
        created_by_user_id=test_user.id,
        metadata_json={"runtime": "codex"},
    )
    item = LoopItem(
        id=f"{project.project_key}-1",
        cloud_project_id=project.id,
        sequence_number=1,
        title="Review executor results",
        status="in_progress",
        priority="medium",
        created_by_user_id=test_user.id,
        metadata_json={
            "collaboration_group": {
                "id": "group-1",
                "name": "Managed group",
            },
            "collaboration_group_assignment_key": "assignment-1",
        },
    )
    dispatch = LoopItemExecution(
        loop_item_id=item.id,
        cloud_project_id=str(project.id),
        executor_owner_user_id=test_user.id,
        assigner_user_id=test_user.id,
        execution_payload=json.dumps(
            {
                "runtime_selection": {
                    "executor_kind": "collaboration_group_dispatch",
                },
                "origin_context": {
                    "dispatch_kind": "collaboration_group",
                    "dispatch_id": "dispatch-1",
                    "manager_agent_id": manager.id,
                    "run_id": "collaboration-group:assignment-1",
                    "collaboration_group_id": "group-1",
                    "collaboration_group": {
                        "id": "group-1",
                        "name": "Managed group",
                        "leader": {"kind": "agent", "id": manager.id},
                        "members": [],
                    },
                },
            }
        ),
        status="completed",
    )
    test_db.add_all([manager, item, dispatch])
    test_db.commit()
    labels = {
        "source": "project_automation",
        "weworkSpaceProjectId": str(project.id),
        "weworkSpaceTaskId": item.id,
        "dispatchId": "dispatch-1",
        "dispatchRole": "manager",
        "managerAgentId": manager.id,
    }
    monkeypatch.setattr(
        collaboration_manager_decisions,
        "push_project_chat_message",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr(wework_space, "SessionLocal", lambda: _SessionContext(test_db))
    monkeypatch.setattr(wework_space, "_task_labels", lambda *_args: labels)

    result = wework_space.update_issue_status(
        _token(test_user),
        "decision-1",
        "in_review",
        "Executor evidence is ready for confirmation.",
        "执行结果已满足验收条件，请确认。",
    )

    assert result["id"] == item.id
    assert result["status"] == "in_review"
    comment = (
        test_db.query(ProjectChatMessage)
        .filter(ProjectChatMessage.task_id == item.id)
        .one()
    )
    assert comment.sender_id == manager.id
    assert comment.sender_name == "Issue manager"
    assert comment.content == "执行结果已满足验收条件，请确认。"
    assert comment.metadata_json == {
        "dispatch_role": "manager",
        "activity_type": "manager_status_comment",
        "dispatch_id": "dispatch-1",
        "target_status": "in_review",
        "reason": "Executor evidence is ready for confirmation.",
    }
    labels["dispatchRole"] = "executor"
    with pytest.raises(ValueError, match="not a dispatch manager"):
        wework_space.update_issue_status(
            _token(test_user),
            "decision-2",
            "completed",
            "Executors cannot decide the Issue status.",
        )


def test_local_board_comment_uses_internal_provider(
    test_db: Session, test_user: User, monkeypatch
) -> None:
    project = _project(test_db, test_user, provider="local")
    item = LoopItem(
        id=f"{project.project_key}-1",
        cloud_project_id=project.id,
        sequence_number=1,
        title="Coordinate this task",
        status="pending",
        priority="medium",
        created_by_user_id=test_user.id,
    )
    test_db.add(item)
    test_db.commit()
    monkeypatch.setattr(wework_space, "SessionLocal", lambda: _SessionContext(test_db))
    monkeypatch.setattr(
        wework_space,
        "_board_context",
        lambda *_: {"space_id": str(project.id), "item_id": item.id},
    )

    comment = wework_space.add_board_item_comment(
        _token(test_user), "Please check the plan"
    )

    assert comment["body"] == "Please check the plan"


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
                        "source": "project_automation",
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
    assert details["groups"] == []


async def test_manager_mcp_assignment_to_human_returns_plain_issue(
    test_db: Session, test_user: User, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(test_db, test_user, provider="local")
    monkeypatch.setattr(wework_space, "SessionLocal", lambda: _SessionContext(test_db))
    monkeypatch.setattr(
        "app.services.project_incoming_hooks."
        "project_incoming_hook_service.ingest_internal",
        AsyncMock(),
    )

    created = await wework_space.create_board_item(
        _token(test_user),
        {
            "title": "Human evidence review",
            "description": "Review the evidence and submit a decision.",
            "status": "pending",
        },
        str(project.id),
    )
    assigned = await wework_space.assign_board_item(
        _token(test_user),
        "user",
        str(test_user.id),
        str(project.id),
        str(created["id"]),
    )

    assert assigned["assignee_user_id"] == test_user.id
    assert "human_work" not in assigned


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

    def assign_item(_db, requested_id, user_id, values):
        calls.append(("assign", (requested_id, user_id, values)))
        current["assignee_user_id"] = int(values.assignee_id)

    monkeypatch.setattr(wework_space, "SessionLocal", lambda: _SessionContext(test_db))
    monkeypatch.setattr(wework_space.external_loop_item_provider, "list", list_items)
    monkeypatch.setattr(wework_space.external_loop_item_provider, "get", get_item)
    monkeypatch.setattr(
        wework_space.external_loop_item_provider,
        "assign",
        assign_item,
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
    assert [name for name, _ in calls] == ["list", "get", "get", "assign", "get"]
    assigned_item_id, assigned_user_id, assign_values = calls[-2][1]
    assert assigned_item_id == item_id
    assert assigned_user_id == test_user.id
    assert assign_values.assignee_type == "user"


async def test_board_robot_task_can_assign_item_to_another_project_robot(
    test_db: Session, test_user: User, monkeypatch
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
            "source": "project_automation",
            "space_id": str(project.id),
            "item_id": item.id,
        },
    )

    assigned = await wework_space.assign_board_item(
        _token(test_user), "agent", robot.id
    )

    assert assigned["assignee_agent_id"] == robot.id


@pytest.mark.parametrize("url", [None, "wework://boards"])
def test_notification_tool_sends_to_self_without_project_context(
    test_db, test_user, monkeypatch, url
):
    from app.models.wework_notification import WeworkNotification

    monkeypatch.setattr(wework_space, "SessionLocal", lambda: _SessionContext(test_db))
    monkeypatch.setattr("app.core.async_utils.schedule_async_task", lambda *_: None)

    result = wework_space.send_notification(
        _token(test_user), "Greeting", "你好", url=url
    )

    assert result["url"] == url
    row = test_db.get(WeworkNotification, result["id"])
    assert row.user_id == test_user.id
    assert row.body == "你好"


def test_notification_tool_uses_bound_project_and_current_user(
    test_db, test_user, monkeypatch
):
    from app.models.wework_notification import WeworkNotification

    project = _project(test_db, test_user, provider="internal")
    monkeypatch.setattr(wework_space, "SessionLocal", lambda: _SessionContext(test_db))
    monkeypatch.setattr(
        wework_space, "_board_context", lambda *_: {"space_id": str(project.id)}
    )
    monkeypatch.setattr("app.core.async_utils.schedule_async_task", lambda *_: None)

    result = wework_space.send_notification(
        _token(test_user), "Review failed", "Please review"
    )

    assert result["url"] == f"wework://boards/{project.id}"
    assert test_db.get(WeworkNotification, result["id"]).user_id == test_user.id
    with pytest.raises(ValueError, match="Space does not match"):
        wework_space.send_notification(
            _token(test_user), "Review", "Wrong project", space_id="999"
        )
