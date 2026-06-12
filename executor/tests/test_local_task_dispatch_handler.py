# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for local executor task dispatch handling."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from executor.modes.local.handlers import TaskHandler
from executor.modes.local.runner import LocalRunner


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


@pytest.mark.asyncio
async def test_cancel_task_awaits_agent_async_cancellation():
    """Local cancellation should await the agent without blocking the event loop."""
    runner = object.__new__(LocalRunner)
    agent = MagicMock()
    agent.cancel_run_async = AsyncMock(return_value=True)
    runner._running_tasks = {1: SimpleNamespace(agent=agent, cancel_requested=False)}

    await runner.cancel_task(1)

    agent.cancel_run_async.assert_awaited_once_with()
    assert runner._running_tasks[1].cancel_requested is True


@pytest.mark.asyncio
async def test_cancel_task_marks_request_pending_before_agent_is_ready():
    """Local cancellation should survive the gap before agent creation."""
    runner = object.__new__(LocalRunner)
    info = SimpleNamespace(agent=None, cancel_requested=False)
    runner._running_tasks = {1: info}

    await runner.cancel_task(1, subtask_id=2)

    assert info.cancel_requested is True


@pytest.mark.asyncio
async def test_cancel_task_stores_pending_subtask_when_task_not_registered():
    """Cancel can arrive before task:execute is consumed by the local runner."""
    runner = object.__new__(LocalRunner)
    runner._running_tasks = {}
    runner._pending_cancel_task_ids = set()
    runner._pending_cancel_subtask_ids = set()

    await runner.cancel_task(1, subtask_id=2)

    assert runner._pending_cancel_subtask_ids == {2}
    assert runner._pending_cancel_task_ids == set()
