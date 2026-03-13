# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from executor.tasks import task_processor
from shared.models.execution import ExecutionRequest
from shared.status import TaskStatus


@pytest.fixture
def task_data() -> ExecutionRequest:
    """Create minimal task data for task processor tests."""
    return ExecutionRequest(
        task_id=123,
        subtask_id=456,
        task_title="Test Task",
        subtask_title="Test Subtask",
    )


@pytest.fixture
def mock_emitter() -> MagicMock:
    """Create a mock emitter for task lifecycle callbacks."""
    emitter = MagicMock()
    emitter.start = AsyncMock(return_value={"status": TaskStatus.SUCCESS.value})
    emitter.done = AsyncMock()
    emitter.error = AsyncMock()
    return emitter


def _capture_background_tasks(monkeypatch: pytest.MonkeyPatch) -> list:
    """Capture background tasks created by process_async for deterministic tests."""
    created_tasks = []
    original_create_task = task_processor.asyncio.create_task

    def create_task_and_capture(coro):
        task = original_create_task(coro)
        created_tasks.append(task)
        return task

    monkeypatch.setattr(task_processor.asyncio, "create_task", create_task_and_capture)
    return created_tasks


@pytest.mark.asyncio
async def test_process_async_sends_error_callback_for_failed_background_task(
    task_data: ExecutionRequest,
    mock_emitter: MagicMock,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Task processor should send terminal error callback when background task fails."""
    created_tasks = _capture_background_tasks(monkeypatch)
    monkeypatch.setattr(task_processor, "_create_emitter", lambda _: mock_emitter)

    with patch.object(
        task_processor.AgentService,
        "execute_task",
        new=AsyncMock(return_value=(TaskStatus.FAILED, "clone failed")),
    ):
        status = await task_processor.process_async(task_data)
        assert len(created_tasks) == 1
        await created_tasks[0]

    assert status == TaskStatus.RUNNING
    mock_emitter.error.assert_awaited_once_with("clone failed")
    mock_emitter.done.assert_not_awaited()


@pytest.mark.asyncio
async def test_process_async_does_not_send_terminal_callback_for_running_background_task(
    task_data: ExecutionRequest,
    mock_emitter: MagicMock,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Task processor should not emit terminal callbacks for non-terminal RUNNING status."""
    created_tasks = _capture_background_tasks(monkeypatch)
    monkeypatch.setattr(task_processor, "_create_emitter", lambda _: mock_emitter)

    with patch.object(
        task_processor.AgentService,
        "execute_task",
        new=AsyncMock(return_value=(TaskStatus.RUNNING, None)),
    ):
        status = await task_processor.process_async(task_data)
        assert len(created_tasks) == 1
        await created_tasks[0]

    assert status == TaskStatus.RUNNING
    mock_emitter.done.assert_not_awaited()
    mock_emitter.error.assert_not_awaited()
