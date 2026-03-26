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
