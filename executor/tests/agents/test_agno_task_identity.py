# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for task-scoped skill identity handling in Agno config extraction."""

from executor.agents.agno.config_utils import ConfigManager
from shared.models.execution import ExecutionRequest


def test_extract_agno_options_injects_task_identity_env_without_mutating_request():
    """Agno options extraction should inject task identity env on copied bot config."""
    request = ExecutionRequest(
        bot=[
            {
                "name": "member-1",
                "agent_config": {"env": {"EXISTING_VAR": "value"}},
            }
        ],
        user_name="alice",
        skill_identity_token="skill-jwt",
    )

    options = ConfigManager({}).extract_agno_options(request)

    member_env = options["team_members"][0]["agent_config"]["env"]
    assert member_env["EXISTING_VAR"] == "value"
    assert member_env["WEGENT_SKILL_IDENTITY_TOKEN"] == "skill-jwt"
    assert member_env["WEGENT_SKILL_USER_NAME"] == "alice"
    assert "WEGENT_SKILL_IDENTITY_TOKEN" not in request.bot[0]["agent_config"]["env"]
