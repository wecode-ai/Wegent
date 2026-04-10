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
