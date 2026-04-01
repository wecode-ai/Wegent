# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for skill identity fields on ExecutionRequest."""

from shared.models.execution import ExecutionRequest


def test_execution_request_round_trips_skill_identity_token() -> None:
    """ExecutionRequest should preserve skill_identity_token via dict round-trip."""
    request = ExecutionRequest(
        task_id=1,
        subtask_id=2,
        user_id=3,
        user_name="alice",
        skill_identity_token="skill-jwt",  # noqa: S106
    )

    data = request.to_dict()
    restored = ExecutionRequest.from_dict(data)

    assert restored.skill_identity_token == "skill-jwt"
