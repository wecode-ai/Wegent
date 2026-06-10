from unittest.mock import AsyncMock, MagicMock

import pytest

from executor.agents.claude_code.claude_code_agent import ClaudeCodeAgent
from executor.tasks.task_state_manager import TaskState


@pytest.mark.asyncio
async def test_cancel_run_async_uses_sdk_interrupt():
    agent = object.__new__(ClaudeCodeAgent)
    agent.task_id = 1
    agent.session_id = "session-1"
    agent.task_state_manager = MagicMock()
    agent.client = AsyncMock()

    cancelled = await agent.cancel_run_async()

    assert cancelled is True
    agent.task_state_manager.set_state.assert_called_once_with(1, TaskState.CANCELLED)
    agent.client.interrupt.assert_awaited_once_with()
    agent.client.disconnect.assert_not_awaited()


@pytest.mark.asyncio
async def test_close_interrupted_session_disconnects_after_result_is_consumed():
    agent = object.__new__(ClaudeCodeAgent)
    agent.task_id = 1
    agent.session_id = "session-1"
    agent.client = AsyncMock()
    client = agent.client

    await agent._close_interrupted_session()

    client.disconnect.assert_awaited_once_with()
    assert agent.client is None
