# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Model selection contracts for cross-owner Team editing."""

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.namespace import Namespace
from app.schemas.base_role import BaseRole
from app.schemas.bot import BotUpdate
from app.services.adapters.bot_kinds import bot_kinds_service
from tests.services.adapters.test_bot_kinds_permissions import (
    _add_group_member,
)
from tests.services.adapters.test_bot_kinds_permissions import (
    group_agent as group_agent,
)


def _create_model(
    db: Session, *, owner_id: int, name: str, namespace: str = "default"
) -> Kind:
    """Persist a distinguishable model without external credentials."""
    model = Kind(
        kind="Model",
        name=name,
        namespace=namespace,
        user_id=owner_id,
        is_active=True,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Model",
            "metadata": {"name": name, "namespace": namespace},
            "spec": {"modelConfig": {"model_id": f"model-for-owner-{owner_id}"}},
        },
    )
    db.add(model)
    db.commit()
    return model


@pytest.mark.parametrize(
    "selection",
    [
        "missing",
        "editor_private",
        "retained_name_editor_private",
        "public_shadow",
        "retained_name_public_shadow",
    ],
)
def test_new_model_must_match_persisted_owner_lookup(
    test_db, test_user, group_agent, selection
):
    """Reject missing models and selections that reload as another owner's asset."""
    _, team, bot, _, _ = group_agent
    name = "new-selected-model"
    config = {"bind_model": name}
    public_model = None
    if selection in ("editor_private", "retained_name_editor_private"):
        _create_model(test_db, owner_id=test_user.id, name=name)
        if selection == "retained_name_editor_private":
            bot.json = {
                **bot.json,
                "spec": {
                    **bot.json["spec"],
                    "modelRef": {"name": name, "namespace": "default"},
                },
            }
            test_db.commit()
    elif selection in (
        "public_shadow",
        "retained_name_public_shadow",
        "retained_name_missing_public",
    ):
        _create_model(test_db, owner_id=bot.user_id, name=name)
        # The owner's stale private reference is only trustworthy when no
        # explicit public selection ID identifies a different resource.
        config["bind_model_type"] = "public"
        if selection != "retained_name_missing_public":
            public_model = _create_model(test_db, owner_id=0, name=name)
        if selection.startswith("retained_name"):
            bot.json = {
                **bot.json,
                "spec": {
                    **bot.json["spec"],
                    "modelRef": {"name": name, "namespace": "default"},
                },
            }
            test_db.commit()

    original_spec = dict(bot.json["spec"])
    with pytest.raises(HTTPException) as exc_info:
        bot_kinds_service.update_with_user(
            test_db,
            bot_id=bot.id,
            user_id=test_user.id,
            obj_in=BotUpdate(
                team_id=team.id,
                model_id=public_model.id if public_model else None,
                agent_config=config,
            ),
        )
    assert exc_info.value.status_code == 403
    test_db.rollback()
    test_db.expire_all()
    assert test_db.get(Kind, bot.id).json["spec"] == original_spec


@pytest.mark.parametrize("model_type", [None, "public"])
def test_group_editor_can_select_public_model_and_reload(
    test_db, test_user, group_agent, model_type
):
    """A shared public selection remains the exact same model after persistence."""
    _, team, bot, _, _ = group_agent
    model = _create_model(test_db, owner_id=0, name="selected-public-model")
    config = {"bind_model": model.name}
    if model_type:
        config["bind_model_type"] = model_type
    result = bot_kinds_service.update_with_user(
        test_db,
        bot_id=bot.id,
        user_id=test_user.id,
        obj_in=BotUpdate(team_id=team.id, agent_config=config),
    )
    test_db.expire_all()
    saved_bot = test_db.get(Kind, bot.id)
    resolved_model = bot_kinds_service._get_bot_components(
        test_db, saved_bot, saved_bot.user_id, viewer_id=test_user.id
    )[2]
    assert result["agent_config"]["bind_model"] == model.name
    assert resolved_model.id == model.id
    assert resolved_model.user_id == 0


def test_group_editor_can_retain_existing_creator_private_model(
    test_db, test_user, group_agent
):
    """Retention is not permission to introduce another private model."""
    _, team, bot, _, _ = group_agent
    model = _create_model(test_db, owner_id=bot.user_id, name="retained-private-model")
    bot.json = {
        **bot.json,
        "spec": {
            **bot.json["spec"],
            "modelRef": {"name": model.name, "namespace": "default"},
        },
    }
    test_db.commit()
    result = bot_kinds_service.update_with_user(
        test_db,
        bot_id=bot.id,
        user_id=test_user.id,
        obj_in=BotUpdate(
            team_id=team.id,
            agent_config={"bind_model": model.name, "bind_model_type": "user"},
            system_prompt="Retain the existing private model",
        ),
    )
    assert result["system_prompt"] == "Retain the existing private model"
    assert bot_kinds_service._get_bot_components(test_db, bot, bot.user_id)[2].id == (
        model.id
    )


def test_same_name_primary_model_is_not_implicit_editor_selection(
    test_db, test_user, group_agent
):
    """A name collision cannot silently retain the creator's private model."""
    _, team, bot, ghost, _ = group_agent
    name = "same-name-private-model"
    owner_model = _create_model(test_db, owner_id=bot.user_id, name=name)
    editor_model = _create_model(test_db, owner_id=test_user.id, name=name)
    bot.json = {
        **bot.json,
        "spec": {
            **bot.json["spec"],
            "modelRef": {"name": name, "namespace": "default"},
        },
    }
    test_db.commit()
    original_bot = dict(bot.json["spec"])
    original_ghost = dict(ghost.json["spec"])

    with pytest.raises(HTTPException) as exc_info:
        bot_kinds_service.update_with_user(
            test_db,
            bot_id=bot.id,
            user_id=test_user.id,
            obj_in=BotUpdate(
                team_id=team.id,
                model_id=editor_model.id,
                agent_config={"bind_model": name, "bind_model_type": "user"},
                system_prompt="An editor's same-name model must be authorized.",
            ),
        )

    assert exc_info.value.status_code == 403
    test_db.rollback()
    test_db.expire_all()
    assert test_db.get(Kind, bot.id).json["spec"] == original_bot
    assert test_db.get(Kind, ghost.id).json["spec"] == original_ghost
    assert bot_kinds_service._get_bot_components(test_db, bot, bot.user_id)[2].id == (
        owner_model.id
    )
    assert editor_model.user_id == test_user.id


@pytest.mark.parametrize("model_type", [None, "group"])
def test_group_editor_can_select_shared_group_model_and_reload(
    test_db, test_user, group_agent, model_type
):
    """Group model ownership does not replace current namespace membership."""
    namespace, team, bot, _, _ = group_agent
    # Namespace creation also persists the creator's approved Owner membership.
    _add_group_member(
        test_db, namespace=namespace, user_id=bot.user_id, role=BaseRole.Owner
    )
    model = _create_model(
        test_db,
        owner_id=test_user.id,
        name="selected-group-model",
        namespace=namespace.name,
    )
    config = {"bind_model": model.name, "bind_model_namespace": namespace.name}
    if model_type:
        config["bind_model_type"] = model_type
    bot_kinds_service.update_with_user(
        test_db,
        bot_id=bot.id,
        user_id=test_user.id,
        obj_in=BotUpdate(
            team_id=team.id,
            agent_config=config,
            secondary_model_name=model.name,
            secondary_model_namespace=namespace.name,
        ),
    )
    test_db.expire_all()
    saved_bot = test_db.get(Kind, bot.id)
    assert (
        bot_kinds_service._get_bot_components(
            test_db, saved_bot, saved_bot.user_id, viewer_id=test_user.id
        )[2].id
        == model.id
    )


@pytest.mark.parametrize("secondary", [False, True])
@pytest.mark.parametrize("missing_access", ["owner", "editor"])
def test_group_model_requires_both_owner_and_editor_access(
    test_db, test_user, group_agent, missing_access, secondary
):
    """Neither side can use the other's unrelated namespace authority."""
    _, team, bot, _, _ = group_agent
    namespace = Namespace(
        name="unshared-model-group",
        display_name="Unshared Model Group",
        owner_user_id=test_user.id if missing_access == "owner" else bot.user_id,
        visibility="private",
        level="group",
        is_active=True,
    )
    test_db.add(namespace)
    test_db.commit()
    _add_group_member(
        test_db,
        namespace=namespace,
        user_id=namespace.owner_user_id,
        role=BaseRole.Owner,
    )
    model = _create_model(
        test_db,
        owner_id=namespace.owner_user_id,
        name="unshared-group-model",
        namespace=namespace.name,
    )
    selection = (
        {
            "secondary_model_name": model.name,
            "secondary_model_namespace": namespace.name,
        }
        if secondary
        else {
            "agent_config": {
                "bind_model": model.name,
                "bind_model_type": "group",
                "bind_model_namespace": namespace.name,
            }
        }
    )
    with pytest.raises(HTTPException) as exc_info:
        bot_kinds_service.update_with_user(
            test_db,
            bot_id=bot.id,
            user_id=test_user.id,
            obj_in=BotUpdate(team_id=team.id, **selection),
        )
    assert exc_info.value.status_code == 403


@pytest.mark.parametrize("secondary", [False, True])
@pytest.mark.parametrize("excluded", ["owner", "editor"])
def test_new_public_model_requires_both_owner_and_editor_whitelist(
    test_db, test_user, test_admin_user, group_agent, excluded, secondary
):
    """A reference must be available when the creator reloads it independently."""
    _, team, bot, _, _ = group_agent
    model = _create_model(test_db, owner_id=0, name="restricted-shared-model")
    allowed_user = test_user if excluded == "owner" else test_admin_user
    model.json = {
        **model.json,
        "spec": {
            **model.json["spec"],
            "allowedUsersEnabled": True,
            "allowedUsers": [allowed_user.user_name],
        },
    }
    test_db.commit()
    selection = (
        {"secondary_model_name": model.name}
        if secondary
        else {
            "agent_config": {
                "bind_model": model.name,
                "bind_model_type": "public",
            }
        }
    )
    with pytest.raises(HTTPException) as exc_info:
        bot_kinds_service.update_with_user(
            test_db,
            bot_id=bot.id,
            user_id=test_user.id,
            obj_in=BotUpdate(team_id=team.id, **selection),
        )
    assert exc_info.value.status_code == 403


@pytest.mark.parametrize("selection", ["missing", "editor_private", "owner_private"])
def test_secondary_model_selection_requires_shared_owner_scope(
    test_db, test_user, group_agent, selection
):
    """Secondary references cannot bypass the primary selection boundary."""
    _, team, bot, ghost, _ = group_agent
    name = "new-secondary-model"
    if selection != "missing":
        _create_model(
            test_db,
            owner_id=test_user.id if selection == "editor_private" else bot.user_id,
            name=name,
        )
    original_bot = dict(bot.json["spec"])
    original_ghost = dict(ghost.json["spec"])
    with pytest.raises(HTTPException) as exc_info:
        bot_kinds_service.update_with_user(
            test_db,
            bot_id=bot.id,
            user_id=test_user.id,
            obj_in=BotUpdate(
                team_id=team.id,
                secondary_model_name=name,
                system_prompt="Invalid secondary selection must not persist",
            ),
        )
    assert exc_info.value.status_code == 403
    test_db.rollback()
    test_db.expire_all()
    assert test_db.get(Kind, bot.id).json["spec"] == original_bot
    assert test_db.get(Kind, ghost.id).json["spec"] == original_ghost


def test_secondary_retention_requires_a_resolvable_owner_reference(
    test_db, test_user, group_agent
):
    """A stale secondary name cannot be replaced by an editor-private model."""
    _, team, bot, ghost, _ = group_agent
    name = "stale-secondary-model"
    editor_model = _create_model(test_db, owner_id=test_user.id, name=name)
    bot.json = {
        **bot.json,
        "spec": {
            **bot.json["spec"],
            "secondaryModelRef": {"name": name, "namespace": "default"},
        },
    }
    test_db.commit()
    original_bot = dict(bot.json["spec"])
    original_ghost = dict(ghost.json["spec"])

    with pytest.raises(HTTPException) as exc_info:
        bot_kinds_service.update_with_user(
            test_db,
            bot_id=bot.id,
            user_id=test_user.id,
            obj_in=BotUpdate(
                team_id=team.id,
                secondary_model_name=name,
                system_prompt="A stale secondary reference must not be replaced.",
            ),
        )

    assert exc_info.value.status_code == 403
    test_db.rollback()
    test_db.expire_all()
    assert test_db.get(Kind, bot.id).json["spec"] == original_bot
    assert test_db.get(Kind, ghost.id).json["spec"] == original_ghost
    assert (
        bot_kinds_service._get_model_by_name(test_db, name, "default", bot.user_id)
        is None
    )
    assert (
        bot_kinds_service._get_model_by_name(test_db, name, "default", test_user.id).id
        == editor_model.id
    )


def test_group_editor_can_select_public_secondary_model_and_reload(
    test_db, test_user, group_agent
):
    """A public secondary reference resolves identically after reloading."""
    _, team, bot, _, _ = group_agent
    model = _create_model(test_db, owner_id=0, name="public-secondary-model")
    result = bot_kinds_service.update_with_user(
        test_db,
        bot_id=bot.id,
        user_id=test_user.id,
        obj_in=BotUpdate(team_id=team.id, secondary_model_name=model.name),
    )
    test_db.expire_all()
    reference = test_db.get(Kind, bot.id).json["spec"]["secondaryModelRef"]
    assert result["secondary_model_name"] == model.name
    assert reference == {"name": model.name, "namespace": "default"}
    assert (
        bot_kinds_service._get_model_by_name(
            test_db, reference["name"], reference["namespace"], bot.user_id
        ).id
        == model.id
    )


def test_group_editor_can_retain_or_clear_creator_private_secondary_model(
    test_db, test_user, group_agent
):
    """Retaining or removing an existing private reference grants no new access."""
    _, team, bot, _, _ = group_agent
    model = _create_model(test_db, owner_id=bot.user_id, name="private-secondary-model")
    bot.json = {
        **bot.json,
        "spec": {
            **bot.json["spec"],
            "secondaryModelRef": {"name": model.name, "namespace": "default"},
        },
    }
    test_db.commit()
    for name in (model.name, None):
        result = bot_kinds_service.update_with_user(
            test_db,
            bot_id=bot.id,
            user_id=test_user.id,
            obj_in=BotUpdate(team_id=team.id, secondary_model_name=name),
        )
        assert result["secondary_model_name"] == name
    assert test_db.get(Kind, model.id).is_active
