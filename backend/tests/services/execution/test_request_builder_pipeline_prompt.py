# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Pipeline prompt resolution tests for TaskRequestBuilder."""

from app.schemas.kind import Team
from app.services.execution.request_builder import TaskRequestBuilder
from shared.models.db import Kind


def _create_ghost(test_db, *, user_id: int, name: str, system_prompt: str) -> Kind:
    ghost = Kind(
        user_id=user_id,
        kind="Ghost",
        name=name,
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Ghost",
            "metadata": {"name": name, "namespace": "default"},
            "spec": {"systemPrompt": system_prompt, "mcpServers": {}, "skills": []},
        },
        is_active=True,
    )
    test_db.add(ghost)
    test_db.commit()
    test_db.refresh(ghost)
    return ghost


def _create_bot(test_db, *, user_id: int, name: str, ghost_name: str) -> Kind:
    bot = Kind(
        user_id=user_id,
        kind="Bot",
        name=name,
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Bot",
            "metadata": {"name": name, "namespace": "default"},
            "spec": {
                "ghostRef": {"name": ghost_name, "namespace": "default"},
                "shellRef": {"name": "ClaudeCode", "namespace": "default"},
            },
        },
        is_active=True,
    )
    test_db.add(bot)
    test_db.commit()
    test_db.refresh(bot)
    return bot


def _create_pipeline_team(
    test_db, *, user_id: int, first_bot: Kind, second_bot: Kind
) -> Kind:
    team = Kind(
        user_id=user_id,
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
                        "prompt": "STAGE_ONE_MEMBER_PROMPT",
                        "role": "leader",
                        "requireConfirmation": True,
                        "contextPassing": "none",
                    },
                    {
                        "botRef": {
                            "name": second_bot.name,
                            "namespace": second_bot.namespace,
                        },
                        "prompt": "STAGE_TWO_MEMBER_PROMPT",
                        "role": "worker",
                        "requireConfirmation": False,
                        "contextPassing": "none",
                    },
                ],
            },
        },
        is_active=True,
    )
    test_db.add(team)
    test_db.commit()
    test_db.refresh(team)
    return team


def test_pipeline_bot_config_uses_current_stage_member_prompt(test_db, mocker):
    """Pipeline stage two uses stage two bot and member prompt in runtime config."""
    user_id = 7
    _create_ghost(
        test_db,
        user_id=user_id,
        name="stage-one-ghost",
        system_prompt="STAGE_ONE_GHOST_PROMPT",
    )
    _create_ghost(
        test_db,
        user_id=user_id,
        name="stage-two-ghost",
        system_prompt="STAGE_TWO_GHOST_PROMPT",
    )
    first_bot = _create_bot(
        test_db,
        user_id=user_id,
        name="stage-one-bot",
        ghost_name="stage-one-ghost",
    )
    second_bot = _create_bot(
        test_db,
        user_id=user_id,
        name="stage-two-bot",
        ghost_name="stage-two-ghost",
    )
    team = _create_pipeline_team(
        test_db, user_id=user_id, first_bot=first_bot, second_bot=second_bot
    )
    team_crd = Team.model_validate(team.json)
    builder = TaskRequestBuilder(test_db)

    mocker.patch.object(
        builder,
        "_resolve_shell_info",
        return_value={"shell_type": "ClaudeCode", "base_image": "executor:latest"},
    )
    mocker.patch(
        "app.services.chat.config.model_resolver.build_agent_config_for_bot",
        return_value={},
    )

    bot_configs = builder._build_bot_config(
        team,
        team_crd,
        second_bot,
        user_id=user_id,
    )

    assert len(bot_configs) == 1
    assert bot_configs[0]["id"] == second_bot.id
    assert bot_configs[0]["name"] == second_bot.name
    assert bot_configs[0]["role"] == "worker"
    assert "STAGE_TWO_GHOST_PROMPT" in bot_configs[0]["system_prompt"]
    assert "STAGE_TWO_MEMBER_PROMPT" in bot_configs[0]["system_prompt"]
    assert "STAGE_ONE_MEMBER_PROMPT" not in bot_configs[0]["system_prompt"]
