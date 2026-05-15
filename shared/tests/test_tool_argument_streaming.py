# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for streaming tool argument events and UI-safe argument summaries."""

import pytest

from shared.models import EmitterBuilder, GeneratorTransport
from shared.utils.tool_arguments import sanitize_tool_arguments


def test_sanitize_tool_arguments_omits_large_write_content():
    args = {
        "file_path": "/home/user/report.md",
        "format": "text",
        "content": "x" * 5000,
    }

    sanitized = sanitize_tool_arguments("write_file", args, max_string_length=64)

    assert sanitized["file_path"] == "/home/user/report.md"
    assert sanitized["format"] == "text"
    assert sanitized["content"]["omitted"] is True
    assert sanitized["content"]["length"] == 5000
    assert sanitized["content"]["preview"] == "x" * 64
    assert sanitized["content"]["sha256"]
    assert "x" * 5000 not in str(sanitized)


@pytest.mark.asyncio
async def test_emitter_streams_tool_argument_lifecycle_with_sanitized_summary():
    transport = GeneratorTransport()
    emitter = EmitterBuilder().with_task(1, 2).with_transport(transport).build()

    await emitter.tool_argument_start(
        call_id="call_123",
        name="write_file",
        arguments_summary={"file_path": "/home/user/report.md"},
    )
    await emitter.tool_argument_delta(
        call_id="call_123",
        arguments_delta='{"content":"',
        arguments_summary={
            "file_path": "/home/user/report.md",
            "content": {"omitted": True, "length": 1024},
        },
    )
    await emitter.tool_argument_done(
        call_id="call_123",
        arguments_summary={
            "file_path": "/home/user/report.md",
            "content": {"omitted": True, "length": 2048},
        },
    )

    events = transport.get_events()

    assert [event_type for event_type, _ in events] == [
        "response.output_item.added",
        "response.function_call_arguments.delta",
        "response.function_call_arguments.done",
    ]
    assert events[0][1]["item"]["type"] == "function_call"
    assert events[0][1]["item"]["name"] == "write_file"
    assert events[0][1]["arguments_summary"]["file_path"] == "/home/user/report.md"
    assert events[1][1]["delta"] == '{"content":"'
    assert events[1][1]["arguments_summary"]["content"]["omitted"] is True
    assert events[2][1]["arguments_summary"]["content"]["length"] == 2048
    assert "output" not in events[2][1]
