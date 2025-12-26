# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the TokenCounter class."""

import pytest

from app.services.chat_v2.context.token_counter import TokenCounter


class TestTokenCounter:
    """Tests for TokenCounter."""

    def test_count_tokens_simple_text(self):
        """Test token counting for simple text."""
        counter = TokenCounter("gpt-4")
        tokens = counter.count_tokens("Hello world")
        assert tokens > 0
        # "Hello world" should be around 2-3 tokens
        assert tokens < 10

    def test_count_tokens_empty_string(self):
        """Test token counting for empty string."""
        counter = TokenCounter("gpt-4")
        tokens = counter.count_tokens("")
        assert tokens == 0

    def test_count_tokens_long_text(self):
        """Test token counting for longer text."""
        counter = TokenCounter("gpt-4")
        text = "This is a longer text that should result in more tokens. " * 10
        tokens = counter.count_tokens(text)
        # Should have significantly more tokens
        assert tokens > 50

    def test_count_message_tokens_user_message(self):
        """Test token counting for a user message."""
        counter = TokenCounter("gpt-4")
        message = {"role": "user", "content": "Hello, how are you?"}
        tokens = counter.count_message_tokens(message)
        # Should include content tokens + role tokens + overhead
        assert tokens > 0

    def test_count_message_tokens_empty_content(self):
        """Test token counting for message with empty content."""
        counter = TokenCounter("gpt-4")
        message = {"role": "user", "content": ""}
        tokens = counter.count_message_tokens(message)
        # Should still have some tokens for role and overhead
        assert tokens >= 4

    def test_count_message_tokens_list_content(self):
        """Test token counting for message with list content (vision messages)."""
        counter = TokenCounter("gpt-4")
        message = {
            "role": "user",
            "content": [
                {"type": "text", "text": "What is in this image?"},
                {"type": "image_url", "image_url": "https://example.com/image.png"},
            ],
        }
        tokens = counter.count_message_tokens(message)
        # Should include text tokens + image tokens (170)
        assert tokens > 170

    def test_count_messages_tokens(self):
        """Test token counting for a list of messages."""
        counter = TokenCounter("gpt-4")
        messages = [
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi there!"},
            {"role": "user", "content": "How are you?"},
        ]
        tokens = counter.count_messages_tokens(messages)
        # Should be sum of individual tokens + base overhead
        assert tokens > 10

    def test_different_model_encodings(self):
        """Test that different models can be used."""
        # GPT-4
        counter_gpt4 = TokenCounter("gpt-4")
        tokens_gpt4 = counter_gpt4.count_tokens("Hello world")

        # GPT-4o
        counter_gpt4o = TokenCounter("gpt-4o")
        tokens_gpt4o = counter_gpt4o.count_tokens("Hello world")

        # Claude (uses fallback)
        counter_claude = TokenCounter("claude-3-5-sonnet")
        tokens_claude = counter_claude.count_tokens("Hello world")

        # All should return positive token counts
        assert tokens_gpt4 > 0
        assert tokens_gpt4o > 0
        assert tokens_claude > 0

    def test_encoding_fallback(self):
        """Test that unknown models use fallback encoding."""
        counter = TokenCounter("unknown-model-xyz")
        tokens = counter.count_tokens("Hello world")
        # Should still work with fallback
        assert tokens > 0
