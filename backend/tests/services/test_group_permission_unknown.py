"""Group actions depend on missing facts only when their verdict can change."""

import pytest

from app.models.namespace import Namespace
from app.models.resource_member import ResourceMember
from app.schemas.namespace import GroupRole
from app.services.group_permission import check_group_permission
from tests.permission_fixtures import permission_subject  # noqa: F401


def add_member(db, group, entity_type, entity_id, role):
    db.add(
        ResourceMember(
            resource_type="Namespace",
            resource_id=group.id,
            entity_type=entity_type,
            entity_id=entity_id,
            role=role,
            status="approved",
        )
    )
    db.flush()


def test_direct_owner_survives_unknown_department_reporter(test_db, permission_subject):
    viewer, _, directory, _ = permission_subject
    group = Namespace(name="group-permission", owner_user_id=viewer.id, is_active=True)
    test_db.add(group)
    test_db.flush()
    add_member(test_db, group, "user", str(viewer.id), "Owner")
    add_member(test_db, group, "directory_group", "D0", "Reporter")
    directory.side_effect = RuntimeError("Directory unavailable")

    assert check_group_permission(test_db, viewer.id, group.name, GroupRole.Developer)


@pytest.mark.parametrize(
    "known,unknown,required,empty,matched,failed",
    [
        ([(1, "Developer")], [(1, "D0", "Maintainer")], "Developer", True, True, True),
        (
            [(1, "Reporter")],
            [(1, "D0", "Developer")],
            "Maintainer",
            False,
            False,
            False,
        ),
        ([(1, "Reporter")], [(1, "D0", "Developer")], "Developer", False, True, None),
        (
            [(1, "RestrictedAnalyst")],
            [(1, "D0", "Reporter")],
            "Developer",
            False,
            False,
            False,
        ),
        (
            [(1, "RestrictedAnalyst")],
            [(1, "D0", "Developer")],
            "Reporter",
            False,
            True,
            None,
        ),
        ([], [(1, "D0", "Reporter")], "Developer", False, False, False),
        ([], [(1, "D0", "Reporter")], "Reporter", False, True, None),
        ([(1, "Owner")], [(2, "D0", "Reporter")], "Developer", True, False, None),
        ([(1, "Reporter")], [(2, "D0", "Maintainer")], "Developer", False, True, None),
        ([(1, "Developer")], [(2, "D0", "Maintainer")], "Developer", True, True, True),
        (
            [(2, "RestrictedAnalyst")],
            [(1, "D0", "Owner")],
            "Reporter",
            False,
            False,
            False,
        ),
        ([(2, "Reporter")], [(1, "D0", "Owner")], "Developer", False, False, False),
        (
            [],
            [(1, "D0", "Developer"), (2, "D0", "Reporter")],
            "Developer",
            False,
            False,
            False,
        ),
        (
            [],
            [(1, "D0", "Owner"), (2, "D0", "RestrictedAnalyst")],
            "Reporter",
            False,
            False,
            False,
        ),
        (
            [],
            [(1, "D0", "RestrictedAnalyst"), (2, "D0", "Developer")],
            "Developer",
            False,
            True,
            None,
        ),
    ],
)
@pytest.mark.parametrize("source", ["empty", "matched", "failed"])
def test_group_permission_projects_the_required_action(
    test_db,
    permission_subject,
    known,
    unknown,
    required,
    empty,
    matched,
    failed,
    source,
):
    from fastapi import HTTPException

    viewer, _, directory, _ = permission_subject
    groups = {
        depth: Namespace(
            name="/".join(["parent", "child"][:depth]),
            owner_user_id=viewer.id,
            is_active=True,
        )
        for depth in (1, 2)
    }
    test_db.add_all(groups.values())
    test_db.flush()
    for depth, role in known:
        add_member(test_db, groups[depth], "user", str(viewer.id), role)
    for depth, department, role in unknown:
        add_member(test_db, groups[depth], "directory_group", department, role)
    expected = {"empty": empty, "matched": matched, "failed": failed}[source]
    directory.return_value = frozenset({"D0"} if source == "matched" else ())
    if source == "failed":
        directory.side_effect = RuntimeError("Directory unavailable")
    if expected is None:
        with pytest.raises(HTTPException) as failure:
            check_group_permission(
                test_db, viewer.id, groups[2].name, GroupRole(required)
            )
        assert failure.value.status_code == 503
        assert failure.value.headers["Retry-After"] == "1"
    else:
        assert (
            check_group_permission(
                test_db, viewer.id, groups[2].name, GroupRole(required)
            )
            is expected
        )


def test_precise_role_stays_unknown_when_action_is_already_allowed(
    test_db, permission_subject
):
    from fastapi import HTTPException

    from app.services.group_permission import get_effective_role_in_group

    viewer, _, directory, _ = permission_subject
    group = Namespace(name="role-projection", owner_user_id=viewer.id, is_active=True)
    test_db.add(group)
    test_db.flush()
    add_member(test_db, group, "user", str(viewer.id), "Developer")
    add_member(test_db, group, "directory_group", "D0", "Maintainer")
    directory.side_effect = RuntimeError("Directory unavailable")
    assert check_group_permission(test_db, viewer.id, group.name, GroupRole.Developer)
    with pytest.raises(HTTPException) as failure:
        get_effective_role_in_group(test_db, viewer.id, group.name)
    assert failure.value.status_code == 503


def test_group_action_does_not_resolve_unrelated_namespace_bindings(
    test_db, permission_subject
):
    viewer, _, directory, _ = permission_subject
    target = Namespace(name="target", owner_user_id=viewer.id, is_active=True)
    unrelated = Namespace(name="unrelated", owner_user_id=viewer.id, is_active=True)
    test_db.add_all([target, unrelated])
    test_db.flush()
    add_member(test_db, target, "user", str(viewer.id), "Developer")
    add_member(test_db, unrelated, "directory_group", "D0", "Owner")
    directory.side_effect = RuntimeError("Directory unavailable")

    assert check_group_permission(test_db, viewer.id, target.name, GroupRole.Developer)
    directory.assert_not_called()


def test_group_owner_can_create_team_when_directory_is_unavailable(
    test_db, permission_subject
):
    from app.models.kind import Kind
    from app.schemas.team import TeamCreate
    from app.services.adapters.team_kinds import team_kinds_service
    from tests.services.adapters.test_team_child_namespace_authorization import (
        _create_parent_agent_graph,
    )

    viewer, _, directory, _ = permission_subject
    _create_parent_agent_graph(test_db, viewer, "default")
    bot = (
        test_db.query(Kind).filter(Kind.kind == "Bot", Kind.user_id == viewer.id).one()
    )
    group = Namespace(name="creation-target", owner_user_id=viewer.id, is_active=True)
    test_db.add(group)
    test_db.flush()
    add_member(test_db, group, "user", str(viewer.id), "Owner")
    add_member(test_db, group, "directory_group", "D0", "Reporter")
    directory.side_effect = RuntimeError("Directory unavailable")

    created = team_kinds_service.create_with_user(
        test_db,
        obj_in=TeamCreate(name="created-during-outage", bots=[{"bot_id": bot.id}]),
        user_id=viewer.id,
        group_name=group.name,
    )

    assert created["namespace"] == group.name
    assert created["name"] == "created-during-outage"


def test_group_membership_list_does_not_require_a_precise_role(
    test_db, permission_subject
):
    from fastapi import HTTPException

    from app.services.group_permission import get_user_group_roles, get_user_groups

    viewer, _, directory, _ = permission_subject
    group = Namespace(name="certain-member", owner_user_id=viewer.id, is_active=True)
    test_db.add(group)
    test_db.flush()
    add_member(test_db, group, "user", str(viewer.id), "Developer")
    add_member(test_db, group, "directory_group", "D0", "Maintainer")
    directory.side_effect = RuntimeError("Directory unavailable")

    assert get_user_groups(test_db, viewer.id) == [group.name]
    with pytest.raises(HTTPException) as failure:
        get_user_group_roles(test_db, viewer.id)
    assert failure.value.status_code == 503


def test_unknown_membership_list_is_not_returned_as_empty(test_db, permission_subject):
    from fastapi import HTTPException

    from app.services.group_permission import get_user_groups

    viewer, _, directory, _ = permission_subject
    group = Namespace(name="uncertain-member", owner_user_id=viewer.id, is_active=True)
    test_db.add(group)
    test_db.flush()
    add_member(test_db, group, "directory_group", "D0", "Reporter")
    directory.side_effect = RuntimeError("Directory unavailable")
    with pytest.raises(HTTPException) as failure:
        get_user_groups(test_db, viewer.id)
    assert failure.value.status_code == 503
    assert failure.value.headers["Retry-After"] == "1"
