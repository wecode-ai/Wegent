# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import patch

import pytest
from fastapi import HTTPException

from app.models.kind import Kind
from app.models.namespace import Namespace
from app.models.resource_member import MemberStatus, ResourceMember
from app.schemas.base_role import BaseRole
from app.schemas.bot import BotUpdate
from app.schemas.team import BotInfo, TeamCreate, TeamUpdate
from app.services.adapters.bot_edit_access import can_reference_bot
from app.services.adapters.bot_kinds import bot_kinds_service
from app.services.adapters.team_kinds import team_kinds_service


def _create_bot(
    db, *, user_id: int, namespace: str = "default", name: str = "secured-bot"
) -> Kind:
    bot = Kind(
        user_id=user_id,
        kind="Bot",
        name=name,
        namespace=namespace,
        is_active=True,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Bot",
            "metadata": {"name": name, "namespace": namespace},
            "spec": {
                "ghostRef": {"name": f"{name}-ghost", "namespace": namespace},
                "shellRef": {"name": "ClaudeCode", "namespace": "default"},
            },
            "status": {"state": "Available"},
        },
    )
    db.add(bot)
    db.commit()
    db.refresh(bot)
    return bot


def _create_team(
    db,
    *,
    user_id: int,
    namespace: str,
    bot: Kind,
    name: str = "team-with-private-bot",
) -> Kind:
    team = Kind(
        user_id=user_id,
        kind="Team",
        name=name,
        namespace=namespace,
        is_active=True,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Team",
            "metadata": {"name": name, "namespace": namespace},
            "spec": {
                "members": [
                    {
                        "botRef": {"name": bot.name, "namespace": bot.namespace},
                        "prompt": "",
                        "role": "leader",
                    }
                ],
                "collaborationModel": "solo",
            },
            "status": {"state": "Available"},
        },
    )
    db.add(team)
    db.commit()
    db.refresh(team)
    return team


def _add_group_member(db, *, namespace: Namespace, user_id: int, role: BaseRole):
    member = ResourceMember(
        resource_type="Namespace",
        resource_id=namespace.id,
        entity_type="user",
        entity_id=str(user_id),
        user_id=user_id,
        role=role.value,
        status=MemberStatus.APPROVED.value,
        invited_by_user_id=namespace.owner_user_id,
        reviewed_by_user_id=namespace.owner_user_id,
    )
    db.add(member)
    db.commit()
    return member


def test_personal_bot_rejects_non_owner_access(
    test_db,
    test_user,
    test_admin_user,
):
    bot = _create_bot(test_db, user_id=test_admin_user.id)

    protected_calls = (
        lambda: bot_kinds_service.get_bot_detail(
            test_db,
            bot_id=bot.id,
            user_id=test_user.id,
        ),
        lambda: bot_kinds_service.update_with_user(
            test_db,
            bot_id=bot.id,
            obj_in=BotUpdate(name="hijacked"),
            user_id=test_user.id,
        ),
        lambda: bot_kinds_service.check_running_tasks(
            test_db,
            bot_id=bot.id,
            user_id=test_user.id,
        ),
        lambda: bot_kinds_service.delete_with_user(
            test_db,
            bot_id=bot.id,
            user_id=test_user.id,
            force=True,
        ),
    )

    for call in protected_calls:
        with pytest.raises(HTTPException) as exc_info:
            call()
        assert exc_info.value.status_code == 403

    test_db.refresh(bot)
    assert bot.name == "secured-bot"
    assert bot.is_active is True


def test_group_reporter_cannot_access_bot_configuration(
    test_db,
    test_user,
    test_admin_user,
):
    namespace = Namespace(
        name="bot-security",
        display_name="Bot Security",
        owner_user_id=test_admin_user.id,
        visibility="private",
        level="group",
        is_active=True,
    )
    test_db.add(namespace)
    test_db.commit()
    test_db.refresh(namespace)
    _add_group_member(
        test_db,
        namespace=namespace,
        user_id=test_user.id,
        role=BaseRole.Reporter,
    )
    bot = _create_bot(
        test_db,
        user_id=test_admin_user.id,
        namespace=namespace.name,
    )

    with pytest.raises(HTTPException) as exc_info:
        bot_kinds_service.get_bot_detail(
            test_db,
            bot_id=bot.id,
            user_id=test_user.id,
        )
    assert exc_info.value.status_code == 403

    with pytest.raises(HTTPException) as exc_info:
        bot_kinds_service.update_with_user(
            test_db,
            bot_id=bot.id,
            obj_in=BotUpdate(name="hijacked"),
            user_id=test_user.id,
        )
    assert exc_info.value.status_code == 403

    with pytest.raises(HTTPException) as exc_info:
        bot_kinds_service.delete_with_user(
            test_db,
            bot_id=bot.id,
            user_id=test_user.id,
            force=True,
        )
    assert exc_info.value.status_code == 403


def test_group_developer_can_read_and_update_bot(
    test_db,
    test_user,
    test_admin_user,
):
    namespace = Namespace(
        name="bot-developers",
        display_name="Bot Developers",
        owner_user_id=test_admin_user.id,
        visibility="private",
        level="group",
        is_active=True,
    )
    test_db.add(namespace)
    test_db.commit()
    test_db.refresh(namespace)
    _add_group_member(
        test_db,
        namespace=namespace,
        user_id=test_user.id,
        role=BaseRole.Developer,
    )
    bot = _create_bot(
        test_db,
        user_id=test_admin_user.id,
        namespace=namespace.name,
    )

    with patch.object(
        bot_kinds_service,
        "_get_bot_components",
        return_value=(None, None, None),
    ):
        with patch.object(
            bot_kinds_service,
            "_convert_to_bot_dict",
            return_value={"id": bot.id},
        ):
            result = bot_kinds_service.get_bot_detail(
                test_db,
                bot_id=bot.id,
                user_id=test_user.id,
            )
            updated = bot_kinds_service.update_with_user(
                test_db,
                bot_id=bot.id,
                obj_in=BotUpdate(),
                user_id=test_user.id,
            )

    assert result["id"] == bot.id
    assert updated["id"] == bot.id


def test_routing_patch_preserves_bot_identity_without_shell_or_name_update(
    test_db,
    test_user,
):
    bot = _create_bot(test_db, user_id=test_user.id)

    bot_kinds_service.update_with_user(
        test_db,
        bot_id=bot.id,
        obj_in=BotUpdate(
            agent_config={"bind_model": ""},
            execution_policy={"mode": "project_pool"},
            model_policy={"mode": "user_select"},
        ),
        user_id=test_user.id,
    )

    test_db.refresh(bot)
    assert bot.name == "secured-bot"
    assert bot.json["spec"]["shellRef"]["name"] == "ClaudeCode"
    assert bot.json["spec"]["execution_policy"]["mode"] == "project_pool"
    assert bot.json["spec"]["model_policy"]["mode"] == "user_select"


def test_group_update_loads_components_in_resource_owner_scope(
    test_db,
    test_user,
    test_admin_user,
):
    namespace = Namespace(
        name="shared-bot-components",
        display_name="Shared Bot Components",
        owner_user_id=test_admin_user.id,
        visibility="private",
        level="group",
        is_active=True,
    )
    test_db.add(namespace)
    test_db.commit()
    _add_group_member(
        test_db, namespace=namespace, user_id=test_user.id, role=BaseRole.Developer
    )
    bot = _create_bot(test_db, user_id=test_admin_user.id, namespace=namespace.name)

    with (
        patch.object(
            bot_kinds_service, "_get_bot_components", return_value=(None, None, None)
        ) as components,
        patch.object(bot_kinds_service, "_convert_to_bot_dict", return_value={}),
    ):
        bot_kinds_service.update_with_user(
            test_db, bot_id=bot.id, obj_in=BotUpdate(), user_id=test_user.id
        )

    components.assert_called_once_with(
        test_db, bot, test_admin_user.id, viewer_id=test_user.id
    )


def test_group_editor_can_update_private_bot_referenced_by_team(
    test_db,
    test_user,
    test_admin_user,
):
    namespace = Namespace(
        name="team-editors",
        display_name="Team Editors",
        owner_user_id=test_admin_user.id,
        visibility="private",
        level="group",
        is_active=True,
    )
    test_db.add(namespace)
    test_db.commit()
    _add_group_member(
        test_db, namespace=namespace, user_id=test_user.id, role=BaseRole.Developer
    )
    bot = _create_bot(test_db, user_id=test_admin_user.id)
    team = _create_team(
        test_db, user_id=test_admin_user.id, namespace=namespace.name, bot=bot
    )

    with (
        patch.object(
            bot_kinds_service, "_get_bot_components", return_value=(None, None, None)
        ),
        patch.object(bot_kinds_service, "_convert_to_bot_dict", return_value={}),
    ):
        updated = bot_kinds_service.update_with_user(
            test_db,
            bot_id=bot.id,
            obj_in=BotUpdate(
                system_prompt="Updated by a group editor", team_id=team.id
            ),
            user_id=test_user.id,
        )

    assert updated == {}


def test_team_context_cannot_authorize_unrelated_private_bot(
    test_db,
    test_user,
    test_admin_user,
):
    namespace = Namespace(
        name="unrelated-team-editors",
        display_name="Unrelated Team Editors",
        owner_user_id=test_admin_user.id,
        visibility="private",
        level="group",
        is_active=True,
    )
    test_db.add(namespace)
    test_db.commit()
    _add_group_member(
        test_db, namespace=namespace, user_id=test_user.id, role=BaseRole.Developer
    )
    team_bot = _create_bot(test_db, user_id=test_admin_user.id, name="team-bot")
    team = _create_team(
        test_db, user_id=test_admin_user.id, namespace=namespace.name, bot=team_bot
    )
    unrelated_bot = _create_bot(
        test_db, user_id=test_admin_user.id, name="unrelated-bot"
    )

    with pytest.raises(HTTPException) as exc_info:
        bot_kinds_service.update_with_user(
            test_db,
            bot_id=unrelated_bot.id,
            obj_in=BotUpdate(team_id=team.id),
            user_id=test_user.id,
        )

    assert exc_info.value.status_code == 403


def test_team_editor_rename_conflicts_use_bot_owner_scope(
    test_db,
    test_user,
    test_admin_user,
):
    namespace = Namespace(
        name="team-rename-editors",
        display_name="Team Rename Editors",
        owner_user_id=test_admin_user.id,
        visibility="private",
        level="group",
        is_active=True,
    )
    test_db.add(namespace)
    test_db.commit()
    _add_group_member(
        test_db, namespace=namespace, user_id=test_user.id, role=BaseRole.Developer
    )
    bot = _create_bot(test_db, user_id=test_admin_user.id, name="rename-bot")
    conflicting_bot = _create_bot(
        test_db, user_id=test_admin_user.id, name="owner-existing-name"
    )
    team = _create_team(
        test_db, user_id=test_admin_user.id, namespace=namespace.name, bot=bot
    )
    assert conflicting_bot.name != bot.name

    with pytest.raises(HTTPException) as exc_info:
        bot_kinds_service.update_with_user(
            test_db,
            bot_id=bot.id,
            obj_in=BotUpdate(
                name=conflicting_bot.name,
                team_id=team.id,
            ),
            user_id=test_user.id,
        )

    assert exc_info.value.status_code == 400


def test_team_reporter_cannot_update_private_bot_through_team(
    test_db,
    test_user,
    test_admin_user,
):
    namespace = Namespace(
        name="team-reporters",
        display_name="Team Reporters",
        owner_user_id=test_admin_user.id,
        visibility="private",
        level="group",
        is_active=True,
    )
    test_db.add(namespace)
    test_db.commit()
    _add_group_member(
        test_db, namespace=namespace, user_id=test_user.id, role=BaseRole.Reporter
    )
    bot = _create_bot(test_db, user_id=test_admin_user.id)
    team = _create_team(
        test_db, user_id=test_admin_user.id, namespace=namespace.name, bot=bot
    )

    with pytest.raises(HTTPException) as exc_info:
        bot_kinds_service.update_with_user(
            test_db,
            bot_id=bot.id,
            obj_in=BotUpdate(team_id=team.id),
            user_id=test_user.id,
        )

    assert exc_info.value.status_code == 403


@pytest.fixture
def group_agent(test_db, test_user, test_admin_user):
    namespace = Namespace(
        name="private-component-editors",
        display_name="Private Component Editors",
        owner_user_id=test_admin_user.id,
        visibility="private",
        level="group",
        is_active=True,
    )
    test_db.add(namespace)
    test_db.commit()
    _add_group_member(
        test_db, namespace=namespace, user_id=test_user.id, role=BaseRole.Owner
    )
    bot = _create_bot(test_db, user_id=test_admin_user.id)
    team = _create_team(
        test_db, user_id=test_admin_user.id, namespace=namespace.name, bot=bot
    )
    skill = Kind(
        kind="Skill",
        name="owner-private-skill",
        namespace="default",
        user_id=test_admin_user.id,
        is_active=True,
        json={"spec": {}, "status": {}},
    )
    test_db.add(skill)
    test_db.flush()
    ref = {"skill_id": skill.id, "namespace": "default", "is_public": False}
    ghost = Kind(
        kind="Ghost",
        name=f"{bot.name}-ghost",
        namespace="default",
        user_id=bot.user_id,
        is_active=True,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Ghost",
            "metadata": {"name": f"{bot.name}-ghost", "namespace": "default"},
            "spec": {
                "systemPrompt": "Original prompt",
                "skills": [skill.name],
                "skill_refs": {skill.name: ref},
                "preload_skills": [skill.name],
                "preload_skill_refs": {skill.name: ref},
                "defaultKnowledgeBaseRefs": [{"id": 101, "name": "Owner KB"}],
            },
            "status": {"state": "Available"},
        },
    )
    test_db.add(ghost)
    test_db.add(
        Kind(
            kind="Shell",
            name="ClaudeCode",
            namespace="default",
            user_id=bot.user_id,
            is_active=True,
            json={
                "apiVersion": "agent.wecode.io/v1",
                "kind": "Shell",
                "metadata": {"name": "ClaudeCode", "namespace": "default"},
                "spec": {"shellType": "ClaudeCode"},
                "status": {"state": "Available"},
            },
        )
    )
    test_db.commit()
    return namespace, team, bot, ghost, skill


@pytest.mark.parametrize("legacy_refs", [False, True])
def test_group_owner_save_preserves_private_components(
    test_db, test_user, group_agent, legacy_refs
):
    namespace, team, bot, ghost, skill = group_agent
    if legacy_refs:
        ghost.json = {
            **ghost.json,
            "spec": {
                **ghost.json["spec"],
                "skill_refs": None,
                "preload_skill_refs": None,
            },
        }
        test_db.commit()
    ref = {"skill_id": skill.id, "namespace": "default", "is_public": False}
    with patch(
        "app.services.adapters.bot_kinds.KnowledgeService.can_directly_access_knowledge_base",
        return_value=False,
    ):
        result = bot_kinds_service.update_with_user(
            test_db,
            bot_id=bot.id,
            user_id=test_user.id,
            obj_in=BotUpdate(
                team_id=team.id,
                system_prompt="Group owner changed prompt",
                skills=[skill.name],
                skill_refs=None if legacy_refs else {skill.name: ref},
                preload_skills=[skill.name],
                preload_skill_refs=None if legacy_refs else {skill.name: ref},
                default_knowledge_base_refs=[{"id": 101, "name": "Owner KB"}],
                target_group_names=[namespace.name],
            ),
        )
    test_db.expire_all()
    assert (
        test_db.get(Kind, ghost.id).json["spec"]["systemPrompt"]
        == result["system_prompt"]
        == "Group owner changed prompt"
    )
    assert result["skill_refs"][skill.name]["skill_id"] == skill.id
    assert result["preload_skill_refs"][skill.name]["skill_id"] == skill.id
    assert result["default_knowledge_base_refs"] == [{"id": 101, "name": "Owner KB"}]
    assert test_db.get(Kind, bot.id).user_id == team.user_id


@pytest.mark.parametrize("field", ["skills", "preload_skills"])
def test_group_editor_cannot_attach_unrelated_owner_skill(
    test_db, test_user, group_agent, field
):
    _, team, bot, _, skill = group_agent
    unrelated = Kind(
        kind="Skill",
        name="unrelated-private-skill",
        namespace="default",
        user_id=bot.user_id,
        is_active=True,
        json={"spec": {}, "status": {}},
    )
    test_db.add(unrelated)
    test_db.commit()
    ref_field = "skill_refs" if field == "skills" else "preload_skill_refs"
    with pytest.raises(HTTPException) as exc_info:
        bot_kinds_service.update_with_user(
            test_db,
            bot_id=bot.id,
            user_id=test_user.id,
            obj_in=BotUpdate(
                team_id=team.id,
                **{
                    field: [unrelated.name],
                    ref_field: {
                        unrelated.name: {
                            "skill_id": unrelated.id,
                            "namespace": "default",
                            "is_public": False,
                        }
                    },
                },
            ),
        )
    assert exc_info.value.status_code == 403


def test_group_editor_cannot_replace_retained_skill_with_same_name(
    test_db, test_user, group_agent
):
    _, team, bot, _, skill = group_agent
    replacement = Kind(
        kind="Skill",
        name=skill.name,
        namespace="other-private-group",
        user_id=bot.user_id,
        is_active=True,
        json={"spec": {}, "status": {}},
    )
    test_db.add(replacement)
    test_db.commit()
    with pytest.raises(HTTPException) as exc_info:
        bot_kinds_service.update_with_user(
            test_db,
            bot_id=bot.id,
            user_id=test_user.id,
            obj_in=BotUpdate(
                team_id=team.id,
                skills=[skill.name],
                skill_refs={
                    skill.name: {
                        "skill_id": replacement.id,
                        "namespace": replacement.namespace,
                    }
                },
            ),
        )
    assert exc_info.value.status_code == 403


def test_group_editor_must_authorize_new_knowledge_base(
    test_db, test_user, group_agent
):
    _, team, bot, _, _ = group_agent
    with patch(
        "app.services.adapters.bot_kinds.KnowledgeService.can_directly_access_knowledge_base",
        return_value=False,
    ) as access:
        with pytest.raises(HTTPException) as exc_info:
            bot_kinds_service.update_with_user(
                test_db,
                bot_id=bot.id,
                user_id=test_user.id,
                obj_in=BotUpdate(
                    team_id=team.id,
                    default_knowledge_base_refs=[
                        {"id": 101, "name": "Owner KB"},
                        {"id": 102, "name": "Unrelated KB"},
                    ],
                ),
            )
    assert exc_info.value.status_code == 400
    assert (
        exc_info.value.detail == "Default knowledge bases are not directly accessible"
    )
    access.assert_called_once_with(test_db, 102, test_user.id)


def test_group_editor_custom_model_is_stored_in_bot_owner_scope(
    test_db, test_user, group_agent
):
    _, team, bot, _, _ = group_agent
    result = bot_kinds_service.update_with_user(
        test_db,
        bot_id=bot.id,
        user_id=test_user.id,
        obj_in=BotUpdate(team_id=team.id, agent_config={"model_id": "test-model"}),
    )
    model = (
        test_db.query(Kind)
        .filter(
            Kind.kind == "Model",
            Kind.name == f"{bot.name}-model",
            Kind.namespace == "default",
            Kind.user_id == bot.user_id,
        )
        .one()
    )
    assert result["agent_config"]["model_id"] == "test-model"
    assert model.user_id != test_user.id
    assert (
        bot_kinds_service._get_bot_components(
            test_db, bot, bot.user_id, viewer_id=test_user.id
        )[2].id
        == model.id
    )


@pytest.mark.parametrize("operation", ["bot_update", "team_update", "team_create"])
def test_team_context_never_grants_cross_group_bot_authority(
    test_db, test_user, group_agent, operation
):
    _, team, bot, _, _ = group_agent
    victim = _create_bot(
        test_db, user_id=bot.user_id, namespace="inaccessible-group", name="victim"
    )
    team.json = {
        **team.json,
        "spec": {
            **team.json["spec"],
            "members": [
                {
                    "botRef": {"name": victim.name, "namespace": victim.namespace},
                    "role": "leader",
                    "prompt": "",
                }
            ],
        },
    }
    test_db.commit()
    with pytest.raises(HTTPException) as exc_info:
        if operation == "bot_update":
            bot_kinds_service.update_with_user(
                test_db,
                bot_id=victim.id,
                user_id=test_user.id,
                obj_in=BotUpdate(team_id=team.id, system_prompt="Not allowed"),
            )
        elif operation == "team_update":
            team_kinds_service.update_with_user(
                test_db,
                team_id=team.id,
                user_id=test_user.id,
                obj_in=TeamUpdate(bots=[BotInfo(bot_id=victim.id)]),
            )
        else:
            team_kinds_service.create_with_user(
                test_db,
                user_id=test_user.id,
                obj_in=TeamCreate(
                    name="cannot-smuggle-bot",
                    bots=[BotInfo(bot_id=victim.id)],
                ),
            )
    assert exc_info.value.status_code == 403


def test_team_update_can_retain_existing_private_bot(test_db, test_user, group_agent):
    _, team, bot, _, _ = group_agent
    result = team_kinds_service.update_with_user(
        test_db,
        team_id=team.id,
        user_id=test_user.id,
        obj_in=TeamUpdate(bots=[BotInfo(bot_id=bot.id, role="leader")]),
    )
    assert result["bots"][0]["bot_id"] == bot.id


@pytest.mark.parametrize("changed", [False, True])
def test_group_editor_preserves_policy_but_must_authorize_changes(
    test_db, test_user, group_agent, changed
):
    _, team, bot, _, _ = group_agent
    original_policy = {"mode": "fixed", "environment_id": "101"}
    model_policy = {"mode": "user_select"}
    bot.json = {
        **bot.json,
        "spec": {
            **bot.json["spec"],
            "execution_policy": original_policy,
            "model_policy": model_policy,
        },
    }
    test_db.commit()
    requested_policy = (
        {"mode": "fixed", "environment_id": "102"} if changed else original_policy
    )
    with patch(
        "app.services.runner_routing.validate_agent_policies",
        side_effect=HTTPException(403, "Environment access denied"),
    ) as validate:

        def update():
            return bot_kinds_service.update_with_user(
                test_db,
                bot_id=bot.id,
                user_id=test_user.id,
                obj_in=BotUpdate(
                    team_id=team.id,
                    execution_policy=requested_policy,
                    model_policy=model_policy,
                ),
            )

        if changed:
            with pytest.raises(HTTPException) as exc_info:
                update()
            assert exc_info.value.status_code == 403
            assert validate.call_args.kwargs["user_id"] == test_user.id
        else:
            result = update()
            assert result["execution_policy"].environment_id == "101"
            validate.assert_not_called()


@pytest.mark.parametrize("model_type", ["user", None])
def test_group_editor_cannot_bind_another_owner_private_model(
    test_db, test_user, group_agent, model_type
):
    _, team, bot, _, _ = group_agent
    model = Kind(
        kind="Model",
        name="unrelated-private-model",
        namespace="default",
        user_id=bot.user_id,
        is_active=True,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Model",
            "metadata": {"name": "unrelated-private-model", "namespace": "default"},
            "spec": {"modelConfig": {"model_id": "test-model"}},
        },
    )
    test_db.add(model)
    test_db.commit()
    config = {"bind_model": model.name}
    if model_type:
        config["bind_model_type"] = model_type
    with pytest.raises(HTTPException) as exc_info:
        bot_kinds_service.update_with_user(
            test_db,
            bot_id=bot.id,
            user_id=test_user.id,
            obj_in=BotUpdate(
                team_id=team.id,
                agent_config=config,
            ),
        )
    assert exc_info.value.status_code == 403


@pytest.mark.parametrize("changed", [False, True])
def test_group_editor_can_retain_but_not_borrow_private_shell(
    test_db, test_user, group_agent, changed
):
    _, team, bot, _, _ = group_agent
    shell_name = "OtherPrivateShell" if changed else "ClaudeCode"
    if changed:
        test_db.add(
            Kind(
                kind="Shell",
                name=shell_name,
                namespace="default",
                user_id=bot.user_id,
                is_active=True,
                json={
                    "apiVersion": "agent.wecode.io/v1",
                    "kind": "Shell",
                    "metadata": {"name": shell_name, "namespace": "default"},
                    "spec": {"shellType": "ClaudeCode"},
                },
            )
        )
        test_db.commit()

    def update():
        return bot_kinds_service.update_with_user(
            test_db,
            bot_id=bot.id,
            user_id=test_user.id,
            obj_in=BotUpdate(team_id=team.id, shell_name=shell_name),
        )

    if changed:
        with pytest.raises(HTTPException) as exc_info:
            update()
        assert exc_info.value.status_code == 403
    else:
        assert update()["shell_name"] == shell_name


def test_group_context_cannot_borrow_another_default_bot_owner(
    test_db, test_user, group_agent
):
    namespace, _, bot, _, _ = group_agent
    unrelated = _create_bot(
        test_db, user_id=test_user.id, name=bot.name, namespace="default"
    )
    unrelated_team = _create_team(
        test_db,
        user_id=test_user.id,
        namespace=namespace.name,
        bot=unrelated,
        name="same-name-agent",
    )
    with pytest.raises(HTTPException) as exc_info:
        bot_kinds_service.update_with_user(
            test_db,
            bot_id=bot.id,
            user_id=test_user.id,
            obj_in=BotUpdate(team_id=unrelated_team.id),
        )
    assert exc_info.value.status_code == 403


def test_public_bot_reference_does_not_grant_source_edit(
    test_db, test_user, group_agent
):
    _, team, _, _, _ = group_agent
    public_bot = _create_bot(test_db, user_id=0, name="public-bot")
    assert can_reference_bot(test_db, public_bot, test_user.id)
    with pytest.raises(HTTPException) as exc_info:
        bot_kinds_service.update_with_user(
            test_db,
            bot_id=public_bot.id,
            user_id=test_user.id,
            obj_in=BotUpdate(team_id=team.id, system_prompt="Not permitted"),
        )
    assert exc_info.value.status_code == 403


def test_group_editor_shell_selection_is_not_shadowed_by_owner_private_shell(
    test_db, test_user, group_agent
):
    namespace, team, bot, _, _ = group_agent
    for scope, runtime in [("default", "ClaudeCode"), (namespace.name, "Codex")]:
        test_db.add(
            Kind(
                kind="Shell",
                name="same-name-shell",
                namespace=scope,
                user_id=bot.user_id,
                is_active=True,
                json={
                    "apiVersion": "agent.wecode.io/v1",
                    "kind": "Shell",
                    "metadata": {"name": "same-name-shell", "namespace": scope},
                    "spec": {"shellType": runtime},
                },
            )
        )
    test_db.commit()
    result = bot_kinds_service.update_with_user(
        test_db,
        bot_id=bot.id,
        user_id=test_user.id,
        obj_in=BotUpdate(team_id=team.id, shell_name="same-name-shell"),
    )
    assert result["shell_type"] == "Codex"
    assert bot.json["spec"]["shellRef"]["namespace"] == namespace.name


def test_team_editor_cannot_insert_bot_from_a_different_default_owner(
    test_db, test_user, group_agent
):
    _, team, _, _, _ = group_agent
    personal_bot = _create_bot(
        test_db, user_id=test_user.id, name="editor-personal-bot"
    )
    with pytest.raises(HTTPException) as exc_info:
        team_kinds_service.update_with_user(
            test_db,
            team_id=team.id,
            user_id=test_user.id,
            obj_in=TeamUpdate(bots=[BotInfo(bot_id=personal_bot.id)]),
        )
    assert exc_info.value.status_code == 403
