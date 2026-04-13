# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for ChatOpenAIWithReasoning - reasoning_content extraction from streaming deltas.

Tests that the subclass correctly extracts reasoning_content from the raw API
delta and injects it into AIMessageChunk.additional_kwargs, while passing
through normal chunks unchanged.
"""

import pytest
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage, SystemMessage
from langchain_openai.chat_models.base import ChatGenerationChunk

from chat_shell.models.openai_reasoning import ChatOpenAIWithReasoning


@pytest.fixture
def model():
    """Create a ChatOpenAIWithReasoning instance for testing."""
    return ChatOpenAIWithReasoning(
        model="gpt-4",
        api_key="sk-test-key-1234567890",
    )


class TestConvertChunkToGenerationChunk:
    """Tests for _convert_chunk_to_generation_chunk override."""

    def test_extracts_reasoning_content(self, model):
        """reasoning_content in delta → injected into additional_kwargs."""
        chunk = {
            "id": "chatcmpl-1",
            "object": "chat.completion.chunk",
            "choices": [{
                "index": 0,
                "delta": {
                    "role": "assistant",
                    "content": "",
                    "reasoning_content": "Let me think about this...",
                },
                "finish_reason": None,
            }],
        }

        result = model._convert_chunk_to_generation_chunk(
            chunk, AIMessageChunk, None
        )

        assert result is not None
        assert isinstance(result, ChatGenerationChunk)
        assert isinstance(result.message, AIMessageChunk)
        assert result.message.additional_kwargs.get("reasoning_content") == \
            "Let me think about this..."

    def test_normal_chunk_without_reasoning(self, model):
        """Normal content chunk without reasoning_content → no extra kwargs."""
        chunk = {
            "id": "chatcmpl-2",
            "object": "chat.completion.chunk",
            "choices": [{
                "index": 0,
                "delta": {
                    "content": "Hello world",
                },
                "finish_reason": None,
            }],
        }

        result = model._convert_chunk_to_generation_chunk(
            chunk, AIMessageChunk, None
        )

        assert result is not None
        assert "reasoning_content" not in result.message.additional_kwargs

    def test_empty_choices_no_crash(self, model):
        """Chunk with empty choices list → no crash, reasoning not injected."""
        chunk = {
            "id": "chatcmpl-3",
            "object": "chat.completion.chunk",
            "choices": [],
        }

        # Parent may return None or a chunk - we just verify no exception
        result = model._convert_chunk_to_generation_chunk(
            chunk, AIMessageChunk, None
        )
        # If result is returned, verify no reasoning_content was added
        if result is not None:
            assert "reasoning_content" not in result.message.additional_kwargs

    def test_none_reasoning_content_ignored(self, model):
        """reasoning_content=None in delta → not injected into kwargs."""
        chunk = {
            "id": "chatcmpl-4",
            "object": "chat.completion.chunk",
            "choices": [{
                "index": 0,
                "delta": {
                    "content": "Hi",
                    "reasoning_content": None,
                },
                "finish_reason": None,
            }],
        }

        result = model._convert_chunk_to_generation_chunk(
            chunk, AIMessageChunk, None
        )

        assert result is not None
        # None value should NOT be injected
        assert "reasoning_content" not in result.message.additional_kwargs

    def test_empty_string_reasoning_content_ignored(self, model):
        """reasoning_content="" in delta → not injected (falsy)."""
        chunk = {
            "id": "chatcmpl-5",
            "object": "chat.completion.chunk",
            "choices": [{
                "index": 0,
                "delta": {
                    "content": "Hello",
                    "reasoning_content": "",
                },
                "finish_reason": None,
            }],
        }

        result = model._convert_chunk_to_generation_chunk(
            chunk, AIMessageChunk, None
        )

        assert result is not None
        # Empty string is falsy, should not be injected
        assert "reasoning_content" not in result.message.additional_kwargs


class TestGetRequestPayload:
    """Tests for _get_request_payload reasoning_content injection."""

    def test_injects_reasoning_content_into_assistant_messages(self, model):
        """reasoning_content in AIMessage.additional_kwargs → injected into payload."""
        messages = [
            SystemMessage(content="You are helpful"),
            HumanMessage(content="hello"),
            AIMessage(
                content="Let me help",
                additional_kwargs={"reasoning_content": "Thinking about this..."},
                tool_calls=[{
                    "id": "call_1",
                    "name": "search",
                    "args": {"q": "test"},
                }],
            ),
        ]

        payload = model._get_request_payload(messages)

        assert "messages" in payload
        # The assistant message at index 2 should have reasoning_content
        assistant_msg = payload["messages"][2]
        assert assistant_msg["role"] == "assistant"
        assert assistant_msg["reasoning_content"] == "Thinking about this..."

    def test_no_injection_when_no_reasoning(self, model):
        """AIMessage without reasoning_content → no reasoning_content in payload."""
        messages = [
            HumanMessage(content="hello"),
            AIMessage(content="Hi there!"),
        ]

        payload = model._get_request_payload(messages)

        assistant_msg = payload["messages"][1]
        assert assistant_msg["role"] == "assistant"
        assert "reasoning_content" not in assistant_msg

    def test_preserves_other_payload_fields(self, model):
        """Payload's model, temperature, etc. remain unchanged."""
        messages = [HumanMessage(content="test")]

        payload = model._get_request_payload(messages)

        assert payload.get("model") == "gpt-4"
        assert "messages" in payload
