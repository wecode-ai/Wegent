# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from shared.models.execution import ExecutionRequest
from shared.utils.task_identity import (
    build_task_identity_context,
    build_task_identity_env,
)


def test_build_task_identity_env_returns_expected_mapping():
    env = build_task_identity_env(skill_identity_token="skill-jwt", user_name="alice")

    assert env == {
        "WEGENT_SKILL_IDENTITY_TOKEN": "skill-jwt",
        "WEGENT_SKILL_USER_NAME": "alice",
    }


def test_build_task_identity_context_reads_from_execution_request():
    request = ExecutionRequest(skill_identity_token="token-1", user_name="bob")

    env = build_task_identity_context(request)

    assert env["WEGENT_SKILL_IDENTITY_TOKEN"] == "token-1"
    assert env["WEGENT_SKILL_USER_NAME"] == "bob"
