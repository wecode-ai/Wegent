from unittest.mock import AsyncMock, MagicMock

import pytest
from claude_agent_sdk.types import (
    AssistantMessage,
    StreamEvent,
    TextBlock,
    ToolUseBlock,
)

from executor.agents.claude_code.response_processor import (
    _handle_assistant_message,
    _handle_stream_event,
)


class DummyStateManager:
    def update_workbench_summary(self, *_args, **_kwargs):
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
