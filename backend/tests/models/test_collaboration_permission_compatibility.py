"""The permission model must work on populated v1 databases without DDL."""

from sqlalchemy import event, inspect, select

from app.models.delivery import CloudProject, LoopNode
from app.models.resource_member import ResourceMember
from app.schemas.base_role import BaseRole
from app.services.cloud_projects.responses import list_project_responses
from app.services.collaboration_permissions import collaboration_permission_service
from app.services.workspaces.responses import list_workspace_responses
from tests.api.test_collaboration_permission_contract import invite
from tests.api.test_collaboration_permission_contract import scope as scope


def test_cp01_no_new_database_columns_or_pending_migration(test_db):
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    columns = {
        column["name"] for column in inspect(test_db.bind).get_columns("loop_items")
    }
    assert not {"workspace_id", "membership_mode"} & columns
    assert not {"workspace_id", "membership_mode"} & set(
        LoopNode.__table__.columns.keys()
    )
    scripts = ScriptDirectory.from_config(Config("alembic.ini"))
    # The withdrawn prompt revision is a no-op retained for already-recorded
    # revision IDs. Keep the permission recovery baseline pinned.
    assert scripts.get_heads() == ["a9c4e7b2d610"]
    assert scripts.get_revision("a9c4e7b2d610").down_revision == "f3a7c9e1b2d4"


def test_cp01_new_project_preserves_v1_containment(test_db, scope):
    project = test_db.get(CloudProject, scope["project"]["id"])
    parent = (
        test_db.query(ResourceMember)
        .filter_by(
            resource_type="CloudProject",
            resource_id=int(project.id),
            entity_type="workspace",
            status="approved",
        )
        .one()
    )
    assert int(parent.entity_id) == project.workspace_id == int(scope["space"]["id"])
    assert parent.role == "Owner"


def test_cp01_cp05_legacy_writer_is_readable_without_data_rewrite(test_db, scope):
    original = test_db.get(CloudProject, scope["project"]["id"])
    legacy = CloudProject(
        name="Written by v1",
        created_by_user_id=original.created_by_user_id,
        public_id="legacy-public-id",
        project_key="LEGACY",
        metadata_json={"tags": []},
        status="active",
    )
    test_db.add(legacy)
    test_db.flush()
    grant = ResourceMember.create(
        resource_type="CloudProject",
        resource_id=int(legacy.id),
        entity_type="workspace",
        entity_id=str(original.workspace_id),
        role="Owner",
        status="approved",
    )
    owner = ResourceMember.create(
        resource_type="CloudProject",
        resource_id=int(legacy.id),
        entity_id=str(original.created_by_user_id),
        role="Owner",
        status="approved",
    )
    test_db.add_all([grant, owner])
    test_db.commit()
    before = [
        dict(row)
        for row in test_db.execute(select(ResourceMember.__table__)).mappings()
    ]
    statements = []

    def capture(_connection, _cursor, statement, _parameters, _context, _many):
        statements.append(statement)

    event.listen(test_db.bind, "before_cursor_execute", capture)
    try:
        rows = list_project_responses(test_db, scope["user"])
        assert rows == []
        decision = collaboration_permission_service.check(
            test_db, original.created_by_user_id, "manage", legacy.id
        )
        assert decision.allowed and decision.role == BaseRole.Maintainer
        assert legacy.membership_mode == "inherit"
    finally:
        event.remove(test_db.bind, "before_cursor_execute", capture)
    assert all(
        statement.lstrip().upper().startswith("SELECT") for statement in statements
    )
    assert [
        dict(row)
        for row in test_db.execute(select(ResourceMember.__table__)).mappings()
    ] == before
    assert owner.role == "Owner"


def test_cp03_restricted_mode_uses_existing_metadata_and_survives_v1_update(
    test_client, test_db, scope
):
    invite(test_client, scope, "Developer")
    project = test_db.get(CloudProject, scope["project"]["id"])
    updated = test_client.patch(
        f"/api/v1/cloud-projects/{project.id}",
        headers=scope["owner"],
        json={"version": project.version, "membership_mode": "restricted"},
    )
    assert updated.status_code == 200
    test_db.refresh(project)
    assert project.metadata_json["membership_mode"] == "restricted"
    project.metadata_json = {**project.metadata_json, "tags": ["v1-update"]}
    project.version += 1
    test_db.commit()
    assert not collaboration_permission_service.check(
        test_db, scope["user"].id, "read", project.id
    ).allowed


def test_cp01_ambiguous_parent_relationships_fail_closed(test_db, scope):
    project = test_db.get(CloudProject, scope["project"]["id"])
    test_db.add(
        ResourceMember.create(
            resource_type="CloudProject",
            resource_id=int(project.id),
            entity_type="workspace",
            entity_id="999",
            role="Owner",
            status="approved",
        )
    )
    test_db.commit()
    assert not collaboration_permission_service.check(
        test_db, project.created_by_user_id, "read", project.id
    ).allowed


def test_cp07_new_viewer_remains_visible_to_v1_space_queries(
    test_client, test_db, scope
):
    invite(test_client, scope, "Viewer")
    grant = (
        test_db.query(ResourceMember)
        .filter_by(
            resource_type="Workspace",
            resource_id=int(scope["space"]["id"]),
            entity_id=str(scope["user"].id),
        )
        .one()
    )
    assert grant.role == "Reporter"
    assert (
        list_workspace_responses(test_db, scope["user"].id)[0].access_role
        == BaseRole.Viewer
    )


def test_cp05_cp19_legacy_member_requests_never_assign_ownership(test_client, scope):
    for old, current in [("Owner", "Maintainer"), ("Reporter", "Viewer")]:
        response = test_client.post(
            f"/api/v1/cloud-projects/{scope['project']['id']}/members",
            headers=scope["owner"],
            json={"user_id": scope["user"].id, "role": old},
        )
        assert response.status_code == 201 and response.json()["role"] == current
    assert (
        test_client.get(
            f"/api/v1/workspaces/{scope['space']['id']}", headers=scope["owner"]
        ).json()["owner_user_id"]
        == scope["space"]["owner_user_id"]
    )


def test_cp05_legacy_public_edit_grant_is_read_only_without_rewrite(
    test_client, test_db, scope
):
    grant = ResourceMember.create(
        resource_type="CloudProject",
        resource_id=int(scope["project"]["id"]),
        entity_type="authenticated_users",
        entity_id="*",
        role="Developer",
        status="approved",
    )
    test_db.add(grant)
    test_db.commit()
    response = test_client.get(
        f"/api/v1/projects/{scope['project']['id']}", headers=scope["member"]
    )
    assert response.status_code == 200
    assert response.json()["access_role"] == "Viewer"
    assert response.json()["public_access"] == {"role": "Viewer"}
    assert grant.role == "Developer"
    assert not collaboration_permission_service.check(
        test_db, scope["user"].id, "execute", scope["project"]["id"]
    ).allowed


def test_cp09_cp11_legacy_inline_binding_keeps_existing_authorization(test_db, scope):
    from app.models.delivery import ProjectChatAgent

    agent = ProjectChatAgent(
        cloud_project_id=scope["project"]["id"],
        name="v1 Agent",
        created_by_user_id=scope["space"]["owner_user_id"],
        metadata_json={"runtime": "codex", "visibility": "creator_admin"},
    )
    test_db.add(agent)
    test_db.commit()
    assert (
        collaboration_permission_service.require_project_agent(
            test_db, scope["project"]["id"], agent.id
        ).id
        == agent.id
    )
    assert (
        not test_db.query(ResourceMember)
        .filter_by(entity_type="project_agent", entity_id=agent.id)
        .count()
    )


def test_cp11_legacy_team_binding_preserves_authorization_and_explicit_revocation(
    test_client, test_db, test_user, scope
):
    import pytest
    from fastapi import HTTPException

    from app.models.delivery import ProjectChatAgent
    from app.schemas.workspace import WorkspaceAgentCreate
    from app.services.workspaces import workspace_service
    from tests.api.test_workspace_shared_agents import _native_team

    team = _native_team(test_db, test_user)
    agent = ProjectChatAgent(
        cloud_project_id=scope["project"]["id"],
        name="v1 Team binding",
        created_by_user_id=test_user.id,
        metadata_json={
            "runtime": "wegent",
            "wegent_team_id": team.id,
            "visibility": "creator_admin",
        },
    )
    test_db.add(agent)
    test_db.commit()
    assert (
        collaboration_permission_service.require_project_team(
            test_db, scope["project"]["id"], team.id
        ).id
        == team.id
    )
    workspace_service.add_agent(
        test_db,
        int(scope["space"]["id"]),
        test_user.id,
        WorkspaceAgentCreate(team_id=team.id),
    )
    workspace_service.remove_agent(
        test_db, int(scope["space"]["id"]), team.id, test_user.id
    )
    with pytest.raises(HTTPException):
        collaboration_permission_service.require_project_team(
            test_db, scope["project"]["id"], team.id
        )


def test_cp19_legacy_space_creator_survives_transfer_without_bulk_backfill(
    test_client, test_db, scope
):
    from app.models.kind import Kind

    kind = test_db.get(Kind, int(scope["space"]["id"]))
    payload = dict(kind.json)
    payload["metadata"] = {
        key: value
        for key, value in payload["metadata"].items()
        if key != "createdByUserId"
    }
    kind.json = payload
    test_db.commit()
    result = test_client.post(
        f"/api/v1/workspaces/{kind.id}/transfer-ownership",
        headers=scope["owner"],
        json={"user_id": scope["user"].id, "version": scope["space"]["version"]},
    )
    assert result.status_code == 200
    assert result.json()["created_by_user_id"] == scope["space"]["owner_user_id"]
    assert result.json()["owner_user_id"] == scope["user"].id


def test_cp11_cp12_legacy_device_consent_is_fixed_and_revocable(test_db, scope):
    from app.models.delivery import ProjectChatAgent
    from app.models.kind import Kind
    from app.services.runner_routing import (
        project_environment_ids,
        revoke_legacy_environment_bindings,
    )

    owner_id = scope["space"]["owner_user_id"]
    selected = Kind(
        kind="Device",
        namespace="default",
        name="selected-v1-device",
        user_id=owner_id,
        is_active=True,
        json={"spec": {}},
    )
    unrelated = Kind(
        kind="Device",
        namespace="default",
        name="unselected-v1-device",
        user_id=owner_id,
        is_active=True,
        json={"spec": {}},
    )
    test_db.add_all([selected, unrelated])
    test_db.flush()
    agent = ProjectChatAgent(
        cloud_project_id=scope["project"]["id"],
        name="Owner-installed v1 device",
        device_id=selected.name,
        created_by_user_id=owner_id,
        metadata_json={"runtime": "codex", "visibility": "creator_admin"},
    )
    test_db.add(agent)
    test_db.commit()
    assert selected.id in project_environment_ids(test_db, scope["project"]["id"])
    assert unrelated.id not in project_environment_ids(test_db, scope["project"]["id"])
    revoke_legacy_environment_bindings(test_db, int(scope["space"]["id"]), selected.id)
    test_db.commit()
    assert selected.id not in project_environment_ids(test_db, scope["project"]["id"])


def test_cp11_modern_device_binding_never_uses_legacy_consent(test_db, scope):
    from app.models.delivery import ProjectChatAgent
    from app.models.kind import Kind
    from app.services.runner_routing import project_environment_ids

    owner_id = scope["space"]["owner_user_id"]
    device = Kind(
        kind="Device",
        namespace="default",
        name="v2-device",
        user_id=owner_id,
        is_active=True,
        json={"spec": {}},
    )
    test_db.add(device)
    test_db.flush()
    test_db.add(
        ProjectChatAgent(
            cloud_project_id=scope["project"]["id"],
            name="Modern binding",
            device_id=device.name,
            created_by_user_id=owner_id,
            metadata_json={"runtime": "codex", "authorization_version": 2},
        )
    )
    test_db.commit()
    assert device.id not in project_environment_ids(test_db, scope["project"]["id"])


def test_cp11_cp12_legacy_device_consent_cannot_be_borrowed_by_another_binding(
    test_db, scope
):
    from app.models.delivery import ProjectChatAgent
    from app.models.kind import Kind
    from app.services.runner_routing import execution_environment_ids

    owner_id = scope["space"]["owner_user_id"]
    pid = scope["project"]["id"]
    device = Kind(
        kind="Device",
        namespace="default",
        name="legacy-fixed",
        user_id=owner_id,
        is_active=True,
        json={"spec": {}},
    )
    test_db.add(device)
    test_db.flush()
    legacy = ProjectChatAgent(
        cloud_project_id=pid,
        name="Original legacy binding",
        device_id=device.name,
        created_by_user_id=owner_id,
        metadata_json={"runtime": "codex"},
    )
    modern = ProjectChatAgent(
        cloud_project_id=pid,
        name="Modern binding",
        device_id=device.name,
        created_by_user_id=owner_id,
        metadata_json={"runtime": "codex", "authorization_version": 2},
    )
    unrelated = ProjectChatAgent(
        cloud_project_id=pid,
        name="Unselected legacy binding",
        created_by_user_id=owner_id,
        metadata_json={"runtime": "codex"},
    )
    test_db.add_all([legacy, modern, unrelated])
    test_db.commit()
    assert device.id in execution_environment_ids(test_db, pid, legacy.id)
    assert device.id not in execution_environment_ids(test_db, pid, modern.id)
    assert device.id not in execution_environment_ids(test_db, pid, unrelated.id)
    assert device.id not in execution_environment_ids(test_db, pid, None)
    pending = ResourceMember.create(
        resource_type="Device",
        resource_id=device.id,
        entity_type="workspace",
        entity_id=str(scope["space"]["id"]),
        role="Developer",
        status="pending",
    )
    test_db.add(pending)
    test_db.commit()
    assert device.id not in execution_environment_ids(test_db, pid, legacy.id)
