"""Human-approved CP invariants: change policy only with explicit authorization."""

import uuid
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from app.core.security import create_access_token
from app.models.cloud_project import CloudProject
from app.models.resource_member import ResourceMember
from app.models.user import User
from app.schemas.base_role import BaseRole
from app.services.cloud_project_visibility import (
    project_membership_rows,
    project_participant_ids,
)
from app.services.cloud_projects.responses import (
    list_project_responses,
    project_response,
)
from app.services.cloud_projects.service import cloud_project_service
from app.services.collaboration_permissions import collaboration_permission_service


def read_project(test_db, project_id, user):
    try:
        project = cloud_project_service.get(test_db, project_id, user.id)
        return 200, project_response(test_db, project, user).model_dump()
    except HTTPException as error:
        return error.status_code, None


@pytest.fixture
def scope(test_client, test_db, test_token, monkeypatch):
    monkeypatch.setattr(
        "app.core.cache.cache_manager.mget_or_raise", AsyncMock(return_value={})
    )
    owner = {"Authorization": f"Bearer {test_token}"}
    space = test_client.post(
        "/api/v1/workspaces",
        headers=owner,
        json={"name": f"Contract {uuid.uuid4().hex[:6]}"},
    )
    assert space.status_code == 201, space.text
    project = test_client.post(
        f"/api/v1/workspaces/{space.json()['id']}/projects",
        headers=owner,
        json={"name": "Permission contract"},
    )
    assert project.status_code == 201, project.text
    user = User(
        user_name=f"contract-{uuid.uuid4().hex[:8]}",
        password_hash="unused",
        email="contract@example.com",
        is_active=True,
    )
    test_db.add(user)
    test_db.commit()
    member = {
        "Authorization": f"Bearer {create_access_token(data={'sub': user.user_name})}"
    }
    yield {
        "owner": owner,
        "member": member,
        "user": user,
        "space": space.json(),
        "project": project.json(),
    }


def invite(client, scope, role, *, project=False):
    url = (
        f"/api/v1/cloud-projects/{scope['project']['id']}/members"
        if project
        else f"/api/v1/workspaces/{scope['space']['id']}/members"
    )
    response = client.post(
        url, headers=scope["owner"], json={"user_id": scope["user"].id, "role": role}
    )
    assert response.status_code == 201, response.text


@pytest.mark.parametrize("space_role", ["Developer", "Viewer"])
@pytest.mark.parametrize("direct_role", ["Maintainer", "Developer", "Viewer"])
def test_cp08_patch_creates_project_override_for_inherited_member(
    test_client, test_db, scope, space_role, direct_role
):
    invite(test_client, scope, space_role)
    pid = scope["project"]["id"]
    workspace_grant = (
        test_db.query(ResourceMember)
        .filter_by(
            resource_type="Workspace",
            resource_id=int(scope["space"]["id"]),
            entity_type="user",
            entity_id=str(scope["user"].id),
        )
        .one()
    )
    stored_role = workspace_grant.role
    response = test_client.patch(
        f"/api/v1/cloud-projects/{pid}/members/{scope['user'].id}",
        headers=scope["owner"],
        json={"role": direct_role},
    )
    assert response.status_code == 200, response.text
    assert response.json()["role"] == direct_role
    assert response.json()["direct_role"] == direct_role
    assert response.json()["inherited_role"] == space_role
    test_db.refresh(workspace_grant)
    assert workspace_grant.role == stored_role
    assert workspace_grant.status == "approved"


def test_cp05_direct_viewer_overrides_ordinary_inheritance_everywhere(
    test_client, test_db, scope
):
    invite(test_client, scope, "Developer")
    invite(test_client, scope, "Viewer", project=True)
    pid = scope["project"]["id"]
    decision = collaboration_permission_service.check(
        test_db, scope["user"].id, "edit", pid
    )
    assert decision.role == BaseRole.Viewer
    assert not decision.allowed
    assert (
        list_project_responses(test_db, scope["user"])[0].access_role == BaseRole.Viewer
    )
    assert scope["user"].id not in project_participant_ids(
        test_db,
        test_db.get(CloudProject, pid),
        required_role=BaseRole.Developer,
    )


@pytest.mark.parametrize(
    "space_role", [None, "Owner", "Maintainer", "Developer", "Viewer"]
)
@pytest.mark.parametrize("direct_role", [None, "Maintainer", "Developer", "Viewer"])
@pytest.mark.parametrize("mode", ["inherit", "restricted"])
def test_cp02_cp03_cp05_role_precedence_and_restricted_projects(
    test_client, test_db, scope, space_role, direct_role, mode
):
    pid, wid = scope["project"]["id"], scope["space"]["id"]
    changed = test_client.patch(
        f"/api/v1/cloud-projects/{pid}",
        headers=scope["owner"],
        json={"version": scope["project"]["version"], "membership_mode": mode},
    )
    assert changed.status_code == 200, changed.text
    if direct_role:
        invite(test_client, scope, direct_role, project=True)
    if space_role == "Owner":
        changed = test_client.post(
            f"/api/v1/workspaces/{wid}/transfer-ownership",
            headers=scope["owner"],
            json={"user_id": scope["user"].id, "version": scope["space"]["version"]},
        )
        assert changed.status_code == 200, changed.text
    elif space_role:
        invite(test_client, scope, space_role)
    inherited = (
        "Maintainer"
        if space_role in {"Owner", "Maintainer"}
        else space_role if mode == "inherit" else None
    )
    ranks = {"Maintainer": 0, "Developer": 1, "Viewer": 2}
    expected = "Maintainer" if inherited == "Maintainer" else direct_role or inherited
    detail_status, detail = read_project(test_db, pid, scope["user"])
    assert detail_status == (200 if expected else 404)
    if expected:
        assert detail["access_role"] == expected
    projects = {row.id: row for row in list_project_responses(test_db, scope["user"])}
    assert (pid in projects) == (expected is not None)
    if expected:
        assert projects[pid].access_role.value == expected
    roster = test_client.get(
        f"/api/v1/cloud-projects/{pid}/members", headers=scope["owner"]
    )
    assert roster.status_code == 200, roster.text
    rows = [row for row in roster.json() if row["user_id"] == scope["user"].id]
    assert len(rows) == int(expected is not None)
    if rows:
        assert rows[0]["role"] == expected
        assert rows[0]["can_be_assignee"] == (ranks[expected] <= 1)
    project = test_db.get(CloudProject, pid)
    for required_role in (BaseRole.Viewer, BaseRole.Developer, BaseRole.Maintainer):
        assert (
            scope["user"].id
            in project_participant_ids(test_db, project, required_role=required_role)
        ) == (expected is not None and ranks[expected] <= ranks[required_role.value])
    for action in ("read", "manage", "edit", "comment", "assign", "execute"):
        decision = collaboration_permission_service.check(
            test_db, scope["user"].id, action, pid
        )
        required = 2 if action == "read" else 0 if action == "manage" else 1
        assert decision.allowed == (
            expected is not None and ranks[expected] <= required
        )


@pytest.mark.parametrize("role", ["Viewer", "Developer", "Maintainer"])
def test_cp04_project_guest_does_not_inherit_upward(test_client, test_db, scope, role):
    invite(test_client, scope, role, project=True)
    wid = scope["space"]["id"]
    pid = scope["project"]["id"]
    detail_status, detail = read_project(test_db, pid, scope["user"])
    assert detail_status == 200
    assert detail["access_role"] == role
    assert detail["workspace_context"]["id"] == wid
    workspace_ids = {
        row["id"]
        for row in test_client.get(
            "/api/v1/workspaces", headers=scope["member"]
        ).json()["items"]
    }
    assert wid not in workspace_ids
    for path in ("", "/members", "/agents", "/execution-environments"):
        assert (
            test_client.get(
                f"/api/v1/workspaces/{wid}{path}", headers=scope["member"]
            ).status_code
            == 404
        )
    sibling = test_client.post(
        f"/api/v1/workspaces/{wid}/projects",
        headers=scope["owner"],
        json={"name": "Sibling"},
    ).json()
    assert read_project(test_db, sibling["id"], scope["user"])[0] == 404
    # HTTP list ownership moved to Rust; retain source-service contract coverage.
    listed_projects = [
        row.model_dump() for row in list_project_responses(test_db, scope["user"])
    ]
    assert pid in {row["id"] for row in listed_projects}
    assert sibling["id"] not in {row["id"] for row in listed_projects}


def test_cp07_cp08_cp20_viewer_and_membership_provenance(test_client, scope):
    invite(test_client, scope, "Viewer")
    pid, wid = scope["project"]["id"], scope["space"]["id"]
    assert (
        test_client.get(
            f"/api/v1/workspaces/{wid}", headers=scope["member"]
        ).status_code
        == 200
    )
    assert wid in {
        row["id"]
        for row in test_client.get(
            "/api/v1/workspaces", headers=scope["member"]
        ).json()["items"]
    }
    roster = test_client.get(
        f"/api/v1/cloud-projects/{pid}/members", headers=scope["member"]
    ).json()
    row = next(row for row in roster if row["user_id"] == scope["user"].id)
    assert row["role"] == "Viewer"
    assert row["direct_role"] is None
    assert row["inherited_role"] == "Viewer"
    assert row["inherited_from_workspace_id"] == wid
    assert row["permission_sources"] == [
        {"type": "workspace", "workspace_id": wid, "role": "Viewer"}
    ]
    assert not row["can_be_assignee"]
    assert (
        test_client.post(
            f"/api/v1/cloud-projects/{pid}/loop-items",
            headers=scope["member"],
            json={"title": "Forbidden"},
        ).status_code
        == 403
    )


@pytest.mark.parametrize("target_status", ["in_progress", "in_review", "completed"])
def test_cp07_viewer_cannot_change_issue_status(test_client, scope, target_status):
    invite(test_client, scope, "Viewer")
    pid = scope["project"]["id"]
    created = test_client.post(
        f"/api/v1/cloud-projects/{pid}/loop-items",
        headers=scope["owner"],
        json={"title": "Status permission contract"},
    )
    assert created.status_code == 201, created.text
    issue = created.json()
    changed = test_client.patch(
        f"/api/v1/loop-items/{issue['id']}",
        headers=scope["member"],
        json={
            "version": issue["version"],
            "status": target_status,
        },
    )
    assert changed.status_code == 403, changed.text
    current = test_client.get(
        f"/api/v1/loop-items/{issue['id']}", headers=scope["owner"]
    ).json()
    assert (current["status"], current["version"]) == (
        issue["status"],
        issue["version"],
    )


@pytest.mark.parametrize("membership_mode", ["inherit", "restricted"])
def test_cp05_cp08_batch_sources_keep_role_precedence_and_rejected_grants(
    test_client, test_db, scope, membership_mode
):
    invite(test_client, scope, "Developer")
    invite(test_client, scope, "Viewer", project=True)
    project = test_db.get(CloudProject, scope["project"]["id"])
    project.membership_mode = membership_mode
    test_db.flush()
    owner_id, member_id = scope["space"]["owner_user_id"], scope["user"].id
    workspace, grants = project_membership_rows(test_db, project)

    sources = collaboration_permission_service.project_sources_many(
        project,
        [test_db.get(User, owner_id), scope["user"]],
        workspace=workspace,
        grants=grants,
    )

    for user_id in (owner_id, member_id):
        assert sources[user_id] == collaboration_permission_service.project_sources(
            test_db, project, user_id
        )
    assert sources[owner_id][0]["role"] == "Maintainer"
    assert sources[member_id][-1] == {"type": "direct", "role": "Viewer"}
    rows = cloud_project_service.list_members(test_db, project.id, owner_id)
    row = next(row for row in rows if row["user_id"] == member_id)
    assert row["role"] == "Viewer"
    assert row["inherited_role"] == (
        "Developer" if membership_mode == "inherit" else None
    )
    grant = (
        test_db.query(ResourceMember)
        .filter_by(
            resource_type="CloudProject",
            resource_id=int(project.id),
            entity_type="user",
            entity_id=str(member_id),
        )
        .one()
    )
    grant.status = "rejected"
    test_db.flush()
    sources = collaboration_permission_service.project_sources_many(
        project, [scope["user"]], workspace=workspace, grants=grants
    )
    assert all(source["type"] != "direct" for source in sources[member_id])
    assert bool(sources[member_id]) == (membership_mode == "inherit")


def test_cp08_lower_direct_role_never_masks_space_administration(
    test_client, test_db, scope
):
    invite(test_client, scope, "Maintainer")
    invite(test_client, scope, "Viewer", project=True)
    pid = scope["project"]["id"]
    rows = test_client.get(
        f"/api/v1/cloud-projects/{pid}/members", headers=scope["member"]
    ).json()
    row = next(row for row in rows if row["user_id"] == scope["user"].id)
    assert (row["role"], row["direct_role"], row["inherited_role"]) == (
        "Maintainer",
        "Viewer",
        "Maintainer",
    )
    removed = test_client.delete(
        f"/api/v1/cloud-projects/{pid}/members/{scope['user'].id}",
        headers=scope["owner"],
    )
    assert removed.status_code == 204
    assert read_project(test_db, pid, scope["user"])[1]["access_role"] == "Maintainer"


def test_cp06_cp17_cp19_creator_is_audit_only_and_ownership_transfers(
    test_client, test_db, scope
):
    wid, pid = scope["space"]["id"], scope["project"]["id"]
    old_owner = scope["space"]["owner_user_id"]
    invite(test_client, scope, "Maintainer")
    denied = test_client.post(
        f"/api/v1/workspaces/{wid}/transfer-ownership",
        headers=scope["member"],
        json={"user_id": scope["user"].id, "version": scope["space"]["version"]},
    )
    assert denied.status_code == 403
    transferred = test_client.post(
        f"/api/v1/workspaces/{wid}/transfer-ownership",
        headers=scope["owner"],
        json={"user_id": scope["user"].id, "version": scope["space"]["version"]},
    )
    assert transferred.status_code == 200, transferred.text
    assert transferred.json()["created_by_user_id"] == old_owner
    assert transferred.json()["owner_user_id"] == scope["user"].id
    removed = test_client.delete(
        f"/api/v1/workspaces/{wid}/members/{old_owner}", headers=scope["member"]
    )
    assert removed.status_code == 204, removed.text
    old_owner_user = test_db.get(User, old_owner)
    assert read_project(test_db, pid, old_owner_user)[0] == 404


def test_cp09_cp13_enabled_agents_and_assignment_entry_points(test_client, scope):
    invite(test_client, scope, "Developer")
    pid = scope["project"]["id"]
    agent = test_client.post(
        f"/api/v1/cloud-projects/{pid}/chat-agents",
        headers=scope["owner"],
        json={"name": "Shared project agent"},
    )
    assert agent.status_code == 201, agent.text
    aid = agent.json()["id"]
    visible = test_client.get(
        f"/api/v1/cloud-projects/{pid}/chat-agents", headers=scope["member"]
    ).json()
    assert aid in {row["id"] for row in visible}
    assert visible[0]["canUse"]
    assert not visible[0]["canEdit"]
    private = test_client.post(
        f"/api/v1/cloud-projects/{pid}/chat-agents",
        headers=scope["owner"],
        json={"name": "Hidden", "visibility": "private"},
    )
    assert private.status_code == 201
    member_agents = test_client.get(
        f"/api/v1/cloud-projects/{pid}/chat-agents", headers=scope["member"]
    ).json()
    assert private.json()["id"] not in {row["id"] for row in member_agents}
    rejected = test_client.post(
        f"/api/v1/cloud-projects/{pid}/loop-items",
        headers=scope["member"],
        json={
            "title": "Private Agent injection",
            "assignee_agent_id": private.json()["id"],
        },
    )
    assert rejected.status_code == 403
    plain = test_client.post(
        f"/api/v1/cloud-projects/{pid}/loop-items",
        headers=scope["member"],
        json={"title": "Assign later"},
    )
    assert plain.status_code == 201, plain.text
    issue = plain.json()
    assigned = test_client.post(
        f"/api/v1/cloud-projects/{pid}/loop-items/{issue['id']}/assign",
        headers=scope["member"],
        json={
            "version": issue["version"],
            "assignee_type": "agent",
            "assignee_id": aid,
        },
    )
    assert assigned.status_code == 200, assigned.text
    created = test_client.post(
        f"/api/v1/cloud-projects/{pid}/loop-items",
        headers=scope["member"],
        json={"title": "Assign at create", "assignee_agent_id": aid},
    )
    assert created.status_code == 201, created.text
    later = test_client.post(
        f"/api/v1/cloud-projects/{pid}/loop-items",
        headers=scope["member"],
        json={"title": "Assign at update"},
    ).json()
    updated = test_client.patch(
        f"/api/v1/loop-items/{later['id']}",
        headers=scope["member"],
        json={"version": later["version"], "assignee_agent_id": aid},
    )
    assert updated.status_code == 200, updated.text
    invite(test_client, scope, "Viewer")
    for path, body in (
        (
            f"/api/v1/cloud-projects/{pid}/loop-items",
            {"title": "Rejected", "assignee_agent_id": aid},
        ),
        (
            f"/api/v1/cloud-projects/{pid}/loop-items/{later['id']}/assign",
            {
                "version": updated.json()["version"],
                "assignee_type": "agent",
                "assignee_id": aid,
            },
        ),
    ):
        assert (
            test_client.post(path, headers=scope["member"], json=body).status_code
            == 403
        )


@pytest.fixture
def test_client(test_client):
    """Exercise retained Python HTTP components in an isolated application."""
    from tests.retained_python_handlers import component_client

    with component_client(test_client, ("project_members", "workspaces")) as client:
        yield client
