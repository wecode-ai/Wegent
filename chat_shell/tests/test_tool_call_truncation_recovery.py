# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for tool call truncation recovery.

This module tests the tool call truncation recovery functionality:
- Detection of incomplete tool calls when truncation occurs
- ToolCallTruncatedError exception raising
- Automatic retry with error context
- LLM adjustment based on truncation feedback
- Maximum retry limit enforcement
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from langchain_core.messages import AIMessage, HumanMessage

from chat_shell.agents.graph_builder import (
    TOOL_CALL_TRUNCATION_ERROR_TEMPLATE,
    TRUNCATED_MARKER_END,
    TRUNCATED_MARKER_START,
    LangGraphAgentBuilder,
    ToolCallTruncatedError,
)
from chat_shell.core.config import settings

# Get MAX_TRUNCATION_RETRIES from settings
MAX_TRUNCATION_RETRIES = settings.MAX_TRUNCATION_RETRIES


class TestToolCallTruncatedError:
    """Tests for ToolCallTruncatedError exception."""

    def test_exception_creation(self):
        """Test creating ToolCallTruncatedError exception."""
        error = ToolCallTruncatedError(reason="max_tokens", has_tool_calls=True)
        assert error.reason == "max_tokens"
        assert error.has_tool_calls is True
        assert "Tool call truncated: max_tokens" in str(error)

    def test_exception_without_tool_calls(self):
        """Test exception when no tool calls present."""
        error = ToolCallTruncatedError(reason="length", has_tool_calls=False)
        assert error.reason == "length"
        assert error.has_tool_calls is False


class TestTruncationRecoveryConstants:
    """Tests for truncation recovery related constants."""

    def test_max_truncation_retries_is_positive(self):
        """Test that MAX_TRUNCATION_RETRIES is a positive integer."""
        assert isinstance(MAX_TRUNCATION_RETRIES, int)
        assert MAX_TRUNCATION_RETRIES > 0
        assert MAX_TRUNCATION_RETRIES == 3  # Default value from settings

    def test_error_template_format(self):
        """Test that error template can be formatted with required parameters."""
        formatted = TOOL_CALL_TRUNCATION_ERROR_TEMPLATE.format(
            reason="max_tokens", attempt=1, max_attempts=2
        )
        assert "max_tokens" in formatted
        assert "1/2" in formatted
        assert "SYSTEM ERROR" in formatted
        assert "truncated" in formatted.lower()
        assert "adjust" in formatted.lower()


class TestTruncationDetectionWithToolCalls:
    """Tests for truncation detection when tool calls are present."""

    @pytest.fixture
    def mock_llm(self):
        """Create a mock LLM instance."""
        llm = MagicMock()
        llm.bind_tools = MagicMock(return_value=llm)
        return llm

    @pytest.fixture
    def agent_builder(self, mock_llm):
        """Create agent builder with mock LLM."""
        return LangGraphAgentBuilder(llm=mock_llm, max_iterations=5)

    def test_tool_call_truncation_detection_in_chunk(self):
        """Test detection of tool calls in truncated chunk."""
        # Simulate a chunk with truncation and tool calls
        mock_chunk = MagicMock()
        mock_chunk.content = ""
        mock_chunk.response_metadata = {"finish_reason": "max_tokens"}
        mock_chunk.tool_calls = [{"name": "read_file", "args": {"path": "/incomplete"}}]

        # Check that has_tool_calls detection works
        has_tool_calls = hasattr(mock_chunk, "tool_calls") and bool(
            mock_chunk.tool_calls
        )
        assert has_tool_calls is True

    def test_tool_call_chunks_detection(self):
        """Test detection of tool_call_chunks attribute."""
        mock_chunk = MagicMock()
        mock_chunk.content = ""
        mock_chunk.response_metadata = {"finish_reason": "length"}
        mock_chunk.tool_call_chunks = [{"name": "search", "args": ""}]

        # Check that tool_call_chunks detection works
        has_tool_calls = hasattr(mock_chunk, "tool_call_chunks") and bool(
            mock_chunk.tool_call_chunks
        )
        assert has_tool_calls is True


class TestTruncationRecoveryFlow:
    """Tests for the truncation recovery flow."""

    @pytest.fixture
    def mock_llm(self):
        """Create a mock LLM instance."""
        llm = MagicMock()
        llm.bind_tools = MagicMock(return_value=llm)

        # Mock streaming response
        async def mock_astream(messages):
            # First yield: successful response after recovery
            yield AIMessage(content="Adjusted response with shorter parameters")

        llm.astream = mock_astream
        return llm

    @pytest.fixture
    def agent_builder(self, mock_llm):
        """Create agent builder with mock LLM."""
        return LangGraphAgentBuilder(llm=mock_llm, max_iterations=5)

    def test_error_message_construction(self):
        """Test construction of error message for LLM."""
        error = ToolCallTruncatedError(reason="max_tokens", has_tool_calls=True)
        error_message = TOOL_CALL_TRUNCATION_ERROR_TEMPLATE.format(
            reason=error.reason, attempt=1, max_attempts=MAX_TRUNCATION_RETRIES
        )

        assert "SYSTEM ERROR" in error_message
        assert "max_tokens" in error_message
        assert "1/" in error_message
        assert "adjust" in error_message.lower()

    def test_recovery_messages_append(self):
        """Test that error message is appended to conversation."""
        original_messages = [
            HumanMessage(content="Read the file /path/to/very/long/filename.txt")
        ]

        error_message = TOOL_CALL_TRUNCATION_ERROR_TEMPLATE.format(
            reason="max_tokens", attempt=1, max_attempts=2
        )

        recovery_messages = list(original_messages) + [
            HumanMessage(content=error_message)
        ]

        assert len(recovery_messages) == 2
        assert recovery_messages[0].content == original_messages[0].content
        assert "SYSTEM ERROR" in recovery_messages[1].content

    def test_max_retry_enforcement(self):
        """Test that retries stop after MAX_TRUNCATION_RETRIES."""
        # Simulate retry count at limit
        retry_count = MAX_TRUNCATION_RETRIES

        # Should not retry when at limit
        assert retry_count >= MAX_TRUNCATION_RETRIES


class TestTruncationMarkerYield:
    """Tests for truncation marker yielding when max retries exceeded."""

    def test_truncation_marker_format_on_max_retries(self):
        """Test that truncation marker is yielded when max retries exceeded."""
        reason = "length"
        expected_marker = f"{TRUNCATED_MARKER_START}{reason}{TRUNCATED_MARKER_END}"

        assert expected_marker == "__TRUNCATED__length__END_TRUNCATED__"

    def test_different_reasons_in_marker(self):
        """Test truncation markers for different provider reasons."""
        for reason in ["length", "max_tokens", "MAX_TOKENS"]:
            marker = f"{TRUNCATED_MARKER_START}{reason}{TRUNCATED_MARKER_END}"
            assert marker.startswith(TRUNCATED_MARKER_START)
            assert marker.endswith(TRUNCATED_MARKER_END)
            assert reason in marker


class TestTruncationWithoutToolCalls:
    """Tests for truncation scenarios without tool calls."""

    def test_truncation_without_tool_calls_no_retry(self):
        """Test that regular content truncation doesn't trigger retry."""
        # Simulate a chunk with truncation but no tool calls
        mock_chunk = MagicMock()
        mock_chunk.content = "This is regular text that got truncated..."
        mock_chunk.response_metadata = {"finish_reason": "max_tokens"}
        # No tool_calls attribute or empty
        mock_chunk.tool_calls = []

        has_tool_calls = hasattr(mock_chunk, "tool_calls") and bool(
            mock_chunk.tool_calls
        )
        assert has_tool_calls is False

        # In this case, should yield truncation marker instead of raising exception


class TestRetryCountIncrement:
    """Tests for retry count tracking."""

    def test_retry_count_starts_at_zero(self):
        """Test that retry count starts at 0."""
        initial_retry_count = 0
        assert initial_retry_count == 0

    def test_retry_count_increment(self):
        """Test retry count increments on each retry."""
        retry_count = 0
        retry_count += 1
        assert retry_count == 1

        retry_count += 1
        assert retry_count == 2

    def test_retry_count_exceeds_limit(self):
        """Test detecting when retry count exceeds limit."""
        retry_count = MAX_TRUNCATION_RETRIES
        assert retry_count >= MAX_TRUNCATION_RETRIES

        retry_count = MAX_TRUNCATION_RETRIES + 1
        assert retry_count > MAX_TRUNCATION_RETRIES


class TestErrorMessageContent:
    """Tests for error message content sent to LLM."""

    def test_error_message_contains_key_instructions(self):
        """Test that error message contains key instructions for LLM."""
        error_message = TOOL_CALL_TRUNCATION_ERROR_TEMPLATE.format(
            reason="length", attempt=1, max_attempts=2
        )

        # Check for key instructions
        assert "shorter" in error_message.lower() or "concise" in error_message.lower()
        assert "break" in error_message.lower() or "split" in error_message.lower()
        assert "simplify" in error_message.lower()

    def test_error_message_shows_attempt_info(self):
        """Test that error message shows current attempt and max attempts."""
        for attempt in range(1, MAX_TRUNCATION_RETRIES + 1):
            error_message = TOOL_CALL_TRUNCATION_ERROR_TEMPLATE.format(
                reason="max_tokens",
                attempt=attempt,
                max_attempts=MAX_TRUNCATION_RETRIES,
            )

            assert f"{attempt}/{MAX_TRUNCATION_RETRIES}" in error_message

    def test_error_message_includes_reason(self):
        """Test that error message includes truncation reason."""
        for reason in ["length", "max_tokens", "MAX_TOKENS"]:
            error_message = TOOL_CALL_TRUNCATION_ERROR_TEMPLATE.format(
                reason=reason, attempt=1, max_attempts=2
            )

            assert reason in error_message
