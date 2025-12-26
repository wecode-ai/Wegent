# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Context manager for truncating conversation history.

This module provides the ContextManager class that handles message truncation
to ensure the conversation context fits within the model's token limit.

Strategy:
1. Always keep the system prompt
2. Keep the most recent messages (from newest to oldest)
3. At least keep the most recent user message
"""

import logging
from dataclasses import dataclass
from typing import Any

from .constants import get_default_context_limit
from .token_counter import TokenCounter

logger = logging.getLogger(__name__)


@dataclass
class TruncationResult:
    """Result of context truncation.

    Attributes:
        messages: List of messages after truncation
        was_truncated: Whether any messages were truncated
        original_count: Original number of messages
        truncated_count: Number of messages after truncation
        total_tokens: Total token count after truncation
    """

    messages: list[dict[str, Any]]
    was_truncated: bool
    original_count: int
    truncated_count: int
    total_tokens: int


class ContextManager:
    """Manager for conversation context truncation.

    Handles truncating message history to fit within model context limits
    while preserving the most recent and important messages.
    """

    def __init__(self, model_name: str = "gpt-4"):
        """Initialize context manager.

        Args:
            model_name: Model name for token counting
        """
        self.model_name = model_name
        self.token_counter = TokenCounter(model_name)

    def truncate_messages(
        self,
        messages: list[dict[str, Any]],
        system_prompt: str,
        max_context_tokens: int | None = None,
        reserved_output_ratio: float = 0.2,
    ) -> TruncationResult:
        """Truncate messages to fit within context limit.

        Strategy:
        1. Always reserve space for the system prompt
        2. Keep messages from most recent to oldest until limit is reached
        3. Always keep at least the most recent user message

        Args:
            messages: List of conversation messages (excluding system prompt)
            system_prompt: System prompt string
            max_context_tokens: Maximum context tokens (uses model default if None)
            reserved_output_ratio: Ratio reserved for output (0-1)

        Returns:
            TruncationResult with truncated messages and metadata
        """
        original_count = len(messages)

        # Get max context tokens
        if max_context_tokens is None:
            max_context_tokens = get_default_context_limit(self.model_name)

        # Calculate available tokens for messages
        available_tokens = int(max_context_tokens * (1 - reserved_output_ratio))

        # Reserve tokens for system prompt
        system_tokens = self.token_counter.count_tokens(system_prompt) + 4
        remaining_tokens = available_tokens - system_tokens

        if remaining_tokens <= 0:
            logger.warning(
                "[ContextManager] System prompt exceeds available tokens. "
                "max_context=%d, system_tokens=%d",
                max_context_tokens,
                system_tokens,
            )
            remaining_tokens = max_context_tokens // 4  # Emergency fallback

        # Truncate from most recent to oldest
        truncated_messages: list[dict[str, Any]] = []
        total_tokens = 0
        was_truncated = False

        # Process messages from newest to oldest
        for message in reversed(messages):
            msg_tokens = self.token_counter.count_message_tokens(message)

            if total_tokens + msg_tokens <= remaining_tokens:
                truncated_messages.insert(0, message)
                total_tokens += msg_tokens
            else:
                was_truncated = True
                # Always keep at least the most recent message
                if not truncated_messages:
                    truncated_messages.insert(0, message)
                    total_tokens += msg_tokens
                    logger.warning(
                        "[ContextManager] Single message exceeds limit. "
                        "msg_tokens=%d, remaining=%d",
                        msg_tokens,
                        remaining_tokens,
                    )
                break

        # Log truncation info
        if was_truncated:
            logger.info(
                "[ContextManager] Context truncated: %d -> %d messages, "
                "tokens: %d (system) + %d (messages) = %d total (limit: %d)",
                original_count,
                len(truncated_messages),
                system_tokens,
                total_tokens,
                system_tokens + total_tokens,
                max_context_tokens,
            )

        return TruncationResult(
            messages=truncated_messages,
            was_truncated=was_truncated,
            original_count=original_count,
            truncated_count=len(truncated_messages),
            total_tokens=system_tokens + total_tokens,
        )

    def estimate_context_size(
        self,
        messages: list[dict[str, Any]],
        system_prompt: str,
    ) -> dict[str, int]:
        """Estimate the context size without truncating.

        Args:
            messages: List of conversation messages
            system_prompt: System prompt string

        Returns:
            Dictionary with token counts
        """
        system_tokens = self.token_counter.count_tokens(system_prompt) + 4
        message_tokens = self.token_counter.count_messages_tokens(messages)

        return {
            "system_tokens": system_tokens,
            "message_tokens": message_tokens,
            "total_tokens": system_tokens + message_tokens,
            "message_count": len(messages),
        }
