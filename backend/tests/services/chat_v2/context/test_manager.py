# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the ContextManager class."""

import pytest

from app.services.chat_v2.context.manager import ContextManager, TruncationResult


class TestContextManager:
    """Tests for ContextManager."""

    def test_no_truncation_when_under_limit(self):
        """Test that no truncation occurs when messages are under limit."""
        manager = ContextManager("gpt-4")
        messages = [
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi there!"},
        ]
        result = manager.truncate_messages(
            messages=messages,
            system_prompt="You are helpful",
            max_context_tokens=10000,
            reserved_output_ratio=0.2,
        )

        assert not result.was_truncated
        assert len(result.messages) == 2
        assert result.original_count == 2
        assert result.truncated_count == 2

    def test_truncation_when_over_limit(self):
        """Test that truncation occurs when messages exceed limit."""
        manager = ContextManager("gpt-4")
        # Create many messages
        messages = [{"role": "user", "content": "x" * 500} for _ in range(50)]

        result = manager.truncate_messages(
            messages=messages,
            system_prompt="You are helpful",
            max_context_tokens=1000,
            reserved_output_ratio=0.2,
        )

        assert result.was_truncated
        assert result.truncated_count < result.original_count
        assert len(result.messages) < 50

    def test_always_keep_at_least_one_message(self):
        """Test that at least one message is always kept."""
        manager = ContextManager("gpt-4")
        messages = [{"role": "user", "content": "x" * 5000}]

        result = manager.truncate_messages(
            messages=messages,
            system_prompt="You are helpful",
            max_context_tokens=100,  # Very small limit
            reserved_output_ratio=0.2,
        )

        # Should keep at least one message even if over limit
        assert len(result.messages) >= 1

    def test_keeps_most_recent_messages(self):
        """Test that most recent messages are kept, older ones truncated."""
        manager = ContextManager("gpt-4")
        messages = [
            {"role": "user", "content": "message_1"},
            {"role": "assistant", "content": "response_1"},
            {"role": "user", "content": "message_2"},
            {"role": "assistant", "content": "response_2"},
            {"role": "user", "content": "message_3"},
            {"role": "assistant", "content": "response_3_latest"},
        ]

        result = manager.truncate_messages(
            messages=messages,
            system_prompt="System prompt",
            max_context_tokens=200,  # Small limit to force truncation
            reserved_output_ratio=0.2,
        )

        if result.was_truncated:
            # The last message should be preserved
            assert "response_3_latest" in result.messages[-1]["content"]

    def test_empty_messages_list(self):
        """Test handling of empty messages list."""
        manager = ContextManager("gpt-4")

        result = manager.truncate_messages(
            messages=[],
            system_prompt="You are helpful",
            max_context_tokens=10000,
            reserved_output_ratio=0.2,
        )

        assert not result.was_truncated
        assert len(result.messages) == 0
        assert result.original_count == 0

    def test_estimate_context_size(self):
        """Test context size estimation."""
        manager = ContextManager("gpt-4")
        messages = [
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi there!"},
        ]

        estimate = manager.estimate_context_size(
            messages=messages,
            system_prompt="You are a helpful assistant",
        )

        assert "system_tokens" in estimate
        assert "message_tokens" in estimate
        assert "total_tokens" in estimate
        assert "message_count" in estimate
        assert estimate["message_count"] == 2
        assert estimate["total_tokens"] > 0

    def test_default_context_limit_used(self):
        """Test that default context limit is used when not provided."""
        manager = ContextManager("claude-3-5-sonnet")
        messages = [{"role": "user", "content": "Hello"}]

        result = manager.truncate_messages(
            messages=messages,
            system_prompt="You are helpful",
            max_context_tokens=None,  # Use default
            reserved_output_ratio=0.2,
        )

        # Should work without error
        assert result.messages is not None

    def test_reserved_output_ratio(self):
        """Test that reserved output ratio affects available tokens."""
        manager = ContextManager("gpt-4")
        messages = [{"role": "user", "content": "x" * 1000} for _ in range(20)]

        # With small reserved ratio, more messages can fit
        result_small_reserve = manager.truncate_messages(
            messages=messages,
            system_prompt="System",
            max_context_tokens=5000,
            reserved_output_ratio=0.1,
        )

        # With large reserved ratio, fewer messages fit
        result_large_reserve = manager.truncate_messages(
            messages=messages,
            system_prompt="System",
            max_context_tokens=5000,
            reserved_output_ratio=0.5,
        )

        # More messages should fit with smaller reserve ratio
        assert result_small_reserve.truncated_count >= result_large_reserve.truncated_count


class TestTruncationResult:
    """Tests for TruncationResult dataclass."""

    def test_truncation_result_fields(self):
        """Test that TruncationResult has expected fields."""
        result = TruncationResult(
            messages=[{"role": "user", "content": "Hello"}],
            was_truncated=True,
            original_count=5,
            truncated_count=1,
            total_tokens=100,
        )

        assert result.messages == [{"role": "user", "content": "Hello"}]
        assert result.was_truncated is True
        assert result.original_count == 5
        assert result.truncated_count == 1
        assert result.total_tokens == 100
