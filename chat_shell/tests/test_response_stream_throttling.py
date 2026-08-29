# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for Chat Shell Responses API stream compaction."""

import asyncio
from typing import Any

import pytest

from chat_shell.api.v1.response import (
    SSETransport,
    _cancel_chat_task,
    _create_sse_emitter,
    _drain_sse_transport,
)
from chat_shell.tools.events import create_tool_event_handler


@pytest.mark.asyncio
async def test_tool_argument_deltas_flush_before_full_completion() -> None:
    """Tool deltas stay lossless while completion carries the full result once."""
    transport = SSETransport()
    emitter = _create_sse_emitter(
        task_id=1,
        subtask_id=2,
        model="test-model",
        transport=transport,
    )
    content = "".join(chr(ord("a") + index % 26) for index in range(100_000))
    chunks = [content[index : index + 101] for index in range(0, len(content), 101)]

    await emitter.tool_argument_start(
        call_id="call_write",
        name="write_file",
        arguments_summary={"file_path": "/tmp/report.md"},
    )
    emitted_length = 0
    for chunk in chunks:
        emitted_length += len(chunk)
        await emitter.tool_argument_delta(
            call_id="call_write",
            arguments_delta=chunk,
            arguments_summary={
                "file_path": "/tmp/report.md",
                "content": {"omitted": True, "length": emitted_length},
            },
        )
    await emitter.tool_argument_done(
        call_id="call_write",
        arguments_summary={
            "file_path": "/tmp/report.md",
            "content": {"omitted": True, "length": len(content)},
        },
    )
    await emitter.done(content="final answer")

    events = []
    while not transport._queue.empty():
        event = await transport.get_event()
        assert event is not None
        events.append(event)

    event_types = [event_type for event_type, _ in events]
    delta_payloads = [
        data
        for event_type, data in events
        if event_type == "response.function_call_arguments.delta"
    ]
    done_payloads = [
        data
        for event_type, data in events
        if event_type == "response.function_call_arguments.done"
    ]
    completed_payloads = [
        data for event_type, data in events if event_type == "response.completed"
    ]

    assert "".join(payload["delta"] for payload in delta_payloads) == content
    assert len(delta_payloads) < len(chunks) // 10
    assert len(done_payloads) == 1
    assert done_payloads[0]["arguments_summary"]["content"]["length"] == len(content)
    assert len(completed_payloads) == 1
    assert completed_payloads[0]["response"]["output"][0]["content"][0]["text"] == (
        "final answer"
    )
    assert event_types.index(
        "response.function_call_arguments.done"
    ) < event_types.index("response.completed")
    assert event_types[-1] == "response.completed"


@pytest.mark.asyncio
async def test_cancelled_stream_drains_buffered_arguments_before_incomplete() -> None:
    """Cancellation emits pending tool arguments before the terminal event."""
    transport = SSETransport()
    emitter = _create_sse_emitter(
        task_id=1,
        subtask_id=2,
        model="test-model",
        transport=transport,
    )

    await emitter.tool_argument_start(
        call_id="call_write",
        name="write_file",
        arguments_summary={"file_path": "/tmp/report.md"},
    )
    await emitter.tool_argument_delta(
        call_id="call_write",
        arguments_delta="already-sent",
    )
    async for _ in _drain_sse_transport(transport):
        pass

    await emitter.tool_argument_delta(
        call_id="call_write",
        arguments_delta="buffered-before-cancel",
    )
    await emitter.incomplete("cancelled")
    events = [event async for event in _drain_sse_transport(transport)]

    assert [event_type for event_type, _ in events] == [
        "response.function_call_arguments.delta",
        "response.incomplete",
    ]
    assert events[0][1]["delta"] == "buffered-before-cancel"


@pytest.mark.asyncio
async def test_cancelled_stream_waits_for_late_tool_event_tasks() -> None:
    """Cancellation waits for detached tool events before closing the stream."""
    transport = SSETransport()
    emitter = _create_sse_emitter(
        task_id=1,
        subtask_id=2,
        model="test-model",
        transport=transport,
    )
    original_delta = emitter.tool_argument_delta

    async def delayed_delta(**kwargs: Any) -> None:
        await asyncio.sleep(0.2)
        await original_delta(**kwargs)

    emitter.tool_argument_delta = delayed_delta
    handler = create_tool_event_handler(object(), emitter, object())
    producer_started = asyncio.Event()

    async def produce_tool_event() -> None:
        try:
            handler(
                "tool_argument_delta",
                {
                    "call_id": "call-1",
                    "arguments_delta": "late-before-cancel",
                },
            )
            producer_started.set()
            await asyncio.Event().wait()
        finally:
            await handler.wait_pending()

    chat_task = asyncio.create_task(produce_tool_event())
    await producer_started.wait()
    await _cancel_chat_task(chat_task)
    await emitter.incomplete("cancelled")
    events = [event async for event in _drain_sse_transport(transport)]

    assert [event_type for event_type, _ in events] == [
        "response.function_call_arguments.delta",
        "response.incomplete",
    ]
    assert events[0][1]["delta"] == "late-before-cancel"
