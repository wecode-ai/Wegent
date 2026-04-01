# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Helpers for building task-scoped skill identity environment variables."""

from typing import Optional

from shared.models.execution import ExecutionRequest


def build_task_identity_env(
    *, skill_identity_token: Optional[str], user_name: Optional[str]
) -> dict[str, str]:
    """Build the standard task-scoped skill identity environment mapping."""
    env: dict[str, str] = {}

    if skill_identity_token:
        env["WEGENT_SKILL_IDENTITY_TOKEN"] = skill_identity_token

    if user_name:
        env["WEGENT_SKILL_USER_NAME"] = user_name

    return env


def build_task_identity_context(request: ExecutionRequest) -> dict[str, str]:
    """Build task identity env from an execution request."""
    return build_task_identity_env(
        skill_identity_token=request.skill_identity_token,
        user_name=request.user_name,
    )
