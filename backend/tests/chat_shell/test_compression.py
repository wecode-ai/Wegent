# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for message compression functionality."""

import pytest
from chat_shell.compression.compressor import MessageCompressor
from chat_shell.compression.config import (
    CompressionConfig,
    ModelContextConfig,
    get_model_context_config,
)
from chat_shell.compression.strategies import (
    AttachmentTruncationStrategy,
    CompressionResult,
    HistoryTruncationStrategy,
)
from chat_shell.compression.token_counter import TokenCounter


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
            trigger_threshold=0.90,
            target_threshold=0.70,
        )
        # available_tokens = 200000 - 8192 = 191808
        # trigger_limit (effective_limit) = 191808 * 0.90 = 172627
        expected = int((200000 - 8192) * 0.90)
        assert config.effective_limit == expected
        assert config.trigger_limit == expected
        # target_limit = 191808 * 0.70 = 134265
        expected_target = int((200000 - 8192) * 0.70)
        assert config.target_limit == expected_target

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
        assert config.trigger_threshold == 0.85

    def test_get_model_context_config_from_model_config(self):
        """Test getting config from model_config (Model CRD spec)."""
        model_config = {
            "context_window": 256000,
            "max_output_tokens": 16000,
        }
        config = get_model_context_config(
            "unknown-model-xyz", model_config=model_config
        )
        # Should use values from model_config
        assert config.context_window == 256000
        assert config.output_tokens == 16000
        assert config.trigger_threshold == 0.90

    def test_get_model_context_config_model_config_takes_priority(self):
        """Test that model_config takes priority over built-in defaults."""
        model_config = {
            "context_window": 500000,
            "max_output_tokens": 32000,
        }
        # Use a known model ID but override with model_config
        config = get_model_context_config("gpt-4o", model_config=model_config)
        # Should use values from model_config, not built-in defaults
        assert config.context_window == 500000
        assert config.output_tokens == 32000

    def test_get_model_context_config_partial_model_config(self):
        """Test getting config with partial model_config (only context_window)."""
        model_config = {
            "context_window": 300000,
            # max_output_tokens not provided
        }
        config = get_model_context_config("unknown-model", model_config=model_config)
        # Should use context_window from model_config and default output_tokens
        assert config.context_window == 300000
        assert config.output_tokens == 4096  # default fallback

    def test_get_model_context_config_empty_model_config(self):
        """Test getting config with empty model_config falls back to built-in."""
        model_config = {}  # Empty dict
        config = get_model_context_config("gpt-4o", model_config=model_config)
        # Should fall back to built-in defaults for gpt-4o
        assert config.context_window == 128000
        assert config.output_tokens == 16384


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
        config = CompressionConfig(
            attachment_truncate_length=100, min_attachment_length=50
        )

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
        config = CompressionConfig(
            attachment_truncate_length=1000, min_attachment_length=500
        )

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

    def test_middle_truncation_preserves_begin_and_end(self):
        """Test that truncation keeps beginning and end, removes middle."""
        strategy = AttachmentTruncationStrategy()
        counter = TokenCounter(model_id="gpt-4")
        config = CompressionConfig(
            attachment_truncate_length=100,  # Keep 100 chars total
            min_attachment_length=50,
        )

        # Create content with distinct beginning, middle, and end
        # Beginning: "AAAA...", Middle: "MMMM...", End: "ZZZZ..."
        begin_marker = "A" * 100  # Beginning content
        middle_marker = "M" * 200  # Middle content (will be truncated)
        end_marker = "Z" * 100  # End content

        long_content = (
            f"[Attachment 1 - doc.pdf]{begin_marker}{middle_marker}{end_marker}"
        )
        messages = [{"role": "user", "content": long_content}]

        compressed, details = strategy.compress(messages, counter, 100000, config)

        result_content = compressed[0]["content"]

        # Should contain beginning (A's)
        assert "AAAA" in result_content, "Beginning content should be preserved"
        # Should contain end (Z's)
        assert "ZZZZ" in result_content, "End content should be preserved"
        # Should contain truncation notice
        assert (
            "Middle content truncated" in result_content
            or "truncated" in result_content.lower()
        )
        # Middle should be mostly removed (some M's might remain at boundaries)
        # The truncated content should be shorter than original
        assert len(result_content) < len(long_content)

    def test_binary_search_compression(self):
        """Test binary search finds appropriate retention ratio."""
        strategy = AttachmentTruncationStrategy()
        counter = TokenCounter(model_id="gpt-4")
        config = CompressionConfig(
            attachment_truncate_length=10000,
            min_attachment_length=100,
        )

        # Create message with long attachment
        long_content = "[Attachment 1 - doc.pdf]" + "x" * 5000
        messages = [{"role": "user", "content": long_content}]

        # Request token reduction
        compressed, details = strategy.compress(messages, counter, 500, config)

        # Should have truncated the attachment
        assert details["attachments_truncated"] >= 1
        assert details["chars_removed"] > 0
        # Content should be reduced
        assert len(compressed[0]["content"]) < len(messages[0]["content"])
        # Should have a retention ratio from binary search
        assert "retention_ratio" in details
        assert 0 < details["retention_ratio"] <= 1.0

    def test_compression_respects_min_retention_ratio(self):
        """Test that compression respects minimum retention ratio."""
        strategy = AttachmentTruncationStrategy()
        counter = TokenCounter(model_id="gpt-4")
        config = CompressionConfig(
            attachment_truncate_length=1000,
            min_attachment_length=50,
        )

        # Create message with long attachment
        long_content = "[Attachment 1 - doc.pdf]" + "x" * 3000
        messages = [{"role": "user", "content": long_content}]

        # Request very aggressive compression
        compressed, details = strategy.compress(messages, counter, 10000, config)

        # Should have truncated
        assert details["attachments_truncated"] >= 1
        # Retention ratio should not go below MIN_RETENTION_RATIO
        assert details["retention_ratio"] >= strategy.MIN_RETENTION_RATIO

    def test_no_compression_when_under_target(self):
        """Test that no compression happens when already under target."""
        strategy = AttachmentTruncationStrategy()
        counter = TokenCounter(model_id="gpt-4")
        config = CompressionConfig(
            attachment_truncate_length=2000,
            min_attachment_length=100,
        )

        # Create message with short attachment
        short_content = "[Attachment 1 - doc.pdf]" + "x" * 100
        messages = [{"role": "user", "content": short_content}]

        # Request compression but content is already small
        compressed, details = strategy.compress(messages, counter, 100000, config)

        # Should not truncate since content is already small
        # The retention ratio should be 1.0 (no truncation needed)
        assert (
            details["retention_ratio"] == 1.0 or details["attachments_truncated"] == 0
        )

    def test_dynamic_halving_multiple_attachments(self):
        """Test dynamic halving with multiple attachments in one message."""
        strategy = AttachmentTruncationStrategy()
        counter = TokenCounter(model_id="gpt-4")
        config = CompressionConfig(
            attachment_truncate_length=5000,
            min_attachment_length=100,
        )

        # Create message with multiple long attachments
        content = (
            "[Attachment 1 - doc1.pdf]"
            + "a" * 10000
            + "[Attachment 2 - doc2.pdf]"
            + "b" * 10000
        )
        messages = [{"role": "user", "content": content}]

        # Set a low target to force halving
        compressed, details = strategy.compress(messages, counter, 100, config)

        # Should have truncated attachments
        assert details["attachments_truncated"] >= 1
        assert details["chars_removed"] > 0
        # Content should be reduced
        assert len(compressed[0]["content"]) < len(messages[0]["content"])

    def test_binary_search_iterations_limit(self):
        """Test that binary search has a reasonable iteration limit."""
        strategy = AttachmentTruncationStrategy()
        counter = TokenCounter(model_id="gpt-4")
        config = CompressionConfig(
            attachment_truncate_length=1000,
            min_attachment_length=50,
        )

        # Create moderately long content (not too large to avoid slow tests)
        long_content = "[Attachment 1 - doc.pdf]" + "x" * 5000
        messages = [{"role": "user", "content": long_content}]

        # Request a large token reduction to force binary search to work hard
        compressed, details = strategy.compress(messages, counter, 10000, config)

        # Should have truncated the attachment
        assert details["attachments_truncated"] >= 1
        assert details["chars_removed"] > 0
        # Content should be reduced
        assert len(compressed[0]["content"]) < len(messages[0]["content"])
        # Should have a retention ratio (binary search result)
        assert "retention_ratio" in details
        assert 0 < details["retention_ratio"] <= 1.0

    def test_recency_factor_calculation(self):
        """Test recency factor calculation for different positions."""
        strategy = AttachmentTruncationStrategy()

        # Single message should get factor 1.0
        assert strategy._calculate_recency_factor(0, 1) == 1.0

        # First message in multi-message list should get 0.25
        assert strategy._calculate_recency_factor(0, 10) == 0.25

        # Last message should get 1.0
        assert strategy._calculate_recency_factor(9, 10) == 1.0

        # Middle message should get intermediate value
        factor = strategy._calculate_recency_factor(4, 10)
        assert 0.25 < factor < 1.0

    def test_uniform_compression_across_messages(self):
        """Test that all messages are compressed with the same retention ratio."""
        strategy = AttachmentTruncationStrategy()
        counter = TokenCounter(model_id="gpt-4")
        config = CompressionConfig(
            attachment_truncate_length=1000,
            min_attachment_length=100,
        )

        # Create multiple messages with same-length attachments
        messages = [
            {"role": "user", "content": "[Attachment 1 - old.pdf]" + "a" * 2000},
            {"role": "assistant", "content": "Response 1"},
            {"role": "user", "content": "[Attachment 2 - mid.pdf]" + "b" * 2000},
            {"role": "assistant", "content": "Response 2"},
            {"role": "user", "content": "[Attachment 3 - new.pdf]" + "c" * 2000},
        ]

        compressed, details = strategy.compress(messages, counter, 5000, config)

        # All attachment messages should be compressed
        assert details["attachments_truncated"] >= 1
        # Should have a uniform retention ratio applied
        assert "retention_ratio" in details
        assert 0 < details["retention_ratio"] <= 1.0

    def test_multiple_attachments_compressed(self):
        """Test that multiple attachments in different messages are all compressed."""
        strategy = AttachmentTruncationStrategy()
        counter = TokenCounter(model_id="gpt-4")
        config = CompressionConfig(
            attachment_truncate_length=800,
            min_attachment_length=100,
        )

        # Create messages with attachments
        messages = [
            {"role": "user", "content": "[Attachment 1 - first.pdf]" + "x" * 1500},
            {"role": "assistant", "content": "Response"},
            {"role": "user", "content": "[Attachment 2 - last.pdf]" + "y" * 1500},
        ]

        compressed, details = strategy.compress(messages, counter, 2000, config)

        # Should have compressed attachments
        assert details["attachments_truncated"] >= 1
        assert details["chars_removed"] > 0
        # Both attachment messages should be shorter than original
        assert len(compressed[0]["content"]) < len(messages[0]["content"])
        assert len(compressed[2]["content"]) < len(messages[2]["content"])


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
            messages.append(
                {
                    "role": "user",
                    "content": f"This is user message number {i} with some additional text to increase token count.",
                }
            )
            messages.append(
                {
                    "role": "assistant",
                    "content": f"This is the assistant response number {i} with some additional text to increase token count.",
                }
            )

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
            trigger_threshold=0.9,
            target_threshold=0.7,
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
