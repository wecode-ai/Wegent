# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for sandbox skill provider parameter preparation."""

from chat_shell.skills import SkillToolContext
from init_data.skills.sandbox.provider import SandboxToolProvider


def test_prepare_base_params_includes_skill_identity_token():
    """Sandbox provider should forward skill identity token from context."""
    provider = SandboxToolProvider()
    context = SkillToolContext(
        task_id=1,
        subtask_id=2,
        user_id=3,
        db_session=None,
        ws_emitter=None,
        user_name="alice",
        auth_token="task-jwt",
        skill_identity_token="skill-jwt",
    )

    params = provider._prepare_base_params(context, {})

    assert params["skill_identity_token"] == "skill-jwt"
