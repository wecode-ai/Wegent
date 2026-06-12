from unittest.mock import AsyncMock

import pytest

from executor.agents.codex.codex_agent import CodeXAgent


@pytest.mark.asyncio
async def test_codex_cancel_run_async_interrupts_active_turn():
    """Codex cancellation should await the SDK turn interrupt."""
    agent = object.__new__(CodeXAgent)
    agent.task_id = 1
    agent._turn = AsyncMock()

    cancelled = await agent.cancel_run_async()

    assert cancelled is True
    agent._turn.interrupt.assert_awaited_once_with()


@pytest.mark.asyncio
async def test_codex_cancel_run_async_records_pending_cancel_without_active_turn():
    """Cancellation before turn startup should be consumed by execute_async."""
    agent = object.__new__(CodeXAgent)
    agent.task_id = 1
    agent._turn = None

    cancelled = await agent.cancel_run_async()

    assert cancelled is True
    assert agent._cancel_requested is True
