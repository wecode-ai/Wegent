# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for OpenAPI streaming service with reasoning support."""

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services.openapi.streaming import (
    OpenAPIStreamingService,
    StreamingChunk,
    _format_sse_event,
)


class TestStreamingChunk:
    """Tests for StreamingChunk dataclass."""

    def test_streaming_chunk_text(self):
        """Test creating a text StreamingChunk."""
        chunk = StreamingChunk(type="text", content="Hello world")
        assert chunk.type == "text"
        assert chunk.content == "Hello world"

    def test_streaming_chunk_reasoning(self):
        """Test creating a reasoning StreamingChunk."""
        chunk = StreamingChunk(type="reasoning", content="Let me think...")
        assert chunk.type == "reasoning"
        assert chunk.content == "Let me think..."


class TestStreamingServiceReasoning:
    """Tests for OpenAPIStreamingService with reasoning events."""

    @pytest.fixture
    def streaming_service(self):
        return OpenAPIStreamingService()

    @pytest.mark.asyncio
    async def test_text_only_stream(self, streaming_service):
        """Test streaming with text chunks only (backward compatibility)."""

        async def text_stream():
            yield "Hello"
            yield " world"

        events = []
        async for event in streaming_service.create_streaming_response(
            response_id="resp_123",
            model_string="gpt-4",
            chat_stream=text_stream(),
            created_at=1234567890,
        ):
            events.append(json.loads(event.replace("data: ", "").strip()))

        # Check that we have the expected events
        event_types = [e["type"] for e in events]
        assert "response.created" in event_types
        assert "response.in_progress" in event_types
        assert "response.output_text.delta" in event_types
        assert "response.completed" in event_types

        # Check text content
        text_deltas = [
            e["delta"] for e in events if e["type"] == "response.output_text.delta"
        ]
        assert "".join(text_deltas) == "Hello world"

    @pytest.mark.asyncio
    async def test_reasoning_stream(self, streaming_service):
        """Test streaming with reasoning chunks."""

        async def reasoning_stream():
            yield StreamingChunk(type="reasoning", content="Step 1: ")
            yield StreamingChunk(type="reasoning", content="Analyze the problem")
            yield StreamingChunk(type="text", content="The answer is 42")

        events = []
        async for event in streaming_service.create_streaming_response(
            response_id="resp_123",
            model_string="gpt-4",
            chat_stream=reasoning_stream(),
            created_at=1234567890,
        ):
            events.append(json.loads(event.replace("data: ", "").strip()))

        event_types = [e["type"] for e in events]

        # Check reasoning events
        assert "response.output_item.added" in event_types
        reasoning_deltas = [
            e for e in events if e["type"] == "response.reasoning_summary_text.delta"
        ]
        assert len(reasoning_deltas) == 2
        assert reasoning_deltas[0]["delta"] == "Step 1: "
        assert reasoning_deltas[1]["delta"] == "Analyze the problem"

        # Check text events
        text_deltas = [
            e["delta"] for e in events if e["type"] == "response.output_text.delta"
        ]
        assert "".join(text_deltas) == "The answer is 42"

    @pytest.mark.asyncio
    async def test_mixed_reasoning_and_text(self, streaming_service):
        """Test streaming with interleaved reasoning and text."""

        async def mixed_stream():
            yield StreamingChunk(type="reasoning", content="Thinking...")
            yield StreamingChunk(type="text", content="Answer")

        events = []
        async for event in streaming_service.create_streaming_response(
            response_id="resp_123",
            model_string="gpt-4",
            chat_stream=mixed_stream(),
            created_at=1234567890,
        ):
            events.append(json.loads(event.replace("data: ", "").strip()))

        event_types = [e["type"] for e in events]

        # Should have reasoning events first, then text events
        reasoning_indices = [
            i for i, e in enumerate(events) if "reasoning" in e["type"]
        ]
        text_indices = [
            i for i, e in enumerate(events) if e["type"] == "response.output_text.delta"
        ]

        assert reasoning_indices
        assert text_indices
        # All reasoning should come before text
        assert max(reasoning_indices) < min(text_indices)

    @pytest.mark.asyncio
    async def test_empty_stream(self, streaming_service):
        """Test streaming with empty content."""

        async def empty_stream():
            if False:
                yield "never"

        events = []
        async for event in streaming_service.create_streaming_response(
            response_id="resp_123",
            model_string="gpt-4",
            chat_stream=empty_stream(),
            created_at=1234567890,
        ):
            events.append(json.loads(event.replace("data: ", "").strip()))

        # Should still have lifecycle events
        event_types = [e["type"] for e in events]
        assert "response.created" in event_types
        assert "response.completed" in event_types

    @pytest.mark.asyncio
    async def test_reasoning_only_stream(self, streaming_service):
        """Test streaming with only reasoning, no text."""

        async def reasoning_only_stream():
            yield StreamingChunk(type="reasoning", content="Just thinking")

        events = []
        async for event in streaming_service.create_streaming_response(
            response_id="resp_123",
            model_string="gpt-4",
            chat_stream=reasoning_only_stream(),
            created_at=1234567890,
        ):
            events.append(json.loads(event.replace("data: ", "").strip()))

        # Should have reasoning events
        reasoning_deltas = [
            e for e in events if e["type"] == "response.reasoning_summary_text.delta"
        ]
        assert len(reasoning_deltas) == 1
        assert reasoning_deltas[0]["delta"] == "Just thinking"

        # Check final response includes reasoning
        completed_event = [e for e in events if e["type"] == "response.completed"][0]
        output = completed_event["response"]["output"]
        assert len(output) == 1
        assert output[0]["content"][0]["type"] == "reasoning"

    @pytest.mark.asyncio
    async def test_function_call_stream(self, streaming_service):
        async def function_call_stream():
            yield StreamingChunk(
                type="function_call_added",
                data={
                    "call_id": "call_123",
                    "name": "knowledge_base_search",
                    "arguments": '{"query": "timeout"}',
                    "output_index": 0,
                },
            )
            yield StreamingChunk(
                type="function_call_done",
                data={
                    "call_id": "call_123",
                    "name": "knowledge_base_search",
                    "arguments": '{"query": "timeout"}',
                    "output_index": 0,
                },
            )
            yield StreamingChunk(type="text", content="done")

        events = []
        async for event in streaming_service.create_streaming_response(
            response_id="resp_123",
            model_string="gpt-4",
            chat_stream=function_call_stream(),
            created_at=1234567890,
        ):
            events.append(json.loads(event.replace("data: ", "").strip()))

        event_types = [e["type"] for e in events]
        assert "response.output_item.added" in event_types
        assert "response.function_call_arguments.done" in event_types
        assert "response.output_item.done" in event_types
        assert "response.output_text.delta" in event_types

        function_added = next(
            e
            for e in events
            if e["type"] == "response.output_item.added"
            and e["item"]["type"] == "function_call"
        )
        assert function_added["item"]["name"] == "knowledge_base_search"

    @pytest.mark.asyncio
    async def test_mcp_call_stream(self, streaming_service):
        async def mcp_call_stream():
            yield StreamingChunk(
                type="mcp_call_added",
                data={
                    "item_id": "mcp_123",
                    "name": "search_docs",
                    "server_label": "wegent-knowledge",
                    "output_index": 0,
                },
            )
            yield StreamingChunk(
                type="mcp_call_done",
                data={
                    "item_id": "mcp_123",
                    "name": "search_docs",
                    "server_label": "wegent-knowledge",
                    "arguments": '{"query": "SSE timeout"}',
                    "output_index": 0,
                    "status": "completed",
                },
            )
            yield StreamingChunk(type="text", content="resolved")

        events = []
        async for event in streaming_service.create_streaming_response(
            response_id="resp_123",
            model_string="gpt-4",
            chat_stream=mcp_call_stream(),
            created_at=1234567890,
        ):
            events.append(json.loads(event.replace("data: ", "").strip()))

        event_types = [e["type"] for e in events]
        assert "response.mcp_call.in_progress" in event_types
        assert "response.mcp_call_arguments.done" in event_types
        assert "response.mcp_call.completed" in event_types

        mcp_added = next(
            e
            for e in events
            if e["type"] == "response.output_item.added"
            and e["item"]["type"] == "mcp_call"
        )
        assert mcp_added["item"]["server_label"] == "wegent-knowledge"

    @pytest.mark.asyncio
    async def test_shell_call_stream(self, streaming_service):
        async def shell_call_stream():
            yield StreamingChunk(
                type="shell_call_added",
                data={
                    "call_id": "shell_123",
                    "name": "exec",
                    "arguments": {"command": "ls -la", "timeout_seconds": 5},
                    "output_index": 0,
                },
            )
            yield StreamingChunk(
                type="shell_call_done",
                data={
                    "call_id": "shell_123",
                    "name": "exec",
                    "arguments": {"command": "ls -la", "timeout_seconds": 5},
                    "output_index": 0,
                    "status": "completed",
                },
            )
            yield StreamingChunk(type="text", content="done")

        events = []
        async for event in streaming_service.create_streaming_response(
            response_id="resp_123",
            model_string="gpt-4",
            chat_stream=shell_call_stream(),
            created_at=1234567890,
        ):
            events.append(json.loads(event.replace("data: ", "").strip()))

        event_types = [e["type"] for e in events]
        assert event_types.count("response.output_item.added") >= 1
        assert event_types.count("response.output_item.done") >= 1

        shell_added = next(
            e
            for e in events
            if e["type"] == "response.output_item.added"
            and e["item"]["type"] == "shell_call"
        )
        assert shell_added["item"]["action"]["commands"] == ["ls -la"]

        shell_done = next(
            e
            for e in events
            if e["type"] == "response.output_item.done"
            and e["item"]["type"] == "shell_call"
        )
        assert shell_done["item"]["status"] == "completed"

    @pytest.mark.asyncio
    async def test_task_context_extension(self, streaming_service):
        async def text_stream():
            yield StreamingChunk(type="text", content="hello")

        events = []
        async for event in streaming_service.create_streaming_response(
            response_id="resp_123",
            model_string="gpt-4",
            chat_stream=text_stream(),
            created_at=1234567890,
            task_context={"task_id": 123, "task_path": "/chat?task_id=123"},
        ):
            events.append(json.loads(event.replace("data: ", "").strip()))

        task_context = next(e for e in events if e["type"] == "response.task_context")
        assert task_context["task_id"] == 123
        assert task_context["task_path"] == "/chat?task_id=123"

    @pytest.mark.asyncio
    async def test_mixed_stream_output_indexes_are_unique(self, streaming_service):
        async def mixed_stream():
            yield StreamingChunk(type="reasoning", content="Thinking...")
            yield StreamingChunk(
                type="shell_call_added",
                data={
                    "call_id": "shell_123",
                    "name": "exec",
                    "arguments": {"command": "ls -la"},
                    "output_index": 0,
                },
            )
            yield StreamingChunk(
                type="shell_call_done",
                data={
                    "call_id": "shell_123",
                    "name": "exec",
                    "arguments": {"command": "ls -la"},
                    "output_index": 0,
                    "status": "completed",
                },
            )
            yield "done"

        events = []
        async for event in streaming_service.create_streaming_response(
            response_id="resp_123",
            model_string="gpt-4",
            chat_stream=mixed_stream(),
            created_at=1234567890,
        ):
            events.append(json.loads(event.replace("data: ", "").strip()))

        reasoning_event = next(
            e for e in events if e["type"] == "response.reasoning_summary_part.added"
        )
        shell_added = next(
            e
            for e in events
            if e["type"] == "response.output_item.added"
            and e["item"]["type"] == "shell_call"
        )
        message_added = next(
            e
            for e in events
            if e["type"] == "response.output_item.added"
            and e["item"]["type"] == "message"
        )

        indexes = {
            reasoning_event["output_index"],
            shell_added["output_index"],
            message_added["output_index"],
        }
        assert len(indexes) == 3
