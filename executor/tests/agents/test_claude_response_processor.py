from unittest.mock import AsyncMock, MagicMock

import pytest
from claude_agent_sdk.types import (
    AssistantMessage,
    ResultMessage,
    StreamEvent,
    TextBlock,
    ToolUseBlock,
)

from executor.agents.claude_code.response_processor import (
    _handle_assistant_message,
    _handle_stream_event,
    _process_result_message,
)
from executor.tasks.task_state_manager import TaskState, TaskStateManager
from shared.status import TaskStatus


class DummyStateManager:
    def __init__(self, task_id=1):
        self.task_data = MagicMock(task_id=task_id)
        self.statuses = []

    def update_workbench_summary(self, *_args, **_kwargs):
        pass

    def set_task_status(self, status):
        self.statuses.append(status)

    def report_progress(self, *_args, **_kwargs):
        pass


@pytest.mark.asyncio
async def test_stream_tool_use_start_does_not_emit_incomplete_tool_block():
    emitter = MagicMock()
    emitter.flush = AsyncMock()
    emitter.tool_start = AsyncMock()

    msg = StreamEvent(
        uuid="event-1",
        session_id="session-1",
        event={
            "type": "content_block_start",
            "content_block": {
                "type": "tool_use",
                "id": "Bash_0",
                "name": "Bash",
            },
        },
    )

    sent = await _handle_stream_event(msg, emitter, DummyStateManager())

    assert sent is False
    emitter.tool_start.assert_not_awaited()


@pytest.mark.asyncio
async def test_stream_thinking_delta_emits_reasoning_event():
    emitter = MagicMock()
    emitter.reasoning = AsyncMock()

    msg = StreamEvent(
        uuid="event-thinking-1",
        session_id="session-1",
        event={
            "type": "content_block_delta",
            "index": 0,
            "delta": {
                "type": "thinking_delta",
                "thinking": "目标",
            },
        },
    )

    sent = await _handle_stream_event(msg, emitter, DummyStateManager())

    assert sent is False
    emitter.reasoning.assert_awaited_once_with("目标")


@pytest.mark.asyncio
async def test_assistant_message_emits_tool_start_when_text_was_streamed():
    emitter = MagicMock()
    emitter.flush = AsyncMock()
    emitter.text_delta = AsyncMock()
    emitter.tool_start = AsyncMock()

    msg = AssistantMessage(
        content=[
            TextBlock(text="Already streamed"),
            ToolUseBlock(id="Bash_2", name="Bash", input={"command": "git status"}),
        ],
        model="claude-test",
    )

    await _handle_assistant_message(
        msg,
        emitter,
        DummyStateManager(),
        thinking_manager=None,
        stream_event_sent=True,
    )

    emitter.text_delta.assert_not_awaited()
    emitter.tool_start.assert_awaited_once_with(
        call_id="Bash_2",
        name="Bash",
        arguments={"command": "git status"},
    )


@pytest.mark.asyncio
async def test_assistant_message_emits_empty_tool_input_as_dict():
    emitter = MagicMock()
    emitter.flush = AsyncMock()
    emitter.text_delta = AsyncMock()
    emitter.tool_start = AsyncMock()

    msg = AssistantMessage(
        content=[
            ToolUseBlock(id="tool_write", name="Write", input={}),
        ],
        model="claude-test",
    )

    await _handle_assistant_message(
        msg,
        emitter,
        DummyStateManager(),
        thinking_manager=None,
        stream_event_sent=False,
    )

    emitter.tool_start.assert_awaited_once_with(
        call_id="tool_write",
        name="Write",
        arguments={},
    )


@pytest.mark.asyncio
async def test_cancelled_task_takes_precedence_over_error_result_message():
    task_id = 99101
    task_state_manager = TaskStateManager()
    task_state_manager.set_state(task_id, TaskState.CANCELLED)
    state_manager = DummyStateManager(task_id=task_id)
    emitter = MagicMock()

    message = ResultMessage(
        subtype="error_during_execution",
        duration_ms=1,
        duration_api_ms=1,
        is_error=True,
        num_turns=1,
        session_id="session-1",
        result="Request interrupted",
    )

    try:
        result = await _process_result_message(
            msg=message,
            emitter=emitter,
            state_manager=state_manager,
            task_state_manager=task_state_manager,
        )
    finally:
        task_state_manager.cleanup(task_id)

    assert result == TaskStatus.CANCELLED
    assert state_manager.statuses == [TaskStatus.CANCELLED.value]
