# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for streamed tool argument tracking in Chat Shell."""

from unittest.mock import AsyncMock

import pytest

from chat_shell.tools.argument_stream import ToolCallStreamTracker


@pytest.mark.asyncio
async def test_tracker_emits_start_delta_and_done_with_sanitized_arguments():
    emitter = AsyncMock()
    tracker = ToolCallStreamTracker(emitter=emitter)

    await tracker.process_tool_call_chunks(
        [
            {
                "index": 0,
                "id": "call_123",
                "name": "write_file",
                "args": '{"file_path":"/tmp/report.md","content":"',
            }
        ]
    )
    await tracker.process_tool_call_chunks(
        [{"index": 0, "args": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}]
    )
    result = await tracker.finalize(
        call_id="call_123",
        tool_name="write_file",
        arguments={
            "file_path": "/tmp/report.md",
            "content": "x" * 5000,
        },
    )

    emitter.tool_argument_start.assert_awaited_once()
    emitter.tool_argument_delta.assert_awaited()
    emitter.tool_argument_done.assert_awaited_once()

    start_kwargs = emitter.tool_argument_start.await_args.kwargs
    assert start_kwargs["call_id"] == "call_123"
    assert start_kwargs["name"] == "write_file"

    done_kwargs = emitter.tool_argument_done.await_args.kwargs
    assert done_kwargs["call_id"] == "call_123"
    assert done_kwargs["arguments_summary"]["file_path"] == "/tmp/report.md"
    assert done_kwargs["arguments_summary"]["content"]["omitted"] is True
    assert "x" * 5000 not in str(done_kwargs)
    assert result.arguments_summary["content"]["length"] == 5000
    assert result.tool_use_id == "call_123"
    assert result.was_streamed is True


@pytest.mark.asyncio
async def test_tracker_aliases_index_only_stream_to_final_tool_call_id():
    emitter = AsyncMock()
    tracker = ToolCallStreamTracker(emitter=emitter)

    await tracker.process_tool_call_chunks(
        [{"index": 0, "name": "write_file", "args": '{"file_path":"/tmp/a.txt"'}]
    )
    result = await tracker.finalize(
        call_id="run_final",
        tool_name="write_file",
        arguments={"file_path": "/tmp/a.txt", "content": "hello"},
        stream_index=0,
    )

    start_kwargs = emitter.tool_argument_start.await_args.kwargs
    assert start_kwargs["call_id"] == "stream_index:0"

    done_kwargs = emitter.tool_argument_done.await_args.kwargs
    assert done_kwargs["call_id"] == "stream_index:0"
    assert result.tool_use_id == "stream_index:0"
    assert result.arguments_summary["content"]["omitted"] is True


@pytest.mark.asyncio
async def test_tracker_finalizes_parallel_same_name_tools_in_stream_order():
    emitter = AsyncMock()
    tracker = ToolCallStreamTracker(emitter=emitter)

    await tracker.process_tool_call_chunks(
        [
            {"index": 0, "name": "write_file", "args": '{"file_path":"/tmp/a.html"'},
            {"index": 1, "name": "write_file", "args": '{"file_path":"/tmp/b.html"'},
            {"index": 2, "name": "write_file", "args": '{"file_path":"/tmp/c.html"'},
        ]
    )

    first = await tracker.finalize(
        call_id="run_a",
        tool_name="write_file",
        arguments={"file_path": "/tmp/a.html", "content": "a"},
    )
    second = await tracker.finalize(
        call_id="run_b",
        tool_name="write_file",
        arguments={"file_path": "/tmp/b.html", "content": "b"},
    )
    third = await tracker.finalize(
        call_id="run_c",
        tool_name="write_file",
        arguments={"file_path": "/tmp/c.html", "content": "c"},
    )

    assert first.tool_use_id == "stream_index:0"
    assert second.tool_use_id == "stream_index:1"
    assert third.tool_use_id == "stream_index:2"
    assert [
        call.kwargs["call_id"] for call in emitter.tool_argument_done.await_args_list
    ] == [
        "stream_index:0",
        "stream_index:1",
        "stream_index:2",
    ]


@pytest.mark.asyncio
async def test_tracker_matches_parallel_same_name_tools_by_arguments_when_available():
    emitter = AsyncMock()
    tracker = ToolCallStreamTracker(emitter=emitter)

    await tracker.process_tool_call_chunks(
        [
            {
                "index": 0,
                "name": "write_file",
                "args": '{"file_path":"/tmp/a.html","content":"a"}',
            },
            {
                "index": 1,
                "name": "write_file",
                "args": '{"file_path":"/tmp/b.html","content":"b"}',
            },
            {
                "index": 2,
                "name": "write_file",
                "args": '{"file_path":"/tmp/c.html","content":"c"}',
            },
        ]
    )

    first_started = await tracker.finalize(
        call_id="run_b",
        tool_name="write_file",
        arguments={"file_path": "/tmp/b.html", "content": "b"},
    )

    assert first_started.tool_use_id == "stream_index:1"
