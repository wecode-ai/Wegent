# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Main message compressor that orchestrates compression strategies.

This module provides the MessageCompressor class that applies various
compression strategies to reduce message history size when it exceeds
the model's context window limit.
"""

import logging
from typing import Any

from .config import (
    CompressionConfig,
    get_model_context_config,
)
from .strategies import (
    AttachmentTruncationStrategy,
    CompressionResult,
    CompressionStrategy,
    HistoryTruncationStrategy,
)
from .token_counter import TokenCounter

logger = logging.getLogger(__name__)


class MessageCompressor:
    """Compressor for chat message history.

    This class applies multiple compression strategies in order to reduce
    the token count of message history to fit within model context limits.

    Strategies are applied in order of preference:
    1. Attachment truncation (least disruptive)
    2. History truncation (more aggressive)

    Usage:
        compressor = MessageCompressor(model_id="claude-3-5-sonnet-20241022")
        result = compressor.compress_if_needed(messages)
        if result.was_compressed:
            print(f"Saved {result.tokens_saved} tokens")
    """

    def __init__(
        self,
        model_id: str,
        config: CompressionConfig | None = None,
        strategies: list[CompressionStrategy] | None = None,
        model_config: dict[str, Any] | None = None,
    ):
        """Initialize message compressor.

        Args:
            model_id: Model identifier for context limit lookup
            config: Optional compression configuration (uses settings if not provided)
            strategies: Optional list of strategies (uses defaults if not provided)
            model_config: Optional model configuration from Model CRD spec
                         (contains context_window, max_output_tokens from model_resolver)
        """
        self.model_id = model_id
        self.config = config or CompressionConfig.from_settings()
        self.model_context = get_model_context_config(model_id, model_config)
        self.token_counter = TokenCounter(model_id)

        # Default strategies in order of application
        self.strategies = strategies or [
            AttachmentTruncationStrategy(),
            HistoryTruncationStrategy(),
        ]

        logger.info(
            "[MessageCompressor] Initialized for model=%s, "
            "context_window=%d, effective_limit=%d",
            model_id,
            self.model_context.context_window,
            self.model_context.effective_limit,
        )

    @property
    def effective_limit(self) -> int:
        """Get effective token limit for this model."""
        return self.model_context.effective_limit

    def count_tokens(self, messages: list[dict[str, Any]]) -> int:
        """Count tokens in messages.

        Args:
            messages: List of message dictionaries

        Returns:
            Token count
        """
        return self.token_counter.count_messages(messages)

    def is_over_limit(self, messages: list[dict[str, Any]]) -> bool:
        """Check if messages exceed the context limit.

        Args:
            messages: List of message dictionaries

        Returns:
            True if messages exceed the limit
        """
        return self.token_counter.is_over_limit(messages, self.effective_limit)

    def compress_if_needed(
        self, messages: list[dict[str, Any]]
    ) -> CompressionResult:
        """Compress messages if they exceed the context limit.

        This method checks if messages exceed the model's context limit
        and applies compression strategies if needed.

        Args:
            messages: List of message dictionaries

        Returns:
            CompressionResult with compressed messages and details
        """
        if not self.config.enabled:
            return CompressionResult(
                messages=messages,
                original_tokens=self.count_tokens(messages),
                compressed_tokens=self.count_tokens(messages),
            )

        original_tokens = self.count_tokens(messages)
        target_tokens = self.effective_limit

        logger.info(
            "[MessageCompressor] Checking compression: "
            "original_tokens=%d, target_tokens=%d, over_limit=%s",
            original_tokens,
            target_tokens,
            original_tokens > target_tokens,
        )

        # If under limit, no compression needed
        if original_tokens <= target_tokens:
            return CompressionResult(
                messages=messages,
                original_tokens=original_tokens,
                compressed_tokens=original_tokens,
            )

        # Apply compression strategies
        current_messages = messages
        strategies_applied = []
        all_details = {}

        for strategy in self.strategies:
            current_tokens = self.token_counter.count_messages(current_messages)

            # Check if we've achieved target
            if current_tokens <= target_tokens:
                break

            logger.info(
                "[MessageCompressor] Applying strategy: %s, "
                "current_tokens=%d, target=%d",
                strategy.name,
                current_tokens,
                target_tokens,
            )

            # Apply strategy
            compressed, details = strategy.compress(
                current_messages,
                self.token_counter,
                target_tokens,
                self.config,
            )

            # Check if strategy made progress
            new_tokens = self.token_counter.count_messages(compressed)
            if new_tokens < current_tokens:
                current_messages = compressed
                strategies_applied.append(strategy.name)
                all_details[strategy.name] = details

                logger.info(
                    "[MessageCompressor] Strategy %s saved %d tokens: %d -> %d",
                    strategy.name,
                    current_tokens - new_tokens,
                    current_tokens,
                    new_tokens,
                )

        compressed_tokens = self.token_counter.count_messages(current_messages)

        # Log final result
        if strategies_applied:
            logger.info(
                "[MessageCompressor] Compression complete: "
                "%d -> %d tokens (saved %d), strategies: %s",
                original_tokens,
                compressed_tokens,
                original_tokens - compressed_tokens,
                ", ".join(strategies_applied),
            )
        else:
            logger.warning(
                "[MessageCompressor] No compression applied, "
                "messages still over limit: %d > %d",
                compressed_tokens,
                target_tokens,
            )

        return CompressionResult(
            messages=current_messages,
            original_tokens=original_tokens,
            compressed_tokens=compressed_tokens,
            strategies_applied=strategies_applied,
            details=all_details,
        )

    def compress(self, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Convenience method to compress messages and return only the result.

        Args:
            messages: List of message dictionaries

        Returns:
            Compressed messages
        """
        result = self.compress_if_needed(messages)
        return result.messages
