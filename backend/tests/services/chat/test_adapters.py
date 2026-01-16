# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for Chat Shell adapters in Backend."""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


class TestChatRequest:
    """Tests for ChatRequest interface."""

    def test_chat_request_to_dict(self):
        """Test ChatRequest serialization to dict."""
        from app.services.chat.adapters.interface import ChatRequest

        request = ChatRequest(
            task_id=1,
            subtask_id=2,
            message="Hello",
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
        assert data["message"] == "Hello"
        assert data["user_id"] == 3
        assert data["team_id"] == 4
        assert data["enable_tools"] is True
        assert data["enable_web_search"] is False


class TestChatEvent:
    """Tests for ChatEvent interface."""

    def test_chat_event_from_sse_data(self):
        """Test creating ChatEvent from SSE data."""
        from app.services.chat.adapters.interface import ChatEvent, ChatEventType

        data = {
            "type": "chunk",
            "content": "Hello",
            "offset": 0,
            "subtask_id": 1,
        }

        event = ChatEvent.from_sse_data(data.copy())
        assert event.type == ChatEventType.CHUNK
        assert event.data["content"] == "Hello"
        assert event.data["offset"] == 0

    def test_chat_event_from_sse_data_unknown_type(self):
        """Test ChatEvent with unknown type defaults to CHUNK."""
        from app.services.chat.adapters.interface import ChatEvent, ChatEventType

        data = {
            "type": "unknown_type",
            "content": "test",
        }

        event = ChatEvent.from_sse_data(data.copy())
        assert event.type == ChatEventType.CHUNK


class TestHTTPAdapter:
    """Tests for HTTP adapter."""

    @pytest.fixture
    def adapter(self):
        """Create HTTP adapter."""
        from app.services.chat.adapters.http import HTTPAdapter

        return HTTPAdapter(
            base_url="http://localhost:8002",
            token="test-token",
        )

    def test_get_headers(self, adapter):
        """Test getting HTTP headers."""
        headers = adapter._get_headers()
        assert headers["Content-Type"] == "application/json"
        assert headers["Accept"] == "text/event-stream"
        assert headers["Authorization"] == "Bearer test-token"

    def test_parse_sse_line_valid(self, adapter):
        """Test parsing valid SSE line."""
        # First set the event type via event: line
        adapter._parse_sse_line("event: content.delta")
        # Then parse data line with text field (chat_shell SSE format)
        line = 'data: {"text": "Hello"}'
        event = adapter._parse_sse_line(line)

        assert event is not None
        assert event.data["content"] == "Hello"

    def test_parse_sse_line_done_marker(self, adapter):
        """Test parsing [DONE] marker."""
        line = "data: [DONE]"
        event = adapter._parse_sse_line(line)
        assert event is None

    def test_parse_sse_line_empty(self, adapter):
        """Test parsing empty line."""
        event = adapter._parse_sse_line("")
        assert event is None

    def test_parse_sse_line_invalid_json(self, adapter):
        """Test parsing invalid JSON."""
        line = "data: not-json"
        event = adapter._parse_sse_line(line)
        assert event is None


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
        from unittest.mock import AsyncMock, MagicMock, patch

        from app.services.chat.adapters.interface import ChatEvent, ChatEventType

        mock_emitter = MagicMock()
        mock_emitter.emit_chat_start = AsyncMock()

        with patch(
            "app.services.chat.ws_emitter.get_ws_emitter",
            return_value=mock_emitter,
        ):
            event = ChatEvent(
                type=ChatEventType.START,
                data={"subtask_id": 1, "shell_type": "Chat"},
            )

            await converter.convert_and_emit(event)

            mock_emitter.emit_chat_start.assert_called_once()

    @pytest.mark.asyncio
    async def test_convert_chunk_event(self, converter):
        """Test converting CHUNK event."""
        from unittest.mock import AsyncMock, MagicMock, patch

        from app.services.chat.adapters.interface import ChatEvent, ChatEventType

        mock_emitter = MagicMock()
        mock_emitter.emit_chat_chunk = AsyncMock()

        with patch(
            "app.services.chat.ws_emitter.get_ws_emitter",
            return_value=mock_emitter,
        ):
            event = ChatEvent(
                type=ChatEventType.CHUNK,
                data={"content": "Hello", "offset": 0, "subtask_id": 1},
            )

            await converter.convert_and_emit(event)

            mock_emitter.emit_chat_chunk.assert_called_once()

    @pytest.mark.asyncio
    async def test_convert_done_event(self, converter):
        """Test converting DONE event."""
        from unittest.mock import AsyncMock, MagicMock, patch

        from app.services.chat.adapters.interface import ChatEvent, ChatEventType

        mock_emitter = MagicMock()
        mock_emitter.emit_chat_done = AsyncMock()

        with patch(
            "app.services.chat.ws_emitter.get_ws_emitter",
            return_value=mock_emitter,
        ):
            event = ChatEvent(
                type=ChatEventType.DONE,
                data={
                    "subtask_id": 1,
                    "offset": 5,
                    "result": {"value": "Hello"},
                    "message_id": 100,
                },
            )

            await converter.convert_and_emit(event)

            mock_emitter.emit_chat_done.assert_called_once()

    @pytest.mark.asyncio
    async def test_convert_error_event(self, converter):
        """Test converting ERROR event."""
        from unittest.mock import AsyncMock, MagicMock, patch

        from app.services.chat.adapters.interface import ChatEvent, ChatEventType

        mock_emitter = MagicMock()
        mock_emitter.emit_chat_error = AsyncMock()

        with patch(
            "app.services.chat.ws_emitter.get_ws_emitter",
            return_value=mock_emitter,
        ):
            event = ChatEvent(
                type=ChatEventType.ERROR,
                data={"subtask_id": 1, "error": "Test error"},
            )

            await converter.convert_and_emit(event)

            mock_emitter.emit_chat_error.assert_called_once()


class TestChatProxy:
    """Tests for ChatProxy."""

    @pytest.mark.asyncio
    @patch("app.services.chat.adapters.proxy.settings")
    async def test_proxy_uses_http_adapter(self, mock_settings):
        """Test proxy uses HTTP adapter in HTTP mode."""
        mock_settings.CHAT_SHELL_MODE = "http"
        mock_settings.CHAT_SHELL_URL = "http://localhost:8002"
        mock_settings.INTERNAL_SERVICE_TOKEN = "test-token"

        from app.services.chat.adapters.proxy import ChatProxy

        proxy = ChatProxy()
        adapter = proxy._get_adapter()

        from app.services.chat.adapters.http import HTTPAdapter

        assert isinstance(adapter, HTTPAdapter)

    @pytest.mark.asyncio
    @patch("app.services.chat.adapters.proxy.settings")
    async def test_proxy_uses_package_adapter(self, mock_settings):
        """Test proxy uses package adapter in package mode."""
        mock_settings.CHAT_SHELL_MODE = "package"

        from app.services.chat.adapters.proxy import ChatProxy, PackageAdapter

        proxy = ChatProxy()
        adapter = proxy._get_adapter()

        assert isinstance(adapter, PackageAdapter)
