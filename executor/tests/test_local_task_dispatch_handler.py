# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for local executor task dispatch handling."""

from unittest.mock import AsyncMock

import pytest

from executor.modes.local.handlers import TaskHandler


@pytest.mark.asyncio
async def test_handle_task_dispatch_preserves_skill_identity_token():
    """Task dispatch should keep skill identity token on ExecutionRequest."""
    runner = AsyncMock()
    handler = TaskHandler(runner)

    await handler.handle_task_dispatch(
        {
            "task_id": 1,
            "subtask_id": 2,
            "skill_identity_token": "skill-jwt",
        }
    )

    request = runner.enqueue_task.await_args.args[0]
    assert request.skill_identity_token == "skill-jwt"
