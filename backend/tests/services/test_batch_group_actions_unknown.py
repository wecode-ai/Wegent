"""Public batch and group actions use only facts needed by their outcomes."""

import pytest
from fastapi import HTTPException

from app.models.kind import Kind
from app.models.resource_member import ResourceMember
from tests.permission_fixtures import permission_subject  # noqa: F401
from tests.services.test_group_action_consumers_unknown import (  # noqa: F401
    action_resources,
)


@pytest.mark.parametrize("distinct_namespaces", [False, True])
@pytest.mark.parametrize("size", [1, 12])
def test_workspace_catalog_projects_editing_once_per_namespace(
    test_db, action_resources, permission_subject, size, distinct_namespaces
):
    from app.services.workspaces.agent_catalog import map_agent_catalog

    viewer, group, _, _ = action_resources
    _, _, directory, _ = permission_subject
    rows = []
    for i in range(size):
        namespace = group.name
        if distinct_namespaces:
            from app.models.namespace import Namespace

            extra = Namespace(name=f"batch-group-{i}", owner_user_id=1, is_active=True)
            test_db.add(extra)
            test_db.flush()
            for kind, eid, role in [
                ("user", str(viewer.id), "Developer"),
                ("directory_group", "D0", "Maintainer"),
            ]:
                test_db.add(
                    ResourceMember(
                        resource_type="Namespace",
                        resource_id=extra.id,
                        entity_type=kind,
                        entity_id=eid,
                        role=role,
                        status="approved",
                    )
                )
            namespace = extra.name
        team = Kind(
            kind="Team",
            name=f"batch-{i}",
            namespace=namespace,
            user_id=1,
            is_active=True,
            json={"spec": {}},
        )
        test_db.add(team)
        test_db.flush()
        grant = ResourceMember(
            resource_type="Team",
            resource_id=team.id,
            entity_type="workspace",
            entity_id="123",
            role="Reporter",
            status="approved",
        )
        test_db.add(grant)
        rows.append((grant, team))
    test_db.flush()
    from tests.permission_fixtures import sql_count

    with sql_count(test_db) as statements:
        result = map_agent_catalog(
            test_db, rows, 123, viewer.id, include_readiness=False
        )
    assert len(statements) <= 20
    assert sum("resource_members" in sql.lower() for sql in statements) <= 6
    assert len(result) == size
    assert all(row["can_edit"] for row in result)
    assert directory.call_count == 1


def test_group_installs_only_need_read_permission(
    test_db, action_resources, permission_subject
):
    from app.services.resource_library_service import resource_library_service

    viewer, group, _, _ = action_resources
    result = resource_library_service.list_group_installs_batch(
        test_db,
        group_namespaces=[group.name, group.name],
        current_user=viewer,
        resource_type=None,
        page=1,
        limit=20,
    )
    assert result.total == 2
    assert permission_subject[2].call_count == 1


def test_group_update_rejects_when_owner_is_impossible(test_db, action_resources):
    from app.schemas.namespace import GroupUpdate
    from app.services.group_service import update_group

    viewer, group, _, _ = action_resources
    with pytest.raises(HTTPException) as failure:
        update_group(
            test_db, group.name, GroupUpdate(description="unchanged"), viewer.id
        )
    assert failure.value.status_code == 403


def test_group_team_list_does_not_need_precise_role(test_db, action_resources):
    from app.services.adapters.team_kinds import team_kinds_service

    viewer, group, team, _ = action_resources
    team.json = {
        "metadata": {"name": team.name, "namespace": group.name},
        "spec": {"members": [], "collaborationModel": "coordinate"},
    }
    test_db.flush()
    rows = team_kinds_service.get_user_teams(
        test_db, user_id=viewer.id, scope="group", group_name=group.name
    )
    assert team.id in {row["id"] for row in rows}


def test_redaction_does_not_require_unrelated_precise_roles(test_db, action_resources):
    from app.services.team_access_policy import should_redact_team_for_user

    viewer, group, team, _ = action_resources
    assert not should_redact_team_for_user(
        test_db,
        user_id=viewer.id,
        team_id=team.id,
        team_user_id=team.user_id,
        team_namespace=group.name,
    )


@pytest.mark.parametrize(
    "known,unknown,expected",
    [
        ("Reporter", "RestrictedAnalyst", False),
        ("Reporter", "Developer", None),
    ],
)
def test_workspace_catalog_keeps_false_and_unknown_editability(
    test_db, action_resources, known, unknown, expected
):
    from app.services.workspaces.agent_catalog import map_agent_catalog

    viewer, group, team, _ = action_resources
    for member in (
        test_db.query(ResourceMember)
        .filter_by(resource_type="Namespace", resource_id=group.id)
        .all()
    ):
        member.role = known if member.entity_type == "user" else unknown
    grant = ResourceMember(
        resource_type="Team",
        resource_id=team.id,
        entity_type="workspace",
        entity_id="123",
        role="Reporter",
        status="approved",
    )
    test_db.add(grant)
    test_db.flush()
    if expected is None:
        with pytest.raises(HTTPException) as failure:
            map_agent_catalog(
                test_db, [(grant, team)], 123, viewer.id, include_readiness=False
            )
        assert failure.value.status_code == 503
    else:
        result = map_agent_catalog(
            test_db, [(grant, team)], 123, viewer.id, include_readiness=False
        )
        assert result[0]["can_edit"] is expected


def test_self_removal_does_not_require_a_precise_role(test_db, action_resources):
    from app.services.group_service import remove_member

    viewer, group, _, _ = action_resources
    remove_member(test_db, group.name, viewer.id, viewer.id)


def test_subgroup_creation_uses_maintainer_threshold(test_db, action_resources):
    from app.schemas.namespace import GroupCreate
    from app.services.group_service import create_group

    viewer, group, _, _ = action_resources
    for member in (
        test_db.query(ResourceMember)
        .filter_by(resource_type="Namespace", resource_id=group.id)
        .all()
    ):
        member.role = "Maintainer" if member.entity_type == "user" else "Owner"
    test_db.flush()
    result = create_group(test_db, GroupCreate(name=group.name + "/child"), viewer.id)
    assert result.name == group.name + "/child"


def test_redaction_combines_correlated_namespaces(test_db, action_resources):
    from app.models.namespace import Namespace
    from app.services.team_access_policy import should_redact_team_for_user

    viewer, group, team, _ = action_resources
    for member in (
        test_db.query(ResourceMember)
        .filter_by(resource_type="Namespace", resource_id=group.id)
        .all()
    ):
        member.role = (
            "RestrictedAnalyst" if member.entity_type == "user" else "Reporter"
        )
    other = Namespace(name="shared-restriction", owner_user_id=1, is_active=True)
    test_db.add(other)
    test_db.flush()
    test_db.add_all(
        [
            ResourceMember(
                resource_type="Namespace",
                resource_id=other.id,
                entity_type="directory_group",
                entity_id="D0",
                role="RestrictedAnalyst",
                status="approved",
            ),
            ResourceMember(
                resource_type="Team",
                resource_id=team.id,
                entity_type="namespace",
                entity_id=str(other.id),
                role="Reporter",
                status="approved",
            ),
        ]
    )
    test_db.flush()
    assert should_redact_team_for_user(
        test_db,
        user_id=viewer.id,
        team_id=team.id,
        team_user_id=team.user_id,
        team_namespace=group.name,
    )
