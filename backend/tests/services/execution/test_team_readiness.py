# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

import pytest
from sqlalchemy.orm import Session

from app.models.kind import Kind
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


def test_team_readiness_accepts_complete_execution_graph(
    test_db: Session,
    test_user,
) -> None:
    team = _team_graph(test_db, user_id=test_user.id)

    validate_team_execution_readiness(
        test_db,
        team=team,
        execution_user_id=test_user.id,
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
def test_team_readiness_rejects_incomplete_execution_graph(
    test_db: Session,
    test_user,
    graph_options: dict,
    error: str,
) -> None:
    team = _team_graph(test_db, user_id=test_user.id, **graph_options)

    with pytest.raises(ValueError, match=error):
        validate_team_execution_readiness(
            test_db,
            team=team,
            execution_user_id=test_user.id,
        )
