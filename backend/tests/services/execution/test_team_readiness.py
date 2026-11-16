# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

import pytest
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.resource_member import ResourceMember
from app.services.execution.readiness_context import TeamReadinessContext
from app.services.execution.team_readiness import (
    validate_team_execution_readiness,
)


def _resource(
    *,
    user_id: int,
    kind: str,
    name: str,
    spec: dict,
    is_active: bool = True,
) -> Kind:
    return Kind(
        user_id=user_id,
        kind=kind,
        name=name,
        namespace="default",
        is_active=is_active,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": kind,
            "metadata": {"name": name, "namespace": "default"},
            "spec": spec,
        },
    )


def _team_graph(
    db: Session,
    *,
    user_id: int,
    include_bot: bool = True,
    include_ghost: bool = True,
    include_shell: bool = True,
    include_model: bool = True,
    bot_active: bool = True,
    members: bool = True,
) -> Kind:
    model_name = "readiness-model"
    shell_name = "readiness-shell"
    ghost_name = "readiness-ghost"
    bot_name = "readiness-bot"
    resources: list[Kind] = []
    if include_model:
        resources.append(
            _resource(
                user_id=user_id,
                kind="Model",
                name=model_name,
                spec={
                    "modelConfig": {
                        "env": {
                            "api_key": "test-key",
                            "base_url": "https://models.invalid/v1",
                            "model_id": "test-model",
                            "model": "openai",
                        }
                    },
                    "protocol": "openai",
                },
            )
        )
    if include_shell:
        resources.append(
            _resource(
                user_id=user_id,
                kind="Shell",
                name=shell_name,
                spec={"shellType": "Chat"},
            )
        )
    if include_ghost:
        resources.append(
            _resource(
                user_id=user_id,
                kind="Ghost",
                name=ghost_name,
                spec={"systemPrompt": "Handle the board."},
            )
        )
    if include_bot:
        resources.append(
            _resource(
                user_id=user_id,
                kind="Bot",
                name=bot_name,
                is_active=bot_active,
                spec={
                    "ghostRef": {"name": ghost_name, "namespace": "default"},
                    "shellRef": {"name": shell_name, "namespace": "default"},
                    "modelRef": {"name": model_name, "namespace": "default"},
                },
            )
        )
    team = _resource(
        user_id=user_id,
        kind="Team",
        name="readiness-team",
        spec={
            "members": (
                [{"botRef": {"name": bot_name, "namespace": "default"}}]
                if members
                else []
            ),
            "collaborationModel": "solo",
        },
    )
    resources.append(team)
    db.add_all(resources)
    db.commit()
    db.refresh(team)
    return team


@pytest.mark.parametrize("batched", [False, True])
def test_team_readiness_accepts_complete_execution_graph(
    test_db: Session,
    test_user,
    batched: bool,
) -> None:
    """Accept the same complete graph with direct and batched dependency readers."""
    team = _team_graph(test_db, user_id=test_user.id)

    validate_team_execution_readiness(
        test_db,
        team=team,
        execution_user_id=test_user.id,
        context=(
            TeamReadinessContext(test_db, [team], test_user.id) if batched else None
        ),
    )


@pytest.mark.parametrize(
    ("graph_options", "error"),
    [
        ({"members": False}, "has no members"),
        ({"include_bot": False}, "Team member Bot 'default/readiness-bot'"),
        ({"bot_active": False}, "Team member Bot 'default/readiness-bot'"),
        ({"include_ghost": False}, "Ghost 'default/readiness-ghost'"),
        ({"include_shell": False}, "Shell 'default/readiness-shell'"),
        (
            {"include_model": False},
            "Bot readiness-bot has no model|Model readiness-model not found",
        ),
    ],
)
@pytest.mark.parametrize("batched", [False, True])
def test_team_readiness_rejects_incomplete_execution_graph(
    test_db: Session,
    test_user,
    graph_options: dict,
    error: str,
    batched: bool,
) -> None:
    """Reject each missing or invalid dependency in either readiness path."""
    team = _team_graph(test_db, user_id=test_user.id, **graph_options)

    with pytest.raises(ValueError, match=error):
        validate_team_execution_readiness(
            test_db,
            team=team,
            execution_user_id=test_user.id,
            context=(
                TeamReadinessContext(test_db, [team], test_user.id) if batched else None
            ),
        )


@pytest.mark.parametrize("batched", [False, True])
def test_readiness_keeps_model_reference_in_execution_users_scope(
    test_db: Session, test_user, test_admin_user, batched: bool
) -> None:
    """Resolve models as the execution user while preserving Team-owner dependencies."""
    team = _team_graph(test_db, user_id=test_admin_user.id)
    model = (
        test_db.query(Kind)
        .filter_by(
            kind="Model",
            user_id=test_admin_user.id,
            namespace="default",
            name="readiness-model",
        )
        .one()
    )
    grant = ResourceMember.create(
        resource_type="Model",
        resource_id=model.id,
        entity_type="user",
        entity_id=str(test_user.id),
        role="Reporter",
        status="approved",
        invited_by_user_id=test_admin_user.id,
    )
    test_db.add(grant)
    for status in ["pending", "approved", "rejected"]:
        grant.status = status
        test_db.commit()
        context = (
            TeamReadinessContext(test_db, [team], test_user.id) if batched else None
        )
        if status == "approved":
            validate_team_execution_readiness(
                test_db, team=team, execution_user_id=test_user.id, context=context
            )
        else:
            with pytest.raises(ValueError, match="model is unavailable"):
                validate_team_execution_readiness(
                    test_db, team=team, execution_user_id=test_user.id, context=context
                )


@pytest.mark.parametrize("batched", [False, True])
def test_readiness_preserves_public_model_whitelist(
    test_db: Session, test_user, batched: bool
) -> None:
    """Enforce public model restrictions in both readiness paths."""
    team = _team_graph(test_db, user_id=test_user.id)
    model = (
        test_db.query(Kind)
        .filter_by(
            kind="Model",
            user_id=test_user.id,
            namespace="default",
            name="readiness-model",
        )
        .one()
    )
    model.user_id = 0
    for allowed in [True, False]:
        model.json = {
            **model.json,
            "spec": {
                **model.json["spec"],
                "allowedUsersEnabled": True,
                "allowedUsers": [test_user.user_name] if allowed else [],
            },
        }
        test_db.commit()
        context = (
            TeamReadinessContext(test_db, [team], test_user.id) if batched else None
        )
        if allowed:
            validate_team_execution_readiness(
                test_db, team=team, execution_user_id=test_user.id, context=context
            )
        else:
            with pytest.raises(ValueError, match="model is unavailable"):
                validate_team_execution_readiness(
                    test_db, team=team, execution_user_id=test_user.id, context=context
                )


@pytest.mark.parametrize("batched", [False, True])
@pytest.mark.parametrize("cycle", [False, True])
def test_readiness_follows_model_pointers(
    test_db: Session, test_user, batched: bool, cycle: bool
) -> None:
    """Resolve bound model targets without changing readiness semantics."""
    team = _team_graph(test_db, user_id=test_user.id)
    model = test_db.query(Kind).filter_by(kind="Model", user_id=test_user.id).one()
    target = _resource(
        user_id=test_user.id,
        kind="Model",
        name="target-model",
        spec=(
            {"modelConfig": {"bind_model": model.name}} if cycle else model.json["spec"]
        ),
    )
    model.json = {
        **model.json,
        "spec": {"modelConfig": {"bind_model": target.name}},
    }
    test_db.add(target)
    test_db.commit()
    context = TeamReadinessContext(test_db, [team], test_user.id) if batched else None

    if cycle:
        with pytest.raises(ValueError, match="too deep or cyclic"):
            validate_team_execution_readiness(
                test_db, team=team, execution_user_id=test_user.id, context=context
            )
    else:
        validate_team_execution_readiness(
            test_db, team=team, execution_user_id=test_user.id, context=context
        )


@pytest.mark.parametrize("batched", [False, True])
def test_readiness_retains_runner_selected_models(
    test_db: Session, test_user, batched: bool
) -> None:
    """Avoid requiring a platform model for runner-selected execution policies."""
    team = _team_graph(test_db, user_id=test_user.id, include_model=False)
    bot = test_db.query(Kind).filter_by(kind="Bot", user_id=test_user.id).one()
    bot.json = {
        **bot.json,
        "spec": {
            **bot.json["spec"],
            "execution_policy": {"mode": "user_select"},
        },
    }
    test_db.commit()

    validate_team_execution_readiness(
        test_db,
        team=team,
        execution_user_id=test_user.id,
        context=(
            TeamReadinessContext(test_db, [team], test_user.id) if batched else None
        ),
    )
