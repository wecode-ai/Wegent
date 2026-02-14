# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for Chat Shell adapters in Backend.

NOTE: HTTPAdapter, ChatProxy, and backward compatibility aliases have been removed.
Use ExecutionDispatcher from app.services.execution for task dispatch.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from shared.models import EventType, ExecutionEvent, ExecutionRequest


class TestExecutionRequest:
    """Tests for ExecutionRequest (formerly ChatRequest)."""

    def test_execution_request_to_dict(self):
        """Test ExecutionRequest serialization to dict."""
        request = ExecutionRequest(
            task_id=1,
            subtask_id=2,
            prompt="Hello",
            user_id=3,
            user_name="test_user",
            team_id=4,
            team_name="Test Team",
            enable_tools=True,
            enable_web_search=False,
        )

        data = request.to_dict()
        assert data["task_id"] == 1
        assert data["subtask_id"] == 2
        assert data["prompt"] == "Hello"
        assert data["user_id"] == 3
        assert data["team_id"] == 4
        assert data["enable_tools"] is True
        assert data["enable_web_search"] is False


class TestExecutionEvent:
    """Tests for ExecutionEvent (formerly ChatEvent)."""

    def test_execution_event_from_dict(self):
        """Test creating ExecutionEvent from dict."""
        data = {
            "type": "chunk",
            "content": "Hello",
            "offset": 0,
            "subtask_id": 1,
            "task_id": 1,
        }

        event = ExecutionEvent.from_dict(data)
        assert event.type == EventType.CHUNK.value
        assert event.content == "Hello"
        assert event.offset == 0

    def test_execution_event_from_dict_unknown_type(self):
        """Test ExecutionEvent with unknown type defaults to CHUNK."""
        data = {
            "type": "unknown_type",
            "content": "test",
            "task_id": 1,
            "subtask_id": 1,
        }

        event = ExecutionEvent.from_dict(data)
        # Unknown types default to "chunk" in from_dict
        assert event.type == "chunk"


class TestSSEToWebSocketConverter:
    """Tests for SSE to WebSocket converter."""

    @pytest.fixture
    def converter(self):
        """Create converter instance."""
        from app.services.chat.adapters.converter import SSEToWebSocketConverter

        return SSEToWebSocketConverter(task_id=1, task_room="task:1")

    @pytest.mark.asyncio
    async def test_convert_start_event(self, converter):
        """Test converting START event."""
        mock_emitter = MagicMock()
        mock_emitter.emit_chat_start = AsyncMock()

        with patch(
            "app.services.chat.ws_emitter.get_ws_emitter",
            return_value=mock_emitter,
        ):
            event = ExecutionEvent(
                type=EventType.START.value,
                task_id=1,
                subtask_id=1,
                data={"shell_type": "Chat"},
            )

            await converter.convert_and_emit(event)

            mock_emitter.emit_chat_start.assert_called_once()

    @pytest.mark.asyncio
    async def test_convert_chunk_event(self, converter):
        """Test converting CHUNK event."""
        mock_emitter = MagicMock()
        mock_emitter.emit_chat_chunk = AsyncMock()

        with patch(
            "app.services.chat.ws_emitter.get_ws_emitter",
            return_value=mock_emitter,
        ):
            event = ExecutionEvent(
                type=EventType.CHUNK.value,
                task_id=1,
                subtask_id=1,
                content="Hello",
                offset=0,
            )

            await converter.convert_and_emit(event)

            mock_emitter.emit_chat_chunk.assert_called_once()

    @pytest.mark.asyncio
    async def test_convert_done_event(self, converter):
        """Test converting DONE event."""
        mock_emitter = MagicMock()
        mock_emitter.emit_chat_done = AsyncMock()

        with patch(
            "app.services.chat.ws_emitter.get_ws_emitter",
            return_value=mock_emitter,
        ):
            event = ExecutionEvent(
                type=EventType.DONE.value,
                task_id=1,
                subtask_id=1,
                offset=5,
                result={"value": "Hello"},
                message_id=100,
            )

            await converter.convert_and_emit(event)

            mock_emitter.emit_chat_done.assert_called_once()

    @pytest.mark.asyncio
    async def test_convert_error_event(self, converter):
        """Test converting ERROR event."""
        mock_emitter = MagicMock()
        mock_emitter.emit_chat_error = AsyncMock()

        with patch(
            "app.services.chat.ws_emitter.get_ws_emitter",
            return_value=mock_emitter,
        ):
            event = ExecutionEvent(
                type=EventType.ERROR.value,
                task_id=1,
                subtask_id=1,
                error="Test error",
            )

            await converter.convert_and_emit(event)

            mock_emitter.emit_chat_error.assert_called_once()
