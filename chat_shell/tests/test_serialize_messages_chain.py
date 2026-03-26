# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for _serialize_messages_chain in graph_builder module."""

import json

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from chat_shell.agents.graph_builder import (
    InvalidToolMessageSequenceError,
    _serialize_messages_chain,
    _validate_tool_message_sequence,
)


class TestSerializeMessagesChain:
    """Tests for the _serialize_messages_chain helper function."""

    def test_empty_messages(self):
        """Empty input returns empty list."""
        assert _serialize_messages_chain([]) == []

    def test_ai_message_text_only(self):
        """Simple AIMessage with text content."""
        messages = [AIMessage(content="Hello world")]
        result = _serialize_messages_chain(messages)
        assert len(result) == 1
        assert result[0] == {"role": "assistant", "content": "Hello world"}

    def test_ai_message_with_tool_calls(self):
        """AIMessage with tool_calls is serialized with OpenAI function format."""
        msg = AIMessage(
            content="",
            tool_calls=[
                {
                    "id": "call_abc",
                    "name": "search",
                    "args": {"query": "test"},
                }
            ],
        )
        result = _serialize_messages_chain([msg])
        assert len(result) == 1
        entry = result[0]
        assert entry["role"] == "assistant"
        assert len(entry["tool_calls"]) == 1
        tc = entry["tool_calls"][0]
        assert tc["id"] == "call_abc"
        assert tc["type"] == "function"
        assert tc["function"]["name"] == "search"
        assert json.loads(tc["function"]["arguments"]) == {"query": "test"}

    def test_ai_message_with_empty_args(self):
        """Tool call with empty args dict serializes to '{}'."""
        msg = AIMessage(
            content="",
            tool_calls=[
                {
                    "id": "call_1",
                    "name": "run",
                    "args": {},
                }
            ],
        )
        result = _serialize_messages_chain([msg])
        tc = result[0]["tool_calls"][0]
        assert tc["function"]["arguments"] == "{}"

    def test_ai_message_with_reasoning_content(self):
        """Reasoning content from DeepSeek R1 models is preserved."""
        msg = AIMessage(
            content="Final answer",
            additional_kwargs={"reasoning_content": "I think therefore I am"},
        )
        result = _serialize_messages_chain([msg])
        assert len(result) == 1
        assert result[0]["content"] == "Final answer"
        assert (
            result[0]["additional_kwargs"]["reasoning_content"]
            == "I think therefore I am"
        )

    def test_tool_message_string_content(self):
        """ToolMessage with string content."""
        msg = ToolMessage(content="Tool output", tool_call_id="call_abc", name="search")
        result = _serialize_messages_chain([msg])
        assert len(result) == 1
        assert result[0] == {
            "role": "tool",
            "content": "Tool output",
            "tool_call_id": "call_abc",
            "name": "search",
        }

    def test_tool_message_dict_content(self):
        """ToolMessage with non-string content is JSON-serialized."""
        msg = ToolMessage(
            content='{"result": [1, 2, 3]}',
            tool_call_id="call_xyz",
            name="compute",
        )
        result = _serialize_messages_chain([msg])
        # String content is preserved as-is
        assert result[0]["content"] == '{"result": [1, 2, 3]}'

    def test_tool_message_without_name(self):
        """ToolMessage without name omits the name field."""
        msg = ToolMessage(content="ok", tool_call_id="call_1")
        result = _serialize_messages_chain([msg])
        assert "name" not in result[0]

    def test_tool_message_empty_tool_call_id_raises(self):
        """ToolMessage with empty tool_call_id fails fast."""
        msg = ToolMessage(content="ok", tool_call_id="")
        with pytest.raises(InvalidToolMessageSequenceError, match="non-empty string"):
            _serialize_messages_chain([msg])

    def test_ai_message_missing_tool_call_id_raises(self):
        """Assistant tool calls without IDs fail fast during serialization."""
        msg = AIMessage(
            content="",
            tool_calls=[{"id": "", "name": "search", "args": {"q": "test"}}],
        )

        with pytest.raises(InvalidToolMessageSequenceError, match="non-empty string"):
            _serialize_messages_chain([msg])

    def test_validate_tool_message_sequence_rejects_unknown_tool_result(self):
        """Tool results referencing unknown IDs are rejected before provider adaptation."""
        messages = [
            {"role": "assistant", "content": "no tools here"},
            {"role": "tool", "content": "orphaned", "tool_call_id": "call_1"},
        ]

        with pytest.raises(
            InvalidToolMessageSequenceError, match="unknown tool_call_id"
        ):
            _validate_tool_message_sequence(
                messages,
                context="test input messages",
            )

    def test_full_turn_sequence(self):
        """A complete tool-use turn: AI(tool_call) → Tool(result) → AI(final)."""
        messages = [
            AIMessage(
                content="",
                tool_calls=[{"id": "call_1", "name": "search", "args": {"q": "hi"}}],
            ),
            ToolMessage(content="Found it", tool_call_id="call_1", name="search"),
            AIMessage(content="Here is your answer."),
        ]
        result = _serialize_messages_chain(messages)
        assert len(result) == 3
        assert result[0]["role"] == "assistant"
        assert result[0]["tool_calls"][0]["function"]["name"] == "search"
        assert result[1]["role"] == "tool"
        assert result[1]["content"] == "Found it"
        assert result[2]["role"] == "assistant"
        assert result[2]["content"] == "Here is your answer."

    def test_human_messages_are_skipped(self):
        """HumanMessage and other non-AI/Tool messages are not included."""
        messages = [
            HumanMessage(content="User question"),
            AIMessage(content="Response"),
        ]
        result = _serialize_messages_chain(messages)
        assert len(result) == 1
        assert result[0]["role"] == "assistant"

    def test_ai_message_list_content(self):
        """AIMessage with list content (e.g. Claude thinking blocks)."""
        msg = AIMessage(content=[{"type": "text", "text": "hello"}])
        result = _serialize_messages_chain([msg])
        assert result[0]["content"] == [{"type": "text", "text": "hello"}]
