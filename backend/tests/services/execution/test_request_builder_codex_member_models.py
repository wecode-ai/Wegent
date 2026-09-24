# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Codex member models use resolved credentials and execution identity headers."""

from types import SimpleNamespace

import pytest

from app.schemas.kind import Team
from app.services.chat.config.model_resolver import build_agent_config_for_bot
from app.services.execution.request_builder import TaskRequestBuilder


@pytest.mark.parametrize("runtime_override", [None, {"model_id": "task-model"}])
def test_codex_coordinate_resolves_member_model_credentials_and_headers(
    test_db, mocker, runtime_override
):
    builder = TaskRequestBuilder(test_db)
    bots = {}
    for bot_id, name in enumerate(["leader", "reviewer", "inherit"], 1):
        agent_config = (
            {
                "env": {
                    "model": "openai",
                    "model_id": f"{name}-model",
                    "api_key": f"encrypted-{name}-key",
                    "base_url": "https://models.example/v1",
                    "reasoning": {"effort": "high"},
                },
                "DEFAULT_HEADERS": {
                    "user": "${user.name}",
                    "task-id": "${task_data.task_id}",
                    "wegent-agent-name": "${task_data.team.name}",
                },
            }
            if name != "inherit"
            else {}
        )
        bots[name] = SimpleNamespace(
            id=bot_id,
            name=name,
            namespace="default",
            json={
                "kind": "Bot",
                "metadata": {"name": name, "namespace": "default"},
                "spec": {
                    "ghostRef": {"name": f"{name}-ghost", "namespace": "default"},
                    "shellRef": {"name": "Codex", "namespace": "default"},
                    "agent_config": agent_config,
                },
            },
        )
    team_crd = Team.model_validate(
        {
            "kind": "Team",
            "metadata": {"name": "review-team", "namespace": "default"},
            "spec": {
                "collaborationModel": "coordinate",
                "members": [
                    {"botRef": {"name": name, "namespace": "default"}} for name in bots
                ],
            },
        }
    )
    mocker.patch.object(
        builder,
        "_resolve_shell_info",
        return_value={"shell_type": "Codex", "base_image": None},
    )
    mocker.patch.object(builder, "_build_runtime_system_prompt", return_value="")
    mocker.patch(
        "app.services.execution.request_builder.kindReader.get_by_name_and_namespace",
        side_effect=lambda db, owner, kind, namespace, name: bots.get(name),
    )
    decrypt = mocker.patch(
        "app.services.chat.config.model_resolver.decrypt_api_key",
        return_value="resolved-member-key",
    )

    result = builder._build_bot_config(
        team=SimpleNamespace(id=5, user_id=7, name="review-team", namespace="default"),
        team_crd=team_crd,
        first_bot=bots["leader"],
        user_id=7,
        user_name="alice",
        task_id=123,
        runtime_model_config=runtime_override,
    )

    if runtime_override:
        assert all(bot["agent_config"]["env"] == runtime_override for bot in result)
        decrypt.assert_not_called()
    else:
        member_env = result[1]["agent_config"]["env"]
        assert member_env["model_id"] == "reviewer-model"
        assert member_env["api_key"] == "resolved-member-key"
        assert member_env["reasoning"] == {"effort": "high"}
        assert member_env["default_headers"] == {
            "user": "alice",
            "task-id": "123",
            "wegent-agent-name": "review-team",
        }
        assert result[2]["agent_config"] == {}
        decrypt.assert_called_once_with("encrypted-reviewer-key")


def test_bound_member_model_preserves_explicit_responses_format(test_db, mocker):
    model_config = {"env": {"model": "openai", "model_id": "member-model"}}
    model_spec = {
        "protocol": "openai",
        "apiFormat": "responses",
        "modelConfig": model_config,
    }
    bot = SimpleNamespace(name="reviewer", json={"spec": {}})
    mocker.patch(
        "app.services.chat.config.model_resolver._resolve_model_for_bot",
        return_value=(None, model_spec, "member-model", {}),
    )

    result = build_agent_config_for_bot(test_db, bot, user_id=7)

    assert result == {**model_config, "protocol": "openai", "apiFormat": "responses"}
    assert "protocol" not in model_config
    assert "apiFormat" not in model_config
