# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User
from app.services.adapters.team_kinds import team_kinds_service


def _create_public_shell(db: Session) -> Kind:
    shell = Kind(
        user_id=0,
        kind="Shell",
        name="ClaudeCode",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Shell",
            "metadata": {
                "name": "ClaudeCode",
                "namespace": "default",
                "labels": {"type": "local_engine"},
            },
            "spec": {"shellType": "ClaudeCode", "baseImage": "test-image:latest"},
            "status": {"state": "Available"},
        },
        is_active=True,
    )
    db.add(shell)
    db.commit()
    db.refresh(shell)
    return shell


def _create_bot(
    db: Session, user: User, name: str, *, model_name: str | None = None
) -> Kind:
    spec = {
        "ghostRef": {"name": f"ghost-{name}", "namespace": "default"},
        "shellRef": {"name": "ClaudeCode", "namespace": "default"},
    }
    if model_name:
        spec["modelRef"] = {"name": model_name, "namespace": "default"}

    bot = Kind(
        user_id=user.id,
        kind="Bot",
        name=name,
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Bot",
            "metadata": {"name": name, "namespace": "default"},
            "spec": spec,
        },
        is_active=True,
    )
    db.add(bot)
    db.commit()
    db.refresh(bot)
    return bot


def _create_model(db: Session, user: User, name: str) -> Kind:
    model = Kind(
        user_id=user.id,
        kind="Model",
        name=name,
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Model",
            "metadata": {"name": name, "namespace": "default"},
            "spec": {
                "modelConfig": {"env": {"model": "openai", "model_id": "test-model"}}
            },
        },
        is_active=True,
    )
    db.add(model)
    db.commit()
    db.refresh(model)
    return model


def _create_pipeline_team(
    db: Session, user: User, first_bot: Kind, second_bot: Kind
) -> Kind:
    team = Kind(
        user_id=user.id,
        kind="Team",
        name="pipeline-team",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Team",
            "metadata": {"name": "pipeline-team", "namespace": "default"},
            "spec": {
                "collaborationModel": "pipeline",
                "members": [
                    {
                        "botRef": {
                            "name": first_bot.name,
                            "namespace": first_bot.namespace,
                        },
                        "prompt": "",
                        "role": "leader",
                        "contextPassing": "previous_bot",
                    },
                    {
                        "botRef": {
                            "name": second_bot.name,
                            "namespace": second_bot.namespace,
                        },
                        "prompt": "",
                        "role": "member",
                    },
                ],
                "bind_mode": ["chat"],
            },
            "status": {"state": "Available"},
        },
        is_active=True,
    )
    db.add(team)
    db.commit()
    db.refresh(team)
    return team


def _create_id_backed_team(db: Session, user: User, bot: Kind) -> Kind:
    team = Kind(
        user_id=user.id,
        kind="Team",
        name="id-backed-team",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Team",
            "metadata": {"name": "id-backed-team", "namespace": "default"},
            "spec": {
                "collaborationModel": "pipeline",
                "members": [
                    {
                        "botRef": {
                            "id": bot.id,
                            "name": bot.name,
                            "namespace": bot.namespace,
                        },
                        "prompt": "",
                        "role": "worker",
                    }
                ],
                "bind_mode": ["chat"],
            },
            "status": {"state": "Available"},
        },
        is_active=True,
    )
    db.add(team)
    db.commit()
    db.refresh(team)
    return team


def test_get_user_teams_preserves_pipeline_context_passing(
    test_db: Session,
    test_user: User,
) -> None:
    _create_public_shell(test_db)
    first_bot = _create_bot(test_db, test_user, "planner-bot")
    second_bot = _create_bot(test_db, test_user, "reviewer-bot")
    team = _create_pipeline_team(test_db, test_user, first_bot, second_bot)

    teams = team_kinds_service.get_user_teams(
        test_db,
        user_id=test_user.id,
        scope="personal",
    )

    listed_team = next(item for item in teams if item["id"] == team.id)
    assert listed_team["bots"][0]["contextPassing"] == "previous_bot"
    assert listed_team["bots"][1]["contextPassing"] == "none"


def test_get_user_teams_preloads_dependencies_for_id_backed_bot_references(
    test_db: Session,
    test_user: User,
) -> None:
    _create_public_shell(test_db)
    _create_model(test_db, test_user, "id-backed-model")
    bot = _create_bot(
        test_db,
        test_user,
        "id-backed-bot",
        model_name="id-backed-model",
    )
    team = _create_id_backed_team(test_db, test_user, bot)

    teams = team_kinds_service.get_user_teams(
        test_db,
        user_id=test_user.id,
        scope="personal",
    )

    listed_team = next(item for item in teams if item["id"] == team.id)
    assert listed_team["agent_type"] == "claude"
    listed_bot = listed_team["bots"][0]
    assert listed_bot["bot_id"] == bot.id
    assert listed_bot["bot"]["shell_type"] == "ClaudeCode"
    assert listed_bot["bot"]["agent_config"] == {
        "bind_model": "id-backed-model",
        "bind_model_type": "user",
    }
