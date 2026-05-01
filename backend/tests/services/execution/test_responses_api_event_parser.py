# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for fail-fast tool ID validation in Responses API event parsing."""

from unittest.mock import AsyncMock

import pytest

from app.services.execution.dispatcher import (
    InvalidToolCallEventError,
    ResponsesAPIEventParser,
)
from app.services.execution.inprocess_executor import EmitterBridgeTransport
from shared.models.responses_api import ResponsesAPIStreamEvents


class TestResponsesAPIEventParserToolIds:
    def test_tool_start_requires_non_empty_id(self):
        parser = ResponsesAPIEventParser()

        with pytest.raises(
            InvalidToolCallEventError,
            match=r"response\.output_item\.added\(function_call\)",
        ):
            parser.parse(
                task_id=1,
                subtask_id=2,
                message_id=3,
                event_type=ResponsesAPIStreamEvents.OUTPUT_ITEM_ADDED.value,
                data={
                    "item": {
                        "type": "function_call",
                        "id": "",
                        "name": "search",
                        "arguments": "{}",
                    }
                },
            )

    def test_tool_result_requires_non_empty_id(self):
        parser = ResponsesAPIEventParser()

        with pytest.raises(
            InvalidToolCallEventError,
            match="function_call_arguments.done",
        ):
            parser.parse(
                task_id=1,
                subtask_id=2,
                message_id=3,
                event_type=ResponsesAPIStreamEvents.FUNCTION_CALL_ARGUMENTS_DONE.value,
                data={"call_id": "", "output": "done"},
            )

    def test_tool_result_parses_arguments_as_tool_input(self):
        """Test that function_call_arguments.done event parses arguments as tool_input."""
        parser = ResponsesAPIEventParser()

        result = parser.parse(
            task_id=1,
            subtask_id=2,
            message_id=3,
            event_type=ResponsesAPIStreamEvents.FUNCTION_CALL_ARGUMENTS_DONE.value,
            data={
                "call_id": "tool_123",
                "arguments": '{"path": "/test/file.py", "content": "hello"}',
                "output": "File created successfully",
            },
        )

        assert result is not None
        assert result.tool_use_id == "tool_123"
        assert result.tool_output == "File created successfully"
        assert result.tool_input == {"path": "/test/file.py", "content": "hello"}

    def test_tool_result_with_empty_arguments(self):
        """Test that function_call_arguments.done event handles empty arguments."""
        parser = ResponsesAPIEventParser()

        result = parser.parse(
            task_id=1,
            subtask_id=2,
            message_id=3,
            event_type=ResponsesAPIStreamEvents.FUNCTION_CALL_ARGUMENTS_DONE.value,
            data={
                "call_id": "tool_456",
                "arguments": "",
                "output": "Success",
            },
        )

        assert result is not None
        assert result.tool_use_id == "tool_456"
        assert result.tool_output == "Success"
        assert result.tool_input is None

    def test_tool_result_without_arguments(self):
        """Test that function_call_arguments.done event handles missing arguments."""
        parser = ResponsesAPIEventParser()

        result = parser.parse(
            task_id=1,
            subtask_id=2,
            message_id=3,
            event_type=ResponsesAPIStreamEvents.FUNCTION_CALL_ARGUMENTS_DONE.value,
            data={
                "call_id": "tool_789",
                "output": "Done",
            },
        )

        assert result is not None
        assert result.tool_use_id == "tool_789"
        assert result.tool_output == "Done"
        assert result.tool_input is None

    def test_mcp_tool_start_and_completion(self):
        parser = ResponsesAPIEventParser()

        start = parser.parse(
            task_id=1,
            subtask_id=2,
            message_id=3,
            event_type=ResponsesAPIStreamEvents.OUTPUT_ITEM_ADDED.value,
            data={
                "item": {
                    "type": "mcp_call",
                    "id": "mcp_123",
                    "name": "search_docs",
                    "server_label": "wegent-knowledge",
                }
            },
        )
        assert start is not None
        assert start.type == "tool_start"
        assert start.tool_use_id == "mcp_123"
        assert start.tool_name == "search_docs"
        assert start.data["tool_protocol"] == "mcp"
        assert start.data["server_label"] == "wegent-knowledge"

        args_done = parser.parse(
            task_id=1,
            subtask_id=2,
            message_id=3,
            event_type=ResponsesAPIStreamEvents.MCP_CALL_ARGUMENTS_DONE.value,
            data={
                "item_id": "mcp_123",
                "arguments": '{"query": "SSE timeout"}',
            },
        )
        assert args_done is not None
        assert args_done.type == "tool"
        assert args_done.tool_use_id == "mcp_123"
        assert args_done.tool_input == {"query": "SSE timeout"}

        done = parser.parse(
            task_id=1,
            subtask_id=2,
            message_id=3,
            event_type=ResponsesAPIStreamEvents.MCP_CALL_COMPLETED.value,
            data={"item_id": "mcp_123"},
        )
        assert done is not None
        assert done.type == "tool_result"
        assert done.tool_use_id == "mcp_123"
        assert done.tool_name == "search_docs"
        assert done.tool_input == {"query": "SSE timeout"}
        assert done.data["tool_protocol"] == "mcp"
        assert done.data["status"] == "completed"

    def test_mcp_tool_failed_carries_error(self):
        parser = ResponsesAPIEventParser()

        parser.parse(
            task_id=1,
            subtask_id=2,
            message_id=3,
            event_type=ResponsesAPIStreamEvents.OUTPUT_ITEM_ADDED.value,
            data={
                "item": {
                    "type": "mcp_call",
                    "id": "mcp_456",
                    "name": "search_docs",
                    "server_label": "wegent-knowledge",
                }
            },
        )

        failed = parser.parse(
            task_id=1,
            subtask_id=2,
            message_id=3,
            event_type=ResponsesAPIStreamEvents.MCP_CALL_FAILED.value,
            data={"item_id": "mcp_456", "error": "timeout"},
        )

        assert failed is not None
        assert failed.type == "tool_result"
        assert failed.data["tool_protocol"] == "mcp"
        assert failed.data["status"] == "failed"
        assert failed.data["error"] == "timeout"

    def test_inprocess_bridge_reuses_same_fail_fast_validation(self):
        transport = EmitterBridgeTransport(
            emitter=AsyncMock(),
            task_id=1,
            subtask_id=2,
            message_id=3,
        )

        with pytest.raises(
            InvalidToolCallEventError,
            match=r"response\.output_item\.added\(function_call\)",
        ):
            transport._convert_event(
                ResponsesAPIStreamEvents.OUTPUT_ITEM_ADDED.value,
                {
                    "item": {
                        "type": "function_call",
                        "id": "",
                        "name": "search",
                        "arguments": "{}",
                    }
                },
                message_id=3,
            )
