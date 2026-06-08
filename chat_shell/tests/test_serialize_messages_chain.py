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
        """Reasoning content from DeepSeek R1 models is bridged to canonical blocks."""
        msg = AIMessage(
            content="Final answer",
            additional_kwargs={"reasoning_content": "I think therefore I am"},
        )
        result = _serialize_messages_chain([msg])
        assert len(result) == 1
        # reasoning_content is now stored as a canonical reasoning block
        assert result[0]["content"] == [
            {"type": "reasoning", "reasoning": "I think therefore I am"},
            {"type": "text", "text": "Final answer"},
        ]
        # No longer in additional_kwargs
        assert "additional_kwargs" not in result[0]

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
        """AIMessage with list content (e.g. text blocks) is preserved."""
        msg = AIMessage(content=[{"type": "text", "text": "hello"}])
        result = _serialize_messages_chain([msg])
        assert result[0]["content"] == [{"type": "text", "text": "hello"}]

    def test_claude_thinking_blocks_normalized(self):
        """Claude thinking blocks are converted to canonical reasoning format."""
        msg = AIMessage(
            content=[
                {
                    "type": "thinking",
                    "thinking": "Let me reason...",
                    "signature": "abc123",
                },
                {"type": "text", "text": "The answer is 42"},
            ]
        )
        result = _serialize_messages_chain([msg])
        content = result[0]["content"]
        assert len(content) == 2
        assert content[0] == {
            "type": "reasoning",
            "reasoning": "Let me reason...",
            "extras": {"signature": "abc123"},
        }
        assert content[1] == {"type": "text", "text": "The answer is 42"}

    def test_openai_responses_reasoning_exploded(self):
        """OpenAI Responses API reasoning blocks with summary are exploded."""
        msg = AIMessage(
            content=[
                {
                    "type": "reasoning",
                    "summary": [
                        {"type": "summary_text", "text": "Step 1"},
                        {"type": "summary_text", "text": "Step 2"},
                    ],
                    "id": "rs_abc",
                },
                {"type": "text", "text": "Done"},
            ]
        )
        result = _serialize_messages_chain([msg])
        content = result[0]["content"]
        assert len(content) == 3
        assert content[0]["type"] == "reasoning"
        assert content[0]["reasoning"] == "Step 1"
        assert content[0]["extras"] == {"id": "rs_abc"}
        assert content[1]["type"] == "reasoning"
        assert content[1]["reasoning"] == "Step 2"
        assert content[2] == {"type": "text", "text": "Done"}

    def test_openai_responses_reasoning_empty_summary_preserves_extras(self):
        """OpenAI Responses API reasoning blocks with empty summary preserve id/encrypted_content."""
        msg = AIMessage(
            content=[
                {
                    "type": "reasoning",
                    "summary": [],
                    "id": "rs_abc",
                    "encrypted_content": "gAAAA_data",
                },
                {"type": "text", "text": "Answer"},
            ]
        )
        result = _serialize_messages_chain([msg])
        content = result[0]["content"]
        assert len(content) == 2
        reasoning = content[0]
        assert reasoning["type"] == "reasoning"
        assert reasoning["reasoning"] == ""
        assert reasoning["extras"]["id"] == "rs_abc"
        assert reasoning["extras"]["encrypted_content"] == "gAAAA_data"

    def test_model_info_added_when_provider_given(self):
        """model_info is added to each assistant entry when provider is passed."""
        msg = AIMessage(content="Hello")
        result = _serialize_messages_chain(
            [msg], provider="anthropic", model_id="claude-sonnet-4-20250514"
        )
        assert result[0]["model_info"] == {
            "provider": "anthropic",
            "model": "claude-sonnet-4-20250514",
        }

    def test_model_info_absent_when_no_provider(self):
        """model_info is omitted when provider is not given (backward compat)."""
        msg = AIMessage(content="Hello")
        result = _serialize_messages_chain([msg])
        assert "model_info" not in result[0]

    def test_reasoning_content_only_no_text(self):
        """AIMessage with only reasoning_content and empty content."""
        msg = AIMessage(
            content="",
            additional_kwargs={"reasoning_content": "thinking..."},
        )
        result = _serialize_messages_chain([msg])
        assert result[0]["content"] == [
            {"type": "reasoning", "reasoning": "thinking..."},
        ]
