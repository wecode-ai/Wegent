from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from executor.agents.claude_code.claude_code_agent import ClaudeCodeAgent
from executor.services.agent_service import AgentService
from shared.status import TaskStatus


@pytest.mark.asyncio
async def test_claude_client_cleanup_uses_sdk_disconnect():
    agent = MagicMock()
    agent.get_name.return_value = "ClaudeCode"
    agent.session_id = "session-1"
    agent.client = MagicMock()
    agent.close_client_async = AsyncMock(return_value=True)

    status, error = await AgentService()._close_agent_session(1, agent)

    assert status == TaskStatus.SUCCESS
    assert error is None
    agent.close_client_async.assert_awaited_once_with("agent service cleanup")


@pytest.mark.asyncio
async def test_claude_client_cleanup_reports_disconnect_failure():
    agent = MagicMock()
    agent.get_name.return_value = "ClaudeCode"
    agent.session_id = "session-1"
    agent.client = MagicMock()
    agent.close_client_async = AsyncMock(return_value=False)

    status, error = await AgentService()._close_agent_session(1, agent)

    assert status == TaskStatus.FAILED
    assert error == "Failed to close Claude client for session session-1"


@pytest.mark.asyncio
async def test_sdk_disconnect_failure_forces_process_termination():
    agent = object.__new__(ClaudeCodeAgent)
    agent.task_id = 1
    agent.session_id = "session-1"
    agent.client = AsyncMock()
    agent.client.disconnect.side_effect = RuntimeError("disconnect failed")
    client = agent.client

    with (
        patch.object(
            ClaudeCodeAgent,
            "CLIENT_DISCONNECT_TIMEOUT_SECONDS",
            0.01,
        ),
        patch(
            "executor.agents.claude_code.claude_code_agent."
            "SessionManager._terminate_client_process",
            new=AsyncMock(return_value=True),
        ) as terminate,
    ):
        closed = await agent.close_client_async("test")

    assert closed is True
    client.disconnect.assert_awaited_once_with()
    terminate.assert_awaited_once_with(client, "session-1")
    assert agent.client is None
