"""Public permission consumers preserve decisions under incomplete Directory facts."""

import pytest
from fastapi import HTTPException

from app.models.kind import Kind
from app.models.namespace import Namespace
from app.models.resource_member import ResourceMember
from app.schemas.share import MemberRole
from app.services.share.team_share_service import TeamShareService
from tests.permission_fixtures import permission_subject  # noqa: F401


@pytest.fixture
def action_resources(test_db, permission_subject):
    viewer, _, directory, _ = permission_subject
    group = Namespace(name="action-consumers", owner_user_id=1, is_active=True)
    test_db.add(group)
    test_db.flush()
    for entity_type, entity_id, role in [
        ("user", str(viewer.id), "Developer"),
        ("directory_group", "D0", "Maintainer"),
    ]:
        test_db.add(
            ResourceMember(
                resource_type="Namespace",
                resource_id=group.id,
                entity_type=entity_type,
                entity_id=entity_id,
                role=role,
                status="approved",
            )
        )
    team = Kind(
        kind="Team",
        name="action-team",
        namespace=group.name,
        user_id=1,
        is_active=True,
        json={"spec": {}},
    )
    skill = Kind(
        kind="Skill",
        name="action-skill",
        namespace=group.name,
        user_id=1,
        is_active=True,
        json={"spec": {}},
    )
    test_db.add_all([team, skill])
    test_db.flush()
    directory.side_effect = RuntimeError("Directory unavailable")
    return viewer, group, team, skill


def test_shared_team_read_uses_required_role(test_db, action_resources):
    viewer, _, team, _ = action_resources
    assert TeamShareService().get_resource(test_db, team.id, viewer.id) == team


@pytest.mark.parametrize("required", [MemberRole.Maintainer, MemberRole.Owner])
def test_shared_team_higher_thresholds(test_db, action_resources, required):
    viewer, _, team, _ = action_resources
    if required == MemberRole.Maintainer:
        with pytest.raises(HTTPException) as failure:
            TeamShareService().check_permission(test_db, team.id, viewer.id, required)
        assert failure.value.status_code == 503
    else:
        assert not TeamShareService().check_permission(
            test_db, team.id, viewer.id, required
        )


def test_skill_access_preserves_sufficient_group_grant(test_db, action_resources):
    from app.services.skill_binding_service import SkillBindingService

    viewer, _, _, skill = action_resources
    assert SkillBindingService().can_user_access_skill(
        test_db, skill=skill, user_id=viewer.id
    )


@pytest.mark.parametrize("action", ["view", "edit"])
def test_prompt_actions_use_required_role(test_db, action_resources, action):
    from app.services.prompt_optimization import can_edit_prompt, can_view_prompt

    viewer, _, team, _ = action_resources
    check = can_view_prompt if action == "view" else can_edit_prompt
    assert check(test_db, viewer, team)


def test_namespace_creation_is_an_action_not_a_precise_role(test_db, action_resources):
    from app.services.knowledge.permission_policy import (
        can_create_namespace_knowledge_base,
    )

    viewer, group, _, _ = action_resources
    assert can_create_namespace_knowledge_base(test_db, viewer, group.name)


def test_precise_role_is_still_unknown(test_db, action_resources):
    from app.services.group_permission import get_effective_role_in_group

    viewer, group, _, _ = action_resources
    with pytest.raises(HTTPException) as failure:
        get_effective_role_in_group(test_db, viewer.id, group.name)
    assert failure.value.status_code == 503


@pytest.mark.parametrize("consumer", ["team", "skill", "prompt_read", "prompt_edit"])
@pytest.mark.parametrize("restricted", [False, True])
def test_consumers_preserve_nearest_group_override(
    test_db, action_resources, consumer, restricted
):
    from app.services.prompt_optimization import can_edit_prompt, can_view_prompt
    from app.services.skill_binding_service import SkillBindingService

    viewer, group, team, skill = action_resources
    parent = Namespace(name="parent-action", owner_user_id=1, is_active=True)
    test_db.add(parent)
    test_db.flush()
    group.name = parent.name + "/child"
    team.namespace = skill.namespace = group.name
    members = (
        test_db.query(ResourceMember)
        .filter_by(resource_type="Namespace", resource_id=group.id)
        .all()
    )
    for member in members:
        if member.entity_type == "user":
            member.resource_id = parent.id
        else:
            member.role = "Reporter"
    if restricted:
        test_db.add(
            ResourceMember(
                resource_type="Namespace",
                resource_id=group.id,
                entity_type="user",
                entity_id=str(viewer.id),
                role="RestrictedAnalyst",
                status="approved",
            )
        )
    test_db.flush()

    def decision():
        if consumer == "team":
            return (
                TeamShareService().get_resource(test_db, team.id, viewer.id) is not None
            )
        if consumer == "skill":
            return SkillBindingService().can_user_access_skill(
                test_db, skill=skill, user_id=viewer.id
            )
        check = can_edit_prompt if consumer == "prompt_edit" else can_view_prompt
        return check(test_db, viewer, team)

    if restricted:
        # The uncertain same-layer Reporter may lift the known restriction.
        if consumer != "prompt_edit":
            with pytest.raises(HTTPException) as failure:
                decision()
            assert failure.value.status_code == 503
        else:
            assert decision() is False
    elif consumer == "prompt_edit":
        with pytest.raises(HTTPException) as failure:
            decision()
        assert failure.value.status_code == 503
    else:
        assert decision() is True
