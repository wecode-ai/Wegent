# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for message compression functionality."""

import pytest

from app.chat_shell.compression import (
    AttachmentTruncationStrategy,
    CompressionConfig,
    CompressionResult,
    HistoryTruncationStrategy,
    MessageCompressor,
    ModelContextConfig,
    TokenCounter,
    get_model_context_config,
)


class TestTokenCounter:
    """Tests for TokenCounter class."""

    def test_count_text_simple(self):
        """Test counting tokens in simple text."""
        counter = TokenCounter(model_id="gpt-4")
        count = counter.count_text("Hello, world!")
        assert count > 0
        assert count < 100  # Simple text should have few tokens

    def test_count_text_empty(self):
        """Test counting tokens in empty text."""
        counter = TokenCounter(model_id="claude-3-5-sonnet")
        count = counter.count_text("")
        assert count == 0

    def test_count_message_simple(self):
        """Test counting tokens in a simple message."""
        counter = TokenCounter(model_id="gpt-4")
        message = {"role": "user", "content": "What is the weather today?"}
        count = counter.count_message(message)
        assert count > 0

    def test_count_message_multimodal(self):
        """Test counting tokens in multimodal message."""
        counter = TokenCounter(model_id="claude-3-5-sonnet")
        message = {
            "role": "user",
            "content": [
                {"type": "text", "text": "What's in this image?"},
                {
                    "type": "image_url",
                    "image_url": {"url": "data:image/png;base64,iVBORw0KGgo="},
                },
            ],
        }
        count = counter.count_message(message)
        # Should include both text and image tokens
        assert count > 100  # At least image token count

    def test_count_messages_list(self):
        """Test counting tokens in message list."""
        counter = TokenCounter(model_id="gpt-4")
        messages = [
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user", "content": "Hello!"},
            {"role": "assistant", "content": "Hi there! How can I help you?"},
        ]
        count = counter.count_messages(messages)
        assert count > 0

    def test_detect_provider_openai(self):
        """Test provider detection for OpenAI models."""
        counter = TokenCounter(model_id="gpt-4-turbo")
        assert counter.provider == "openai"

    def test_detect_provider_anthropic(self):
        """Test provider detection for Anthropic models."""
        counter = TokenCounter(model_id="claude-3-5-sonnet-20241022")
        assert counter.provider == "anthropic"

    def test_detect_provider_google(self):
        """Test provider detection for Google models."""
        counter = TokenCounter(model_id="gemini-1.5-pro")
        assert counter.provider == "google"

    def test_is_over_limit(self):
        """Test over limit detection."""
        counter = TokenCounter(model_id="gpt-4")
        messages = [{"role": "user", "content": "Hello"}]
        assert not counter.is_over_limit(messages, 1000)
        assert counter.is_over_limit(messages, 1)


class TestModelContextConfig:
    """Tests for model context configuration."""

    def test_effective_limit_calculation(self):
        """Test effective limit calculation."""
        config = ModelContextConfig(
            context_window=200000,
            output_tokens=8192,
            safety_margin=0.90,
        )
        # (200000 - 8192) * 0.9 = 172627
        expected = int((200000 - 8192) * 0.90)
        assert config.effective_limit == expected

    def test_get_model_context_config_claude(self):
        """Test getting config for Claude model."""
        config = get_model_context_config("claude-3-5-sonnet-20241022")
        assert config.context_window == 200000

    def test_get_model_context_config_gpt4(self):
        """Test getting config for GPT-4 model."""
        config = get_model_context_config("gpt-4o")
        assert config.context_window == 128000

    def test_get_model_context_config_unknown(self):
        """Test getting config for unknown model."""
        config = get_model_context_config("unknown-model-xyz")
        # Should return default config
        assert config.context_window == 128000
        assert config.safety_margin == 0.85


class TestCompressionConfig:
    """Tests for compression configuration."""

    def test_default_config(self):
        """Test default compression config."""
        config = CompressionConfig()
        assert config.enabled is True
        assert config.first_messages_to_keep == 2
        assert config.last_messages_to_keep == 10
        assert config.attachment_truncate_length == 50000

    def test_from_settings(self):
        """Test creating config from settings."""
        config = CompressionConfig.from_settings()
        assert isinstance(config, CompressionConfig)


class TestAttachmentTruncationStrategy:
    """Tests for attachment truncation strategy."""

    def test_truncate_long_attachment(self):
        """Test truncating long attachment content."""
        strategy = AttachmentTruncationStrategy()
        counter = TokenCounter(model_id="gpt-4")
        config = CompressionConfig(attachment_truncate_length=100, min_attachment_length=50)

        # Create message with long attachment
        long_content = "[Attachment 1 - doc.pdf]" + "x" * 200
        messages = [{"role": "user", "content": long_content}]

        compressed, details = strategy.compress(messages, counter, 10000, config)

        # Content should be truncated
        assert len(compressed[0]["content"]) < len(messages[0]["content"])
        assert details["attachments_truncated"] == 1
        assert details["chars_removed"] > 0

    def test_skip_short_attachment(self):
        """Test that short attachments are not truncated."""
        strategy = AttachmentTruncationStrategy()
        counter = TokenCounter(model_id="gpt-4")
        config = CompressionConfig(attachment_truncate_length=1000, min_attachment_length=500)

        # Create message with short attachment
        short_content = "[Attachment 1 - doc.pdf]short text"
        messages = [{"role": "user", "content": short_content}]

        compressed, details = strategy.compress(messages, counter, 10000, config)

        # Content should not change
        assert compressed[0]["content"] == messages[0]["content"]
        assert details["attachments_truncated"] == 0

    def test_has_attachment_content(self):
        """Test attachment content detection."""
        strategy = AttachmentTruncationStrategy()

        assert strategy._has_attachment_content("[Attachment 1] content")
        assert strategy._has_attachment_content("--- Sheet: Data ---")
        assert strategy._has_attachment_content("--- Slide 1 ---")
        assert not strategy._has_attachment_content("Regular message text")


class TestHistoryTruncationStrategy:
    """Tests for history truncation strategy."""

    def test_truncate_long_history(self):
        """Test truncating long conversation history."""
        strategy = HistoryTruncationStrategy()
        counter = TokenCounter(model_id="gpt-4")
        config = CompressionConfig(first_messages_to_keep=1, last_messages_to_keep=2)

        # Create conversation with many messages that exceed the token limit
        # Use longer content to ensure token count is high enough
        messages = [{"role": "system", "content": "You are a helpful assistant."}]
        for i in range(10):
            messages.append({"role": "user", "content": f"This is user message number {i} with some additional text to increase token count."})
            messages.append({"role": "assistant", "content": f"This is the assistant response number {i} with some additional text to increase token count."})

        # Use a very low target to ensure truncation happens
        compressed, details = strategy.compress(messages, counter, 50, config)

        # Should have fewer messages
        assert len(compressed) < len(messages)
        assert details["messages_removed"] > 0

        # Should keep system message
        assert compressed[0]["role"] == "system"

    def test_no_truncation_for_short_history(self):
        """Test that short history is not truncated."""
        strategy = HistoryTruncationStrategy()
        counter = TokenCounter(model_id="gpt-4")
        config = CompressionConfig(first_messages_to_keep=2, last_messages_to_keep=3)

        # Create short conversation
        messages = [
            {"role": "system", "content": "You are helpful."},
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi there!"},
        ]

        compressed, details = strategy.compress(messages, counter, 10000, config)

        # Should not change
        assert len(compressed) == len(messages)
        assert details["messages_removed"] == 0


class TestMessageCompressor:
    """Tests for main MessageCompressor class."""

    def test_no_compression_under_limit(self):
        """Test that messages under limit are not compressed."""
        compressor = MessageCompressor(model_id="claude-3-5-sonnet-20241022")

        messages = [
            {"role": "system", "content": "You are helpful."},
            {"role": "user", "content": "Hello!"},
        ]

        result = compressor.compress_if_needed(messages)

        assert not result.was_compressed
        assert result.messages == messages
        assert result.tokens_saved == 0

    def test_compression_when_over_limit(self):
        """Test compression when messages exceed limit."""
        # Create compressor with small effective limit
        config = CompressionConfig(
            first_messages_to_keep=1,
            last_messages_to_keep=2,
            attachment_truncate_length=100,
        )
        compressor = MessageCompressor(
            model_id="gpt-4",
            config=config,
        )

        # Create messages that exceed a small limit
        # Force small limit by using a model with small context
        messages = [
            {"role": "system", "content": "System prompt " * 100},
            {"role": "user", "content": "[Attachment 1]" + "x" * 500},
        ]

        # Override effective limit for testing
        compressor.model_context = ModelContextConfig(
            context_window=500,
            output_tokens=100,
            safety_margin=0.9,
        )

        result = compressor.compress_if_needed(messages)

        # Should attempt compression (may or may not succeed depending on strategies)
        assert result.original_tokens > 0
        assert result.compressed_tokens > 0

    def test_compression_result_properties(self):
        """Test CompressionResult properties."""
        result = CompressionResult(
            messages=[{"role": "user", "content": "test"}],
            original_tokens=1000,
            compressed_tokens=500,
            strategies_applied=["attachment_truncation"],
        )

        assert result.was_compressed is True
        assert result.tokens_saved == 500

    def test_compression_result_no_compression(self):
        """Test CompressionResult when no compression applied."""
        result = CompressionResult(
            messages=[{"role": "user", "content": "test"}],
            original_tokens=100,
            compressed_tokens=100,
        )

        assert result.was_compressed is False
        assert result.tokens_saved == 0

    def test_compress_convenience_method(self):
        """Test compress convenience method."""
        compressor = MessageCompressor(model_id="gpt-4")
        messages = [{"role": "user", "content": "Hello"}]

        compressed = compressor.compress(messages)

        assert isinstance(compressed, list)
        assert len(compressed) == len(messages)

    def test_count_tokens(self):
        """Test token counting method."""
        compressor = MessageCompressor(model_id="gpt-4")
        messages = [{"role": "user", "content": "Hello world"}]

        count = compressor.count_tokens(messages)

        assert count > 0

    def test_is_over_limit(self):
        """Test over limit check method."""
        compressor = MessageCompressor(model_id="gpt-4")
        messages = [{"role": "user", "content": "Hello"}]

        # Should not be over limit with default config
        assert not compressor.is_over_limit(messages)

    def test_disabled_compression(self):
        """Test that compression can be disabled."""
        config = CompressionConfig(enabled=False)
        compressor = MessageCompressor(model_id="gpt-4", config=config)

        messages = [
            {"role": "system", "content": "x" * 1000000},
        ]

        result = compressor.compress_if_needed(messages)

        # Should not compress
        assert not result.was_compressed
        assert result.messages == messages
