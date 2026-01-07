# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for Chat Shell API endpoints."""

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client():
    """Create test client."""
    from chat_shell.main import app

    return TestClient(app)


class TestHealthEndpoints:
    """Tests for health check endpoints."""

    def test_root_endpoint(self, client):
        """Test root endpoint."""
        response = client.get("/")
        assert response.status_code == 200
        data = response.json()
        assert data["service"] == "chat-shell"
        assert data["status"] == "running"


class TestChatRequest:
    """Tests for ChatRequest data structure."""

    def test_chat_request_to_dict(self):
        """Test ChatRequest serialization."""
        from chat_shell.interface import ChatRequest

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

        data = request.__dict__
        assert data["task_id"] == 1
        assert data["subtask_id"] == 2
        assert data["message"] == "Hello"
        assert data["user_id"] == 3
        assert data["enable_tools"] is True
        assert data["enable_web_search"] is False


class TestChatEvent:
    """Tests for ChatEvent data structure."""

    def test_chat_event_to_sse(self):
        """Test ChatEvent SSE formatting."""
        from chat_shell.interface import ChatEvent, ChatEventType

        event = ChatEvent(
            type=ChatEventType.CHUNK,
            data={"content": "Hello", "offset": 0},
        )

        sse = event.to_sse()
        assert sse.startswith("data: ")
        assert "chunk" in sse
        assert "Hello" in sse
