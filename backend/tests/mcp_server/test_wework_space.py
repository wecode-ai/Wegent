# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Wegent board automation MCP provider-routing contracts."""

from __future__ import annotations

import uuid
from types import SimpleNamespace

from sqlalchemy.orm import Session

from app.mcp_server.auth import MCPAuthInfo
from app.mcp_server.tools import wework_space
from app.models.delivery import CloudProject, LoopItem
from app.models.user import User


class _SessionContext:
    def __init__(self, db: Session) -> None:
        self._db = db

    def __enter__(self) -> Session:
        return self._db

    def __exit__(self, *_args: object) -> None:
        return None


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


def test_local_project_tools_use_canonical_loop_item_service(
    test_db: Session, test_user: User, monkeypatch
) -> None:
    project = _project(test_db, test_user, provider="local")
    item = LoopItem(
        id=f"{project.project_key}-1",
        cloud_project_id=str(project.id),
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

    listed = wework_space.list_tasks(_token(test_user), str(project.id))
    detail = wework_space.get_task(_token(test_user), str(project.id), item.id)

    assert [value["id"] for value in listed] == [item.id]
    assert detail["description"] == "Full details"
    assert detail["tags"] == ["automation"]


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
                capability_description="Builds Python APIs",
            )
        ],
    )

    details = wework_space.get_project(_token(test_user), str(project.id))

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
            "capability": "Builds Python APIs",
        }
    ]


def test_external_project_tools_route_list_read_and_assignment_to_provider(
    test_db: Session, test_user: User, monkeypatch
) -> None:
    project = _project(test_db, test_user, provider="gitlab")
    item_id = f"{project.project_key}-7"
    current = {
        "id": item_id,
        "cloud_project_id": str(project.id),
        "title": "Provider issue",
        "description": "Provider-owned details",
        "status": "in_progress",
        "priority": "medium",
        "tags": ["external"],
        "assignee_user_id": None,
        "assignee_agent_id": None,
        "version": 7,
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
        wework_space, "_manager_run_id", lambda *_args, **_kwargs: "run-1"
    )
    monkeypatch.setattr(
        wework_space.project_automation_execution,
        "assign_from_manager",
        assign_from_manager,
    )

    listed = wework_space.list_tasks(_token(test_user), str(project.id))
    detail = wework_space.get_task(_token(test_user), str(project.id), item_id)
    assigned = wework_space.assign_task(
        _token(test_user),
        str(project.id),
        item_id,
        "user",
        str(test_user.id),
    )

    assert listed[0]["description"] == "Provider-owned details"
    assert detail["id"] == item_id
    assert assigned["assignee_user_id"] == test_user.id
    assert [name for name, _ in calls] == ["list", "get", "assign"]
    assign_values = calls[-1][1]
    assert assign_values["run_id"] == "run-1"
    assert assign_values["assignee_type"] == "user"
    assert assign_values["task_id"] == item_id
