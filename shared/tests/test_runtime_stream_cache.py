# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import MagicMock

import pytest

from shared.models import (
    CallbackTransport,
    RuntimeStreamAccumulator,
    runtime_stream_cache_capability,
)
from shared.models.responses_api import ResponsesAPIStreamEvents


def test_runtime_stream_accumulator_builds_snapshot():
    """Accumulator should preserve text, tools, context metrics, and terminal state."""

    accumulator = RuntimeStreamAccumulator(task_id=101, subtask_id=202)
    accumulator.apply_event(
        ResponsesAPIStreamEvents.OUTPUT_TEXT_DELTA.value,
        {"delta": "hello "},
    )
    accumulator.apply_event(
        ResponsesAPIStreamEvents.OUTPUT_ITEM_ADDED.value,
        {
            "item": {
                "type": "function_call",
                "call_id": "call-1",
                "name": "Bash",
                "arguments": '{"command": "pwd"}',
            }
        },
    )
    accumulator.apply_event(
        ResponsesAPIStreamEvents.OUTPUT_ITEM_DONE.value,
        {
            "item": {
                "type": "function_call",
                "call_id": "call-1",
                "name": "Bash",
                "arguments": '{"command": "pwd"}',
                "output": "/tmp",
                "status": "completed",
            }
        },
    )
    accumulator.apply_event(
        ResponsesAPIStreamEvents.OUTPUT_TEXT_DELTA.value,
        {"delta": "world"},
    )
    accumulator.apply_event(
        ResponsesAPIStreamEvents.STATUS_UPDATED.value,
        {"phase": "compacting", "context_metrics": {"usage": 0.8}},
    )
    accumulator.apply_event(ResponsesAPIStreamEvents.RESPONSE_COMPLETED.value, {})

    snapshot = accumulator.to_snapshot().to_dict()

    assert snapshot["content"] == "hello world"
    assert snapshot["offset"] == len("hello world")
    assert snapshot["terminal"] is True
    assert snapshot["context_metrics"]["phase"] == "compacting"
    assert [block["type"] for block in snapshot["blocks"]] == [
        "text",
        "tool",
        "text",
    ]
    assert snapshot["blocks"][1]["tool_output"] == "/tmp"
    assert all(block["status"] == "done" for block in snapshot["blocks"])


class _RuntimeCacheRecorder:
    def __init__(self):
        self.events = []

    async def record_event(self, **kwargs):
        self.events.append(kwargs)


@pytest.mark.asyncio
async def test_callback_transport_records_runtime_cache_and_sends_marker():
    """Callback transport should cache locally before sending the callback."""

    client = MagicMock()
    client.send_event_dict.return_value = {"status": "ok"}
    recorder = _RuntimeCacheRecorder()
    capability = runtime_stream_cache_capability()
    transport = CallbackTransport(
        client,
        runtime_cache=recorder,
        runtime_cache_capability=capability,
    )

    result = await transport.send(
        event_type=ResponsesAPIStreamEvents.OUTPUT_TEXT_DELTA.value,
        task_id=101,
        subtask_id=202,
        data={"delta": "hello"},
        executor_name="executor-1",
        executor_namespace="default",
    )

    assert result == {"status": "ok"}
    assert recorder.events == [
        {
            "event_type": ResponsesAPIStreamEvents.OUTPUT_TEXT_DELTA.value,
            "task_id": 101,
            "subtask_id": 202,
            "data": {"delta": "hello"},
        }
    ]
    sent_event = client.send_event_dict.call_args.args[0]
    assert sent_event["runtime_cache"] == capability
    assert sent_event["executor_name"] == "executor-1"
