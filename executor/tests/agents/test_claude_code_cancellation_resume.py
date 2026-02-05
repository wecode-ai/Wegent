import asyncio

import pytest

from executor.agents.claude_code import claude_code_agent as claude_code_agent_module
from executor.agents.claude_code.claude_code_agent import (
    ClaudeCodeAgent,
)
from executor.agents.claude_code.response_processor import process_response
from executor.tasks.task_state_manager import TaskState, TaskStateManager
from shared.status import TaskStatus


@pytest.mark.asyncio
async def test_async_execute_resets_cancelled_state_and_runs(
    monkeypatch: pytest.MonkeyPatch,
):
    task_id = 99101

    task_data = {
        "task_id": task_id,
        "subtask_id": 1,
        "prompt": "hello",
        "bot": [],
        "user": {},
    }

    agent = ClaudeCodeAgent(task_data)
    agent.state_manager = object()

    task_state_manager = TaskStateManager()
    task_state_manager.set_state(task_id, TaskState.CANCELLED)

    query_calls: list[tuple[str, str]] = []

    class FakeClient:
        async def query(self, prompt: str, session_id: str) -> None:
            query_calls.append((prompt, session_id))

    agent.client = FakeClient()

    async def fake_process_response(*args, **kwargs):
        return TaskStatus.COMPLETED

    monkeypatch.setattr(
        claude_code_agent_module, "process_response", fake_process_response
    )

    result = await agent._async_execute()

    assert result == TaskStatus.COMPLETED
    assert query_calls, "Expected a query call after resetting cancelled state"
    assert task_state_manager.get_state(task_id) == TaskState.COMPLETED

    task_state_manager.cleanup(task_id)


@pytest.mark.asyncio
async def test_process_response_fails_on_error_during_execution_system_message():
    from claude_agent_sdk.types import SystemMessage

    class FakeClient:
        async def receive_response(self):
            yield SystemMessage(
                subtype="error_during_execution",
                data={"message": "boom"},
            )

    class FakeStateManager:
        def __init__(self):
            self.task_data = {"task_id": 1}
            self.workbench_statuses: list[str] = []
            self.progress_reports: list[dict] = []

        def update_workbench_status(self, status: str) -> None:
            self.workbench_statuses.append(status)

        def report_progress(
            self,
            progress: int,
            status: str,
            message: str,
            include_thinking: bool = True,
            include_workbench: bool = True,
            extra_result=None,
        ) -> None:
            self.progress_reports.append(
                {
                    "progress": progress,
                    "status": status,
                    "message": message,
                    "extra_result": extra_result,
                }
            )

    state_manager = FakeStateManager()

    result = await process_response(
        client=FakeClient(),
        state_manager=state_manager,
        thinking_manager=None,
        task_state_manager=None,
        session_id="s1",
    )

    assert result == TaskStatus.FAILED
    assert "failed" in state_manager.workbench_statuses
    assert any(
        report["status"] == TaskStatus.FAILED.value
        for report in state_manager.progress_reports
    )


@pytest.mark.asyncio
async def test_process_response_treats_exit_143_as_cancelled():
    class FakeClient:
        async def receive_response(self):
            raise Exception(
                "Command failed with exit code 143 (exit code: 143)\n"
                "Error output: Check stderr output for details"
            )
            if False:
                yield None

    class FakeStateManager:
        def __init__(self):
            self.task_data = {"task_id": 2333}
            self.workbench_statuses: list[str] = []
            self.progress_reports: list[dict] = []

        def update_workbench_status(self, status: str) -> None:
            self.workbench_statuses.append(status)

        def report_progress(
            self,
            progress: int,
            status: str,
            message: str,
            include_thinking: bool = True,
            include_workbench: bool = True,
            extra_result=None,
        ) -> None:
            self.progress_reports.append(
                {
                    "progress": progress,
                    "status": status,
                    "message": message,
                    "extra_result": extra_result,
                }
            )

    task_state_manager = TaskStateManager()
    task_state_manager.set_state(2333, TaskState.CANCELLED)

    state_manager = FakeStateManager()
    result = await process_response(
        client=FakeClient(),
        state_manager=state_manager,
        thinking_manager=None,
        task_state_manager=task_state_manager,
        session_id="s1",
    )

    assert result == TaskStatus.COMPLETED
    assert state_manager.workbench_statuses == ["completed"]
    assert not state_manager.progress_reports

    task_state_manager.cleanup(2333)


@pytest.mark.asyncio
async def test_interrupt_timeout_forces_cleanup(monkeypatch: pytest.MonkeyPatch):
    task_id = 99102
    task_data = {
        "task_id": task_id,
        "subtask_id": 1,
        "prompt": "hello",
        "bot": [],
        "user": {},
    }

    agent = ClaudeCodeAgent(task_data)

    class SlowInterruptClient:
        async def interrupt(self) -> None:
            await asyncio.sleep(10)

    agent.client = SlowInterruptClient()

    called: dict[str, int] = {}

    async def fake_cleanup_task_clients(cls, cleanup_task_id: int) -> int:
        called["task_id"] = cleanup_task_id
        return 1

    monkeypatch.setattr(
        ClaudeCodeAgent,
        "cleanup_task_clients",
        classmethod(fake_cleanup_task_clients),
    )

    monkeypatch.setattr(claude_code_agent_module, "INTERRUPT_TIMEOUT_SECONDS", 0.01)

    await agent._async_cancel_run()

    assert called.get("task_id") == task_id
    assert agent.client is None
