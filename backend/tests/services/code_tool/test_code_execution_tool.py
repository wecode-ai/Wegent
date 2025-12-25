# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for Code Execution LangChain Tool."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.chat_v2.tools.builtin.code_execution import (
    CodeExecutionInput,
    CodeExecutionTool,
    create_code_execution_tool,
)


class TestCodeExecutionInput:
    """Tests for CodeExecutionInput model."""

    def test_basic_input(self):
        """Test creating basic input."""
        input_data = CodeExecutionInput(prompt="Run tests")

        assert input_data.prompt == "Run tests"
        assert input_data.system_prompt is None
        assert input_data.include_conversation_history is True

    def test_input_with_all_fields(self):
        """Test creating input with all fields."""
        input_data = CodeExecutionInput(
            prompt="Run tests",
            system_prompt="Be thorough",
            include_conversation_history=False,
        )

        assert input_data.prompt == "Run tests"
        assert input_data.system_prompt == "Be thorough"
        assert input_data.include_conversation_history is False


class TestCodeExecutionTool:
    """Tests for CodeExecutionTool."""

    @pytest.fixture
    def mock_service(self):
        """Create a mock CodeToolService."""
        service = MagicMock()
        service.execute_stream = AsyncMock()
        return service

    @pytest.fixture
    def code_tool(self, mock_service):
        """Create a CodeExecutionTool for testing."""
        return CodeExecutionTool(
            session_id="test-session",
            code_tool_service=mock_service,
            conversation_history=[
                {"role": "user", "content": "Hello"},
                {"role": "assistant", "content": "Hi there"},
            ],
            uploaded_files=[
                {"file_id": "f1", "filename": "test.txt", "size": 100},
            ],
        )

    def test_tool_properties(self, code_tool):
        """Test tool properties."""
        assert code_tool.name == "code_execution"
        assert "Docker" in code_tool.description
        assert code_tool.args_schema == CodeExecutionInput

    def test_sync_run_not_implemented(self, code_tool):
        """Test that sync run raises NotImplementedError."""
        with pytest.raises(NotImplementedError):
            code_tool._run(prompt="test")

    @pytest.mark.asyncio
    async def test_async_run_success(self, code_tool, mock_service):
        """Test successful async execution."""
        # Mock the stream to return events
        from app.schemas.code_tool import StreamEvent, StreamEventType

        async def mock_stream(*args, **kwargs):
            yield StreamEvent(
                event_type=StreamEventType.TEXT,
                data={"content": "Task completed successfully"},
            )
            yield StreamEvent(
                event_type=StreamEventType.DONE,
                data={"success": True},
            )

        mock_service.execute_stream.return_value = mock_stream()

        result = await code_tool._arun(prompt="Run the tests")

        assert "Task completed successfully" in result
        mock_service.execute_stream.assert_called_once()

    @pytest.mark.asyncio
    async def test_async_run_with_error(self, code_tool, mock_service):
        """Test async execution with error."""
        from app.schemas.code_tool import StreamEvent, StreamEventType

        async def mock_stream(*args, **kwargs):
            yield StreamEvent(
                event_type=StreamEventType.ERROR,
                data={"message": "Execution failed"},
            )

        mock_service.execute_stream.return_value = mock_stream()

        result = await code_tool._arun(prompt="Run the tests")

        assert "failed" in result.lower()

    @pytest.mark.asyncio
    async def test_async_run_with_files(self, code_tool, mock_service):
        """Test async execution with output files."""
        from app.schemas.code_tool import StreamEvent, StreamEventType

        async def mock_stream(*args, **kwargs):
            yield StreamEvent(
                event_type=StreamEventType.TEXT,
                data={"content": "Generated report"},
            )
            yield StreamEvent(
                event_type=StreamEventType.FILE_CREATED,
                data={
                    "filename": "report.pdf",
                    "download_url": "/download/report.pdf",
                    "size": 1024,
                },
            )
            yield StreamEvent(
                event_type=StreamEventType.DONE,
                data={"success": True},
            )

        mock_service.execute_stream.return_value = mock_stream()

        result = await code_tool._arun(prompt="Generate report")

        assert "Generated report" in result
        assert "report.pdf" in result
        assert "Generated Files" in result

    def test_format_result_text_only(self, code_tool):
        """Test formatting result with text only."""
        result = code_tool._format_result(
            result_parts=["Hello ", "World"],
            thinking_steps=[],
            output_files=[],
        )

        assert result == "Hello World"

    def test_format_result_with_files(self, code_tool):
        """Test formatting result with files."""
        result = code_tool._format_result(
            result_parts=["Task done"],
            thinking_steps=[],
            output_files=[
                {
                    "filename": "output.txt",
                    "download_url": "/download/123",
                    "size": 500,
                }
            ],
        )

        assert "Task done" in result
        assert "Generated Files" in result
        assert "output.txt" in result
        assert "500 bytes" in result

    def test_format_result_empty(self, code_tool):
        """Test formatting empty result."""
        result = code_tool._format_result(
            result_parts=[],
            thinking_steps=[],
            output_files=[],
        )

        assert "completed with no output" in result.lower()


class TestCreateCodeExecutionTool:
    """Tests for create_code_execution_tool factory function."""

    def test_create_tool(self):
        """Test creating tool with factory function."""
        mock_service = MagicMock()

        tool = create_code_execution_tool(
            session_id="test-session",
            code_tool_service=mock_service,
            conversation_history=[{"role": "user", "content": "Hi"}],
            uploaded_files=[{"file_id": "f1", "filename": "test.txt", "size": 10}],
        )

        assert isinstance(tool, CodeExecutionTool)
        assert tool.session_id == "test-session"
        assert tool.code_tool_service == mock_service
        assert len(tool.conversation_history) == 1
        assert len(tool.uploaded_files) == 1

    def test_create_tool_defaults(self):
        """Test creating tool with default values."""
        mock_service = MagicMock()

        tool = create_code_execution_tool(
            session_id="test-session",
            code_tool_service=mock_service,
        )

        assert tool.conversation_history == []
        assert tool.uploaded_files == []
        assert tool.stream_callback is None
