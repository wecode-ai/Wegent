# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for task-scoped skill identity context building."""

from executor.services.task_identity import build_task_identity_context
from shared.models.execution import ExecutionRequest


def test_build_task_identity_context_returns_standard_skill_identity_env():
    """Task identity context should expose the standard skill identity env keys."""
    request = ExecutionRequest(
        user_name="alice",
        skill_identity_token="skill-jwt",
    )

    env = build_task_identity_context(request)

    assert env == {
        "WEGENT_SKILL_IDENTITY_TOKEN": "skill-jwt",
        "WEGENT_SKILL_USER_NAME": "alice",
    }
