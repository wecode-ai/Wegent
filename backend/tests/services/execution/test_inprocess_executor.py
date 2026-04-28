import sys
import types
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.execution.inprocess_executor import InprocessExecutor
from shared.models.execution import ExecutionRequest
from shared.status import TaskStatus


@pytest.mark.asyncio
async def test_execute_passes_execution_request_to_agent_service() -> None:
    """Pass an ExecutionRequest object directly to AgentService."""
    request = ExecutionRequest(task_id=1, subtask_id=2, message_id=3)
    emitter = AsyncMock()
    executor = InprocessExecutor()

    agent = MagicMock()
    agent.get_name.return_value = "fake-agent"

    agent_service = MagicMock()
    agent_service.create_agent.return_value = agent
    fake_module = types.ModuleType("executor.services.agent_service")
    fake_module.AgentService = MagicMock(return_value=agent_service)

    with (
        patch.dict(sys.modules, {"executor.services.agent_service": fake_module}),
        patch.object(
            executor,
            "_execute_agent_async",
            new=AsyncMock(return_value=(TaskStatus.SUCCESS, None)),
        ) as mock_execute_agent,
        patch.object(
            executor,
            "_cleanup_task_clients",
            new=AsyncMock(),
        ) as mock_cleanup,
    ):
        await executor.execute(request, emitter)

    agent_service.create_agent.assert_called_once()
    assert agent_service.create_agent.call_args.args[0] is request
    mock_execute_agent.assert_awaited_once_with(agent)
    mock_cleanup.assert_awaited_once_with(request.task_id)


@pytest.mark.asyncio
async def test_execute_agent_async_awaits_pre_execute_and_skips_missing_post_execute() -> (
    None
):
    """Await async lifecycle hooks without requiring post_execute()."""
    executor = InprocessExecutor()
    agent = SimpleNamespace(
        task_id=3,
        get_name=lambda: "fake-agent",
        pre_execute=AsyncMock(return_value=(TaskStatus.SUCCESS, None)),
        execute_async=AsyncMock(return_value=TaskStatus.COMPLETED),
    )

    status, error = await executor._execute_agent_async(agent)

    assert status == TaskStatus.COMPLETED
    assert error is None
    agent.pre_execute.assert_awaited_once()
    agent.execute_async.assert_awaited_once()


@pytest.mark.asyncio
async def test_execute_agent_async_returns_failed_when_pre_execute_fails() -> None:
    """Return FAILED when pre_execute reports a failure status."""
    executor = InprocessExecutor()
    agent = SimpleNamespace(
        task_id=4,
        get_name=lambda: "fake-agent",
        pre_execute=AsyncMock(return_value=(TaskStatus.FAILED, "boom")),
        execute_async=AsyncMock(),
    )

    status, error = await executor._execute_agent_async(agent)

    assert status == TaskStatus.FAILED
    assert error is not None
    assert "Pre-execute failed" in error
    assert "boom" in error
    agent.pre_execute.assert_awaited_once()
    agent.execute_async.assert_not_awaited()


@pytest.mark.asyncio
async def test_execute_raises_and_emits_error_when_agent_lifecycle_returns_failed() -> (
    None
):
    """Raise and emit an error when the agent lifecycle returns FAILED."""
    request = ExecutionRequest(task_id=10, subtask_id=11, message_id=12)
    emitter = AsyncMock()
    executor = InprocessExecutor()

    agent = MagicMock()
    agent.get_name.return_value = "fake-agent"

    agent_service = MagicMock()
    agent_service.create_agent.return_value = agent
    fake_module = types.ModuleType("executor.services.agent_service")
    fake_module.AgentService = MagicMock(return_value=agent_service)

    with (
        patch.dict(sys.modules, {"executor.services.agent_service": fake_module}),
        patch.object(
            executor,
            "_execute_agent_async",
            new=AsyncMock(return_value=(TaskStatus.FAILED, "pre-execute failed")),
        ),
        patch.object(
            executor,
            "_cleanup_task_clients",
            new=AsyncMock(),
        ) as mock_cleanup,
        pytest.raises(RuntimeError, match="pre-execute failed"),
    ):
        await executor.execute(request, emitter)

    emitter.emit_error.assert_awaited_once()
    mock_cleanup.assert_not_awaited()
