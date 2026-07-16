# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for Chat Shell API endpoints."""

import asyncio

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client():
    """Create test client."""
    from chat_shell.main import app

    return TestClient(app)


@pytest.fixture(autouse=True)
def reset_shutdown_manager():
    """Reset shutdown tracking around API tests."""
    from chat_shell.core.shutdown import shutdown_manager

    shutdown_manager.reset()
    yield
    shutdown_manager.reset()


class TestHealthEndpoints:
    """Tests for health check endpoints."""

    def test_root_endpoint(self, client):
        """Test root endpoint."""
        response = client.get("/")
        assert response.status_code == 200
        data = response.json()
        assert data["service"] == "chat-shell"
        assert data["status"] == "running"

    def test_health_endpoint_accepts_head(self, client):
        """Test liveness endpoint accepts HEAD probes."""
        response = client.head("/health")
        assert response.status_code == 200
        assert response.content == b""


class TestActiveStreamEndpoints:
    """Tests for active stream count endpoints."""

    @pytest.mark.asyncio
    async def test_active_count_endpoint_reports_runtime_streams(self, client):
        """Test active stream count endpoint uses runtime stream tracking."""
        from chat_shell.core.shutdown import shutdown_manager

        await shutdown_manager.register_stream("stream-a")
        await shutdown_manager.register_stream("stream-b")

        response = client.get("/v1/streams/active-count")

        assert response.status_code == 200
        assert response.json() == {"active_streams": 2}

    @pytest.mark.asyncio
    async def test_v1_health_reports_runtime_streams(self, client):
        """Test /v1/health reports the same runtime stream count."""
        from chat_shell.core.shutdown import shutdown_manager

        await shutdown_manager.register_stream("stream-a")

        response = client.get("/v1/health")

        assert response.status_code == 200
        assert response.json()["active_streams"] == 1

    @pytest.mark.asyncio
    async def test_create_response_rejects_new_streams_during_shutdown(self, client):
        """Test new response streams are rejected after shutdown starts."""
        from chat_shell.core.shutdown import shutdown_manager

        await shutdown_manager.initiate_shutdown()

        response = client.post(
            "/v1/responses",
            json={"model": "gpt-4", "input": "hello", "stream": True},
        )

        assert response.status_code == 503
        assert "shutting down" in response.json()["detail"]
        assert shutdown_manager.get_active_stream_count() == 0


class TestShutdownEndpoints:
    """Tests for shutdown orchestration endpoints."""

    @pytest.mark.asyncio
    async def test_shutdown_wait_timeout_cancels_registered_streams(
        self, client, monkeypatch
    ):
        """Test /shutdown/wait cancels active streams after timeout."""
        from chat_shell.core.shutdown import shutdown_manager

        cancel_event = asyncio.Event()
        await shutdown_manager.register_stream("stream-a", cancel_event=cancel_event)

        async def wait_for_streams_timeout(timeout):
            return False

        monkeypatch.setattr(
            shutdown_manager, "wait_for_streams", wait_for_streams_timeout
        )

        response = client.post("/shutdown/wait")

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "timeout"
        assert data["active_streams"] == 1
        assert data["cancelled_streams"] == 1
        assert cancel_event.is_set()


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
