# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for cloud TODO (loop item) MCP tools on the delivery server."""

import uuid
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.core.security import get_password_hash
from app.mcp_server.tools import delivery as delivery_tools
from app.models.cloud_project import CloudProject
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.user import User


@pytest.fixture(autouse=True)
def patch_session_local(monkeypatch: pytest.MonkeyPatch, test_db: Session) -> None:
    monkeypatch.setattr(delivery_tools, "SessionLocal", lambda: test_db)


@pytest.fixture
def project(test_db: Session, test_user: User) -> CloudProject:
    public_id = str(uuid.uuid4())
    project = CloudProject(
        public_id=public_id,
        project_key="MCP",
        name="MCP project",
        description="",
        created_by_user_id=test_user.id,
        storage_prefix=f"projects/{public_id}",
    )
    test_db.add(project)
    test_db.commit()
    test_db.refresh(project)
    return project


@pytest.fixture
def owner_info(test_user: User) -> SimpleNamespace:
    return SimpleNamespace(user_id=test_user.id)


@pytest.fixture
def member_user(test_db: Session) -> User:
    user = User(
        user_name="memberuser",
        password_hash=get_password_hash("memberpassword123"),
        email="member@example.com",
        is_active=True,
        git_info=None,
    )
    test_db.add(user)
    test_db.commit()
    test_db.refresh(user)
    return user


def _add_member(db: Session, project: CloudProject, user: User, role: str) -> None:
    db.add(
        ResourceMember(
            resource_type=ResourceType.CLOUD_PROJECT.value,
            resource_id=project.id,
            entity_type="user",
            entity_id=str(user.id),
            user_id=user.id,
            role=role,
            status=MemberStatus.APPROVED.value,
        )
    )
    db.commit()


def test_create_and_get_cloud_todo(
    project: CloudProject, owner_info: SimpleNamespace
) -> None:
    created = delivery_tools.create_cloud_todo(
        project.id,
        "Write docs",
        owner_info,
        description="Document the MCP tools",
        priority="high",
        due_at="2026-01-02T03:04:05",
    )

    assert created["id"].startswith("MCP-")
    assert created["title"] == "Write docs"
    assert created["status"] == "inbox"
    assert created["priority"] == "high"
    assert created["version"] == 1
    assert created["deletedAt"] is None
    assert created["dueAt"].year == 2026

    fetched = delivery_tools.get_cloud_todo(created["id"], owner_info)
    assert fetched["description"] == "Document the MCP tools"

    listed = delivery_tools.list_cloud_todos(project.id, owner_info)
    assert [item["id"] for item in listed["items"]] == [created["id"]]


def test_get_cloud_todo_missing_returns_404(
    owner_info: SimpleNamespace,
) -> None:
    with pytest.raises(HTTPException) as exc_info:
        delivery_tools.get_cloud_todo("MCP-999", owner_info)
    assert exc_info.value.status_code == 404


def test_update_cloud_todo_and_version_conflict(
    project: CloudProject, owner_info: SimpleNamespace
) -> None:
    created = delivery_tools.create_cloud_todo(project.id, "Task", owner_info)

    updated = delivery_tools.update_cloud_todo(
        created["id"],
        created["version"],
        owner_info,
        title="Task v2",
        status="in_progress",
    )
    assert updated["title"] == "Task v2"
    assert updated["status"] == "in_progress"
    assert updated["version"] == created["version"] + 1

    with pytest.raises(HTTPException) as exc_info:
        delivery_tools.update_cloud_todo(
            created["id"], created["version"], owner_info, title="stale"
        )
    assert exc_info.value.status_code == 409


def test_deleted_todo_is_hidden_from_get_list_and_update(
    project: CloudProject, owner_info: SimpleNamespace
) -> None:
    created = delivery_tools.create_cloud_todo(project.id, "Doomed", owner_info)

    deleted = delivery_tools.delete_cloud_todo(created["id"], owner_info)
    assert deleted["deletedAt"] is not None
    assert deleted["version"] == created["version"] + 1

    assert delivery_tools.list_cloud_todos(project.id, owner_info)["items"] == []

    with pytest.raises(HTTPException) as exc_info:
        delivery_tools.get_cloud_todo(created["id"], owner_info)
    assert exc_info.value.status_code == 404

    with pytest.raises(HTTPException) as exc_info:
        delivery_tools.update_cloud_todo(
            created["id"], deleted["version"], owner_info, title="nope"
        )
    assert exc_info.value.status_code == 404

    # Deleting twice reports the TODO as gone instead of succeeding silently.
    with pytest.raises(HTTPException) as exc_info:
        delivery_tools.delete_cloud_todo(created["id"], owner_info)
    assert exc_info.value.status_code == 404


def test_recycle_bin_and_restore(
    project: CloudProject, owner_info: SimpleNamespace
) -> None:
    first = delivery_tools.create_cloud_todo(project.id, "First", owner_info)
    second = delivery_tools.create_cloud_todo(project.id, "Second", owner_info)
    kept = delivery_tools.create_cloud_todo(project.id, "Kept", owner_info)
    delivery_tools.delete_cloud_todo(first["id"], owner_info)
    delivery_tools.delete_cloud_todo(second["id"], owner_info)

    recycle_bin = delivery_tools.list_cloud_todo_recycle_bin(project.id, owner_info)
    assert {item["id"] for item in recycle_bin["items"]} == {
        first["id"],
        second["id"],
    }
    assert all(item["deletedAt"] is not None for item in recycle_bin["items"])

    restored = delivery_tools.restore_cloud_todo(first["id"], owner_info)
    assert restored["deletedAt"] is None
    assert restored["version"] == first["version"] + 2

    listed_ids = {
        item["id"]
        for item in delivery_tools.list_cloud_todos(project.id, owner_info)["items"]
    }
    assert listed_ids == {first["id"], kept["id"]}

    recycle_bin = delivery_tools.list_cloud_todo_recycle_bin(project.id, owner_info)
    assert [item["id"] for item in recycle_bin["items"]] == [second["id"]]

    # Restoring a TODO that is not deleted is a conflict.
    with pytest.raises(HTTPException) as exc_info:
        delivery_tools.restore_cloud_todo(first["id"], owner_info)
    assert exc_info.value.status_code == 409


def test_create_with_deleted_parent_is_rejected(
    project: CloudProject, owner_info: SimpleNamespace
) -> None:
    parent = delivery_tools.create_cloud_todo(project.id, "Parent", owner_info)
    delivery_tools.delete_cloud_todo(parent["id"], owner_info)

    with pytest.raises(HTTPException) as exc_info:
        delivery_tools.create_cloud_todo(
            project.id, "Child", owner_info, parent_id=parent["id"]
        )
    assert exc_info.value.status_code == 422


def test_write_tools_require_developer_role(
    test_db: Session,
    project: CloudProject,
    owner_info: SimpleNamespace,
    member_user: User,
) -> None:
    _add_member(test_db, project, member_user, "Reporter")
    reporter_info = SimpleNamespace(user_id=member_user.id)
    created = delivery_tools.create_cloud_todo(project.id, "Owned", owner_info)

    # Reporter can read, including the recycle bin.
    assert delivery_tools.get_cloud_todo(created["id"], reporter_info)["id"] == (
        created["id"]
    )
    assert delivery_tools.list_cloud_todo_recycle_bin(project.id, reporter_info) == {
        "items": []
    }

    with pytest.raises(HTTPException) as exc_info:
        delivery_tools.create_cloud_todo(project.id, "Nope", reporter_info)
    assert exc_info.value.status_code == 403

    with pytest.raises(HTTPException) as exc_info:
        delivery_tools.update_cloud_todo(
            created["id"], created["version"], reporter_info, title="Nope"
        )
    assert exc_info.value.status_code == 403

    with pytest.raises(HTTPException) as exc_info:
        delivery_tools.delete_cloud_todo(created["id"], reporter_info)
    assert exc_info.value.status_code == 403


def test_tools_require_project_membership(
    project: CloudProject,
    owner_info: SimpleNamespace,
    member_user: User,
) -> None:
    outsider_info = SimpleNamespace(user_id=member_user.id)
    created = delivery_tools.create_cloud_todo(project.id, "Owned", owner_info)

    with pytest.raises(HTTPException) as exc_info:
        delivery_tools.get_cloud_todo(created["id"], outsider_info)
    assert exc_info.value.status_code == 404

    with pytest.raises(HTTPException) as exc_info:
        delivery_tools.create_cloud_todo(project.id, "Nope", outsider_info)
    assert exc_info.value.status_code == 404


def test_collaborator_tools(
    test_db: Session,
    project: CloudProject,
    owner_info: SimpleNamespace,
    member_user: User,
) -> None:
    _add_member(test_db, project, member_user, "Reporter")
    created = delivery_tools.create_cloud_todo(project.id, "Shared", owner_info)

    added = delivery_tools.add_cloud_todo_collaborator(
        created["id"], member_user.id, owner_info
    )
    assert added["userId"] == member_user.id
    assert added["userName"] == "memberuser"

    listed = delivery_tools.list_cloud_todo_collaborators(created["id"], owner_info)
    assert [row["userId"] for row in listed["collaborators"]] == [member_user.id]

    removed = delivery_tools.remove_cloud_todo_collaborator(
        created["id"], member_user.id, owner_info
    )
    assert removed == {
        "removed": True,
        "loopItemId": created["id"],
        "userId": member_user.id,
    }

    with pytest.raises(HTTPException) as exc_info:
        delivery_tools.remove_cloud_todo_collaborator(
            created["id"], member_user.id, owner_info
        )
    assert exc_info.value.status_code == 404


def test_collaborator_target_must_be_project_member(
    project: CloudProject,
    owner_info: SimpleNamespace,
    member_user: User,
) -> None:
    created = delivery_tools.create_cloud_todo(project.id, "Shared", owner_info)

    with pytest.raises(HTTPException) as exc_info:
        delivery_tools.add_cloud_todo_collaborator(
            created["id"], member_user.id, owner_info
        )
    assert exc_info.value.status_code == 404


def test_attachment_listing_and_deleted_item(
    project: CloudProject, owner_info: SimpleNamespace
) -> None:
    created = delivery_tools.create_cloud_todo(project.id, "Docs", owner_info)

    assert delivery_tools.list_cloud_todo_attachments(created["id"], owner_info) == {
        "attachments": []
    }

    delivery_tools.delete_cloud_todo(created["id"], owner_info)
    with pytest.raises(HTTPException) as exc_info:
        delivery_tools.list_cloud_todo_attachments(created["id"], owner_info)
    assert exc_info.value.status_code == 404


def test_create_cloud_project_with_name_only(owner_info: SimpleNamespace) -> None:
    created = delivery_tools.create_cloud_project("Side Project", owner_info)

    assert created["name"] == "Side Project"
    assert created["description"] == ""
    # The key is generated from the name when project_key is omitted.
    assert created["key"].startswith("SIDEPROJ")

    # The creator is the Owner, so the project is listed as accessible.
    listed = delivery_tools.list_cloud_projects(owner_info)
    assert created["id"] in {item["id"] for item in listed["projects"]}


def test_create_cloud_project_uppercases_project_key(
    owner_info: SimpleNamespace,
) -> None:
    created = delivery_tools.create_cloud_project(
        "Wegent", owner_info, project_key="weg", description="Agent OS"
    )

    assert created["key"] == "WEG"
    assert created["description"] == "Agent OS"

    # The key prefixes TODO numbering, e.g. WEG-18.
    todo = delivery_tools.create_cloud_todo(created["id"], "First", owner_info)
    assert todo["id"].startswith("WEG-")


def test_create_cloud_project_rejects_invalid_project_key(
    owner_info: SimpleNamespace,
) -> None:
    # Too short (min 2 characters).
    with pytest.raises(ValidationError):
        delivery_tools.create_cloud_project("Bad", owner_info, project_key="x")

    # Non-alphanumeric characters are not allowed.
    with pytest.raises(ValidationError):
        delivery_tools.create_cloud_project("Bad", owner_info, project_key="W-E G")

    # Too long (max 16 characters).
    with pytest.raises(ValidationError):
        delivery_tools.create_cloud_project("Bad", owner_info, project_key="X" * 17)


def test_resolve_cloud_reference_without_project_id_lists_accessible_projects(
    project: CloudProject,
    owner_info: SimpleNamespace,
) -> None:
    # A bare `cloud://projects` reference resolves to every accessible project.
    resolved = delivery_tools.resolve_cloud_reference("cloud://projects", owner_info)

    assert "error" not in resolved
    assert {
        "id": project.id,
        "key": project.project_key,
        "name": project.name,
        "description": project.description,
    } in resolved["projects"]
