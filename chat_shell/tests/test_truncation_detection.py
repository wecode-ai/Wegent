# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for max_token truncation detection and handling.

This module tests the truncation detection functionality including:
- Detection of truncation markers from different LLM providers (GPT, Claude, Gemini)
- StreamingState truncation tracking
- Truncation warning message appending
- Result metadata inclusion
"""

import pytest

from chat_shell.agents.graph_builder import (
    TRUNCATED_MARKER_END,
    TRUNCATED_MARKER_START,
    TRUNCATION_REASONS,
)
from chat_shell.services.streaming.core import (
    TRUNCATED_END,
    TRUNCATED_START,
    TRUNCATION_WARNING_MESSAGE,
    StreamingState,
)


class TestTruncationConstants:
    """Tests for truncation-related constants."""

    def test_truncation_reasons_contains_all_providers(self):
        """Test that TRUNCATION_REASONS contains markers for all major providers."""
        # GPT (OpenAI)
        assert "length" in TRUNCATION_REASONS
        # Claude (Anthropic)
        assert "max_tokens" in TRUNCATION_REASONS
        # Gemini (Google)
        assert "MAX_TOKENS" in TRUNCATION_REASONS

    def test_marker_format_consistency(self):
        """Test that truncation marker format is consistent between modules."""
        # graph_builder.py and core.py should use the same marker format
        assert TRUNCATED_MARKER_START == TRUNCATED_START
        assert TRUNCATED_MARKER_END == TRUNCATED_END

    def test_warning_message_is_bilingual(self):
        """Test that truncation warning message contains both Chinese and English."""
        assert "内容已截断" in TRUNCATION_WARNING_MESSAGE  # Chinese
        assert "Content Truncated" in TRUNCATION_WARNING_MESSAGE  # English
        assert "token" in TRUNCATION_WARNING_MESSAGE.lower()


class TestStreamingStateTruncation:
    """Tests for StreamingState truncation tracking."""

    @pytest.fixture
    def streaming_state(self):
        """Create streaming state instance for testing."""
        return StreamingState(
            task_id=1,
            subtask_id=2,
            user_id=3,
            user_name="test_user",
        )

    def test_initial_truncation_state(self, streaming_state):
        """Test that truncation state is False by default."""
        assert streaming_state.is_truncated is False
        assert streaming_state.truncation_reason == ""

    def test_set_truncated_gpt(self, streaming_state):
        """Test setting truncation state for GPT (length)."""
        streaming_state.set_truncated("length")

        assert streaming_state.is_truncated is True
        assert streaming_state.truncation_reason == "length"

    def test_set_truncated_claude(self, streaming_state):
        """Test setting truncation state for Claude (max_tokens)."""
        streaming_state.set_truncated("max_tokens")

        assert streaming_state.is_truncated is True
        assert streaming_state.truncation_reason == "max_tokens"

    def test_set_truncated_gemini(self, streaming_state):
        """Test setting truncation state for Gemini (MAX_TOKENS)."""
        streaming_state.set_truncated("MAX_TOKENS")

        assert streaming_state.is_truncated is True
        assert streaming_state.truncation_reason == "MAX_TOKENS"

    def test_get_current_result_without_truncation(self, streaming_state):
        """Test that result does not include truncation info when not truncated."""
        streaming_state.append_content("Hello World")
        result = streaming_state.get_current_result()

        assert "truncated" not in result
        assert "truncation_reason" not in result

    def test_get_current_result_with_truncation(self, streaming_state):
        """Test that result includes truncation info when truncated."""
        streaming_state.append_content("Hello World")
        streaming_state.set_truncated("max_tokens")
        result = streaming_state.get_current_result()

        assert result["truncated"] is True
        assert result["truncation_reason"] == "max_tokens"

    def test_truncation_info_in_result_all_providers(self, streaming_state):
        """Test truncation info is correctly included for all provider reasons."""
        for reason in ["length", "max_tokens", "MAX_TOKENS"]:
            # Reset state
            state = StreamingState(task_id=1, subtask_id=2, user_id=3, user_name="test")
            state.append_content("Test content")
            state.set_truncated(reason)

            result = state.get_current_result()
            assert result["truncated"] is True
            assert result["truncation_reason"] == reason


class TestTruncationMarkerFormat:
    """Tests for truncation marker format and parsing."""

    def test_marker_format(self):
        """Test truncation marker format generation."""
        reason = "max_tokens"
        marker = f"{TRUNCATED_START}{reason}{TRUNCATED_END}"

        assert marker == "__TRUNCATED__max_tokens__END_TRUNCATED__"

    def test_marker_parsing(self):
        """Test parsing truncation reason from marker."""
        marker = "__TRUNCATED__length__END_TRUNCATED__"

        assert marker.startswith(TRUNCATED_START)
        assert marker.endswith(TRUNCATED_END)

        reason = marker[len(TRUNCATED_START) : -len(TRUNCATED_END)]
        assert reason == "length"

    def test_marker_parsing_all_reasons(self):
        """Test parsing all provider-specific truncation reasons."""
        for expected_reason in ["length", "max_tokens", "MAX_TOKENS"]:
            marker = f"{TRUNCATED_START}{expected_reason}{TRUNCATED_END}"
            parsed_reason = marker[len(TRUNCATED_START) : -len(TRUNCATED_END)]
            assert parsed_reason == expected_reason


class TestTruncationDetectionLogic:
    """Tests for truncation detection logic patterns."""

    def test_is_truncation_reason_gpt(self):
        """Test GPT truncation reason detection."""
        assert "length" in TRUNCATION_REASONS

    def test_is_truncation_reason_claude(self):
        """Test Claude truncation reason detection."""
        assert "max_tokens" in TRUNCATION_REASONS

    def test_is_truncation_reason_gemini(self):
        """Test Gemini truncation reason detection."""
        assert "MAX_TOKENS" in TRUNCATION_REASONS

    def test_normal_finish_reasons_not_truncation(self):
        """Test that normal finish reasons are not detected as truncation."""
        normal_reasons = ["stop", "end_turn", "STOP", "tool_calls", None, ""]

        for reason in normal_reasons:
            assert reason not in TRUNCATION_REASONS


class TestStreamingStateTruncationWithOtherFlags:
    """Tests for truncation state interaction with other state flags."""

    @pytest.fixture
    def streaming_state(self):
        """Create streaming state instance for testing."""
        return StreamingState(
            task_id=1,
            subtask_id=2,
            user_id=3,
            user_name="test_user",
        )

    def test_truncation_with_silent_exit(self, streaming_state):
        """Test that truncation and silent_exit can coexist in result."""
        streaming_state.set_truncated("max_tokens")
        streaming_state.is_silent_exit = True
        streaming_state.silent_exit_reason = "subscription_task"

        result = streaming_state.get_current_result()

        # Both flags should be present
        assert result["truncated"] is True
        assert result["truncation_reason"] == "max_tokens"
        assert result["silent_exit"] is True
        assert result["silent_exit_reason"] == "subscription_task"

    def test_truncation_with_reasoning_content(self, streaming_state):
        """Test that truncation works alongside reasoning content."""
        streaming_state.append_content("Main response")
        streaming_state.append_reasoning("Some reasoning")
        streaming_state.set_truncated("length")

        result = streaming_state.get_current_result()

        assert result["value"] == "Main response"
        assert result["reasoning_content"] == "Some reasoning"
        assert result["truncated"] is True

    def test_truncation_with_sources(self, streaming_state):
        """Test that truncation works alongside knowledge base sources."""
        streaming_state.append_content("Response with sources")
        streaming_state.add_sources([{"kb_id": 1, "title": "Source 1"}])
        streaming_state.set_truncated("MAX_TOKENS")

        result = streaming_state.get_current_result()

        assert result["value"] == "Response with sources"
        assert len(result["sources"]) == 1
        assert result["truncated"] is True
        assert result["truncation_reason"] == "MAX_TOKENS"
