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


class TestExecutionRequest:
    """Tests for ExecutionRequest data structure."""

    def test_execution_request_to_dict(self):
        """Test ExecutionRequest serialization."""
        from shared.models.execution import ExecutionRequest

        request = ExecutionRequest(
            task_id=1,
            subtask_id=2,
            prompt="Hello",  # ExecutionRequest uses 'prompt' instead of 'message'
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
        assert data["enable_tools"] is True
        assert data["enable_web_search"] is False


class TestExecutionEvent:
    """Tests for ExecutionEvent data structure."""

    def test_execution_event_to_sse(self):
        """Test ExecutionEvent SSE formatting."""
        from shared.models.execution import EventType, ExecutionEvent

        event = ExecutionEvent(
            type=EventType.CHUNK.value,
            content="Hello",
            offset=0,
        )

        sse = event.to_sse()
        assert sse.startswith("data: ")
        assert "chunk" in sse
        assert "Hello" in sse
