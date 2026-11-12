"""Group crew management keeps roster and resource authority independent."""

import pytest
from fastapi import HTTPException

from app.models.delivery import CollaborationChatGroup, ProjectChatAgent
from app.models.kind import Kind
from app.models.resource_member import ResourceMember
from app.schemas.workspace import (
    CollaborationGroupCreate,
    CollaborationGroupMember,
    CollaborationGroupResponse,
    CollaborationGroupUpdate,
)
from app.services.chat_group_access import GROUP_RESOURCE_TYPE
from app.services.group_resource_permissions import share_group_agent
from app.services.workspaces import workspace_service
from tests.services.test_thread_participation import make_group, person


def human(user):
    return CollaborationGroupMember(kind="human", id=str(user.id), name=user.user_name)


def draft(user, name="Review crew"):
    member = human(user)
    return CollaborationGroupCreate(name=name, leader=member, members=[member])


def crew_count(db):
    return db.query(Kind).filter_by(kind="CollaborationGroup").count()


def test_existing_http_crew_routes_support_group_without_workspace(
    test_client, test_db, test_user, test_token
):
    group = make_group(test_db, test_user, [])
    test_db.commit()
    headers = {"Authorization": f"Bearer {test_token}"}
    path = f"/api/v1/cloud-projects/{group.id}/collaboration-groups"
    created = test_client.post(
        path, headers=headers, json=draft(test_user).model_dump(mode="json")
    )
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["workspace_id"] is None
    assert body["owner_type"] == "chat_group"
    assert body["owner_id"] == body["binding_owner_id"] == group.id
    listed = test_client.get(path, headers=headers)
    assert listed.status_code == 200, listed.text
    assert listed.json()["items"][0]["id"] == body["id"]
    changed = test_client.patch(
        f"{path}/{body['id']}",
        headers=headers,
        json={"version": body["version"], "description": "HTTP update"},
    )
    assert changed.status_code == 200, changed.text
    assert changed.json()["description"] == "HTTP update"
    removed = test_client.delete(f"{path}/{body['id']}", headers=headers)
    assert removed.status_code == 204, removed.text
    assert test_client.get(path, headers=headers).json()["items"] == []


def make_agent(db, group, user, *, private=False):
    row = ProjectChatAgent(
        cloud_project_id=group.id,
        name="Review agent",
        title="Review agent",
        description="",
        created_by_user_id=user.id,
        metadata_json={
            "authorization_version": 2,
            "runtime": "codex",
            "visibility": "private" if private else "public",
        },
    )
    db.add(row)
    db.flush()
    share_group_agent(db, group, row, user.id)
    return row


def test_group_crew_crud_uses_real_group_scope_and_existing_schema(test_db, test_user):
    group = make_group(test_db, test_user, [])
    created = workspace_service.create_project_collaboration_group(
        test_db, int(group.id), test_user.id, draft(test_user)
    )
    response = CollaborationGroupResponse.model_validate(created)
    assert response.workspace_id is None
    assert response.owner_type == "chat_group"
    assert str(response.owner_id) == group.id
    assert str(response.binding_owner_id) == group.id
    stored = test_db.get(Kind, created["id"])
    assert stored.namespace == f"chat-groups/{group.id}"
    assert stored.user_id == test_user.id
    assert (
        workspace_service.list_project_collaboration_groups(
            test_db, int(group.id), test_user.id
        )[0]["id"]
        == created["id"]
    )
    updated = workspace_service.update_project_collaboration_group(
        test_db,
        int(group.id),
        created["id"],
        test_user.id,
        CollaborationGroupUpdate(version=1, instructions="Review and hand off"),
    )
    assert updated["version"] == 2
    assert updated["instructions"] == "Review and hand off"
    workspace_service.remove_project_collaboration_group(
        test_db, int(group.id), created["id"], test_user.id
    )
    assert (
        workspace_service.list_project_collaboration_groups(
            test_db, int(group.id), test_user.id
        )
        == []
    )
    assert test_db.get(Kind, created["id"]).is_active is False
    assert (
        test_db.query(ResourceMember)
        .filter_by(resource_type="CollaborationGroup", entity_type="project")
        .count()
        == 0
    )


@pytest.mark.parametrize("role", ["Developer", "Viewer"])
def test_members_can_read_but_cannot_configure_crews(test_db, test_user, role):
    member = person(test_db, "reader")
    group = make_group(test_db, test_user, [(member, role)])
    crew = workspace_service.create_project_collaboration_group(
        test_db, int(group.id), test_user.id, draft(test_user)
    )
    assert (
        workspace_service.list_project_collaboration_groups(
            test_db, int(group.id), member.id
        )[0]["id"]
        == crew["id"]
    )
    for operation in (
        lambda: workspace_service.create_project_collaboration_group(
            test_db, int(group.id), member.id, draft(member)
        ),
        lambda: workspace_service.update_project_collaboration_group(
            test_db,
            int(group.id),
            crew["id"],
            member.id,
            CollaborationGroupUpdate(version=1, name="Changed"),
        ),
        lambda: workspace_service.remove_project_collaboration_group(
            test_db, int(group.id), crew["id"], member.id
        ),
    ):
        with pytest.raises(HTTPException) as denied:
            operation()
        assert denied.value.status_code == 403
    assert crew_count(test_db) == 1
    assert test_db.get(Kind, crew["id"]).name == "Review crew"


def test_group_roster_membership_is_required_for_human_crew_members(test_db, test_user):
    outsider = person(test_db, "outsider")
    group = make_group(test_db, test_user, [])
    with pytest.raises(HTTPException) as denied:
        workspace_service.create_project_collaboration_group(
            test_db, int(group.id), test_user.id, draft(outsider)
        )
    assert denied.value.status_code == 422
    assert crew_count(test_db) == 0


def test_group_crew_agent_requires_its_own_current_resource_grant(test_db, test_user):
    group = make_group(test_db, test_user, [])
    agent = make_agent(test_db, group, test_user)
    member = CollaborationGroupMember(kind="agent", id=agent.id, name=agent.name)
    crew = workspace_service.create_project_collaboration_group(
        test_db,
        int(group.id),
        test_user.id,
        CollaborationGroupCreate(name="Agent crew", leader=member, members=[member]),
    )
    grant = (
        test_db.query(ResourceMember)
        .filter_by(
            resource_type=GROUP_RESOURCE_TYPE,
            resource_id=int(group.id),
            entity_type="project_agent",
            entity_id=agent.id,
        )
        .one()
    )
    grant.status = "rejected"
    test_db.flush()
    with pytest.raises(HTTPException) as revoked:
        workspace_service.update_project_collaboration_group(
            test_db,
            int(group.id),
            crew["id"],
            test_user.id,
            CollaborationGroupUpdate(version=1, description="Must not save"),
        )
    assert revoked.value.status_code == 422
    stored = test_db.get(Kind, crew["id"])
    assert stored.json["status"]["version"] == 1
    assert stored.json["spec"]["description"] == ""


def test_group_administrator_cannot_install_another_members_private_agent_in_crew(
    test_db, test_user
):
    admin = person(test_db, "other-admin")
    group = make_group(test_db, test_user, [(admin, "Maintainer")])
    agent = make_agent(test_db, group, test_user, private=True)
    member = CollaborationGroupMember(kind="agent", id=agent.id)
    with pytest.raises(HTTPException) as denied:
        workspace_service.create_project_collaboration_group(
            test_db,
            int(group.id),
            admin.id,
            CollaborationGroupCreate(
                name="Private agent", leader=member, members=[member]
            ),
        )
    assert denied.value.status_code == 422
    assert crew_count(test_db) == 0


def test_crew_configuration_rejects_foreign_binding_and_archived_group_without_writes(
    test_db, test_user
):
    group = make_group(test_db, test_user, [])
    foreign = CollaborationChatGroup(
        name="Other group",
        project_key="OTHER",
        description="",
        created_by_user_id=test_user.id,
        metadata_json={},
    )
    test_db.add(foreign)
    test_db.flush()
    other_agent = ProjectChatAgent(
        cloud_project_id=foreign.id,
        name="Foreign",
        title="Foreign",
        created_by_user_id=test_user.id,
        metadata_json={},
    )
    test_db.add(other_agent)
    test_db.flush()
    member = CollaborationGroupMember(kind="agent", id=other_agent.id)
    with pytest.raises(HTTPException) as wrong_owner:
        workspace_service.create_project_collaboration_group(
            test_db,
            int(group.id),
            test_user.id,
            CollaborationGroupCreate(
                name="Wrong scope", leader=member, members=[member]
            ),
        )
    assert wrong_owner.value.status_code == 422
    group.status = "archived"
    test_db.flush()
    with pytest.raises(HTTPException) as archived:
        workspace_service.create_project_collaboration_group(
            test_db, int(group.id), test_user.id, draft(test_user)
        )
    assert archived.value.status_code == 409
    assert crew_count(test_db) == 0


def test_crew_stale_version_preserves_original_configuration(test_db, test_user):
    group = make_group(test_db, test_user, [])
    crew = workspace_service.create_project_collaboration_group(
        test_db, int(group.id), test_user.id, draft(test_user)
    )
    with pytest.raises(HTTPException) as stale:
        workspace_service.update_project_collaboration_group(
            test_db,
            int(group.id),
            crew["id"],
            test_user.id,
            CollaborationGroupUpdate(version=2, instructions="Wrong version"),
        )
    assert stale.value.status_code == 409
    assert test_db.get(Kind, crew["id"]).json["status"]["version"] == 1


def test_explicit_crew_sharing_preserves_definition_owner_and_revokes_only_target_binding(
    test_db, test_user
):
    source = make_group(test_db, test_user, [])
    source.project_key = "SOURCE"
    test_db.flush()
    target = make_group(test_db, test_user, [])
    original = workspace_service.create_project_collaboration_group(
        test_db, int(source.id), test_user.id, draft(test_user)
    )
    shared = workspace_service.add_project_collaboration_group(
        test_db, int(target.id), original["id"], test_user.id
    )
    assert shared["owner_type"] == "chat_group"
    assert str(shared["owner_id"]) == source.id
    assert shared["binding_owner_id"] == target.id
    with pytest.raises(HTTPException) as source_edit:
        workspace_service.update_project_collaboration_group(
            test_db,
            int(target.id),
            original["id"],
            test_user.id,
            CollaborationGroupUpdate(version=1, name="Cannot edit source here"),
        )
    assert source_edit.value.status_code == 404
    workspace_service.remove_project_collaboration_group(
        test_db, int(target.id), original["id"], test_user.id
    )
    assert test_db.get(Kind, original["id"]).is_active is True
    assert (
        workspace_service.list_project_collaboration_groups(
            test_db, int(target.id), test_user.id
        )
        == []
    )
    assert (
        workspace_service.list_project_collaboration_groups(
            test_db, int(source.id), test_user.id
        )[0]["id"]
        == original["id"]
    )


def test_definition_creator_cannot_share_after_losing_source_group_authority(
    test_db, test_user
):
    source = make_group(test_db, test_user, [])
    source.project_key = "SOURCE"
    test_db.flush()
    target = make_group(test_db, test_user, [])
    original = workspace_service.create_project_collaboration_group(
        test_db, int(source.id), test_user.id, draft(test_user)
    )
    source_grant = (
        test_db.query(ResourceMember)
        .filter_by(
            resource_type=GROUP_RESOURCE_TYPE,
            resource_id=int(source.id),
            entity_type="user",
            entity_id=str(test_user.id),
        )
        .one()
    )
    source_grant.status = "rejected"
    test_db.flush()
    with pytest.raises(HTTPException) as denied:
        workspace_service.add_project_collaboration_group(
            test_db, int(target.id), original["id"], test_user.id
        )
    assert denied.value.status_code == 404
    assert (
        workspace_service.list_project_collaboration_groups(
            test_db, int(target.id), test_user.id
        )
        == []
    )
