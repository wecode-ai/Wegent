# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for Code Tool service."""

from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.schemas.code_tool import (
    CodeToolExecuteRequest,
    ConversationMessage,
    FileAttachment,
    StreamEvent,
    StreamEventType,
)
from app.services.code_tool.service import CodeToolService


class TestCodeToolService:
    """Tests for CodeToolService."""

    @pytest.fixture
    def code_tool_service(self):
        """Create a CodeToolService for testing."""
        with patch("app.services.code_tool.service.file_storage_service"):
            service = CodeToolService()
            service.executor_manager_url = "http://localhost:8001"
            service.default_timeout = 300
            service.max_timeout = 1800
            return service

    def test_build_full_prompt_basic(self, code_tool_service):
        """Test building prompt with just the task."""
        request = CodeToolExecuteRequest(
            session_id="test-session",
            prompt="Write a Python function",
        )

        prompt = code_tool_service._build_full_prompt(request)

        assert "## Current Task" in prompt
        assert "Write a Python function" in prompt
        assert "## Output Instructions" in prompt

    def test_build_full_prompt_with_history(self, code_tool_service):
        """Test building prompt with conversation history."""
        request = CodeToolExecuteRequest(
            session_id="test-session",
            prompt="Continue the implementation",
            conversation_history=[
                ConversationMessage(role="user", content="Start a new project"),
                ConversationMessage(role="assistant", content="Sure, I'll help you"),
            ],
        )

        prompt = code_tool_service._build_full_prompt(request)

        assert "## Previous Conversation Context" in prompt
        assert "Start a new project" in prompt
        assert "Sure, I'll help you" in prompt
        assert "## Current Task" in prompt

    def test_build_full_prompt_with_files(self, code_tool_service):
        """Test building prompt with file attachments."""
        request = CodeToolExecuteRequest(
            session_id="test-session",
            prompt="Process this file",
            files=[
                FileAttachment(
                    file_id="file-1",
                    filename="data.csv",
                    size=1024,
                ),
                FileAttachment(
                    file_id="file-2",
                    filename="config.yaml",
                    size=512,
                    target_path="/workspace/input/custom/config.yaml",
                ),
            ],
        )

        prompt = code_tool_service._build_full_prompt(request)

        assert "## Available Input Files" in prompt
        assert "data.csv" in prompt
        assert "1024 bytes" in prompt
        assert "/workspace/input/custom/config.yaml" in prompt

    @pytest.mark.asyncio
    async def test_execute_stream_error_handling(self, code_tool_service):
        """Test that execute_stream handles errors gracefully."""
        request = CodeToolExecuteRequest(
            session_id="test-session",
            prompt="Test task",
        )

        # Mock the executor manager call to fail
        with patch.object(
            code_tool_service,
            "_call_executor_manager",
            side_effect=Exception("Connection failed"),
        ):
            events = []
            async for event in code_tool_service.execute_stream(request, user_id=1):
                events.append(event)

        # Should have an error event
        assert len(events) >= 1
        error_events = [e for e in events if e.event_type == StreamEventType.ERROR]
        assert len(error_events) == 1
        assert "Connection failed" in error_events[0].data.get("message", "")


class TestStreamEvent:
    """Tests for StreamEvent model."""

    def test_stream_event_creation(self):
        """Test creating a StreamEvent."""
        event = StreamEvent(
            event_type=StreamEventType.TEXT,
            data={"content": "Hello"},
        )

        assert event.event_type == StreamEventType.TEXT
        assert event.data["content"] == "Hello"
        assert isinstance(event.timestamp, datetime)

    def test_stream_event_types(self):
        """Test all stream event types."""
        event_types = [
            StreamEventType.THINKING,
            StreamEventType.TOOL_USE,
            StreamEventType.TOOL_RESULT,
            StreamEventType.TEXT,
            StreamEventType.FILE_CREATED,
            StreamEventType.PROGRESS,
            StreamEventType.DONE,
            StreamEventType.ERROR,
        ]

        for event_type in event_types:
            event = StreamEvent(event_type=event_type)
            assert event.event_type == event_type


class TestCodeToolExecuteRequest:
    """Tests for CodeToolExecuteRequest model."""

    def test_basic_request(self):
        """Test creating a basic request."""
        request = CodeToolExecuteRequest(
            session_id="test-session",
            prompt="Do something",
        )

        assert request.session_id == "test-session"
        assert request.prompt == "Do something"
        assert request.timeout == 300  # default

    def test_request_with_all_fields(self):
        """Test creating a request with all fields."""
        request = CodeToolExecuteRequest(
            session_id="test-session",
            prompt="Do something",
            files=[
                FileAttachment(file_id="f1", filename="test.txt", size=100),
            ],
            conversation_history=[
                ConversationMessage(role="user", content="Hello"),
            ],
            system_prompt="Be helpful",
            timeout=600,
        )

        assert request.session_id == "test-session"
        assert len(request.files) == 1
        assert len(request.conversation_history) == 1
        assert request.system_prompt == "Be helpful"
        assert request.timeout == 600

    def test_timeout_validation(self):
        """Test timeout validation."""
        # Valid timeout
        request = CodeToolExecuteRequest(
            session_id="test",
            prompt="test",
            timeout=1800,
        )
        assert request.timeout == 1800

        # Invalid timeout (too high)
        with pytest.raises(ValueError):
            CodeToolExecuteRequest(
                session_id="test",
                prompt="test",
                timeout=2000,  # Exceeds max of 1800
            )
