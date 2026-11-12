"""Valid original resource references migrate only with their original Project."""

import pytest
from fastapi import HTTPException

from app.models.delivery import ProjectChatAgent
from app.models.resource_member import ResourceMember
from app.services.thread_migration_inventory import inspect_thread_migration
from app.services.thread_project_links import linked_project_id
from app.services.workspaces import workspace_service
from tests.services.test_chat_group_crews import draft
from tests.services.test_thread_migration import _apply
from tests.services.test_thread_migration_assets import migration as migration_fixture
from tests.utils.collaboration import authorize_project_agent

migration = migration_fixture


def prepare_assignment(test_db, test_user, migration, kind):
    arguments, storage, item, group = migration
    source = item.cloud_project_id
    if kind == "agent":
        agent = ProjectChatAgent(
            cloud_project_id=source,
            name="Original private definition",
            created_by_user_id=test_user.id,
            metadata_json={"runtime": "codex", "visibility": "private"},
        )
        authorize_project_agent(test_db, agent)
        item.assignee_agent_id = agent.id
        resource_id = agent.id
    else:
        crew = workspace_service.create_project_collaboration_group(
            test_db, int(source), test_user.id, draft(test_user)
        )
        item.metadata_json = {
            **(item.metadata_json or {}),
            "collaboration_group": {"id": str(crew["id"]), "name": crew["name"]},
            "collaboration_group_assignment_key": "original-generation",
        }
        resource_id = str(crew["id"])
    test_db.commit()
    report = inspect_thread_migration(
        test_db,
        source_project_id=int(source),
        target_group_id=int(group.id),
        actor_user_id=test_user.id,
    )
    assert report.entries[0].blockers == ()
    return {**arguments, "inventory": report}, storage, item, group, resource_id


@pytest.mark.parametrize("kind", ["agent", "crew"])
def test_migration_retains_original_authorized_resource_without_copy_or_new_grants(
    test_db, test_user, migration, kind
):
    arguments, storage, item, group, resource_id = prepare_assignment(
        test_db, test_user, migration, kind
    )
    source = item.cloud_project_id
    grants = test_db.query(ResourceMember).count()
    _apply(arguments, storage)
    test_db.expire_all()
    assert item.cloud_project_id == group.id
    assert linked_project_id(test_db, item.id) == source
    assert test_db.query(ResourceMember).count() == grants
    if kind == "agent":
        assert item.assignee_agent_id == resource_id
        original = test_db.get(ProjectChatAgent, resource_id)
        assert original.cloud_project_id == source
        assert original.metadata_json["visibility"] == "private"
    else:
        assert item.metadata_json["collaboration_group"]["id"] == resource_id
        assert item.metadata_json["collaboration_group"]["binding_owner_id"] == source
        assert (
            item.metadata_json["collaboration_group_assignment_key"]
            == "original-generation"
        )


@pytest.mark.parametrize("kind", ["agent", "crew"])
def test_resource_assignment_cannot_migrate_without_original_project(
    test_db, test_user, migration, kind
):
    arguments, storage, item, group, _ = prepare_assignment(
        test_db, test_user, migration, kind
    )
    source = item.cloud_project_id
    with pytest.raises(HTTPException) as denied:
        _apply(arguments, storage, retain_source_project=False)
    assert denied.value.status_code == 409
    test_db.expire_all()
    assert item.cloud_project_id == source
    assert linked_project_id(test_db, item.id) is None


def test_inventory_keeps_revoked_original_binding_blocked(
    test_db, test_user, migration
):
    arguments, _, item, group, agent_id = prepare_assignment(
        test_db, test_user, migration, "agent"
    )
    test_db.query(ResourceMember).filter_by(
        resource_type="Workspace",
        entity_type="project_agent",
        entity_id=agent_id,
    ).one().status = "rejected"
    test_db.commit()
    report = inspect_thread_migration(
        test_db,
        source_project_id=int(item.cloud_project_id),
        target_group_id=int(group.id),
        actor_user_id=test_user.id,
    )
    assert report.entries[0].blockers == ("execution_resource_mapping_required",)
    assert item.assignee_agent_id == agent_id
    assert item.cloud_project_id == arguments["inventory"].source_project_id
