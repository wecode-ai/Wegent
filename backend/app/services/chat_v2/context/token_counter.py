# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Token counter utility for estimating message token counts.

This module provides utilities for counting tokens in messages
to enable accurate context window management.
"""

import logging
from typing import Any

logger = logging.getLogger(__name__)

# Lazy load tiktoken to avoid import errors if not installed
_tiktoken = None


def _get_tiktoken():
    """Lazy load tiktoken module."""
    global _tiktoken
    if _tiktoken is None:
        try:
            import tiktoken

            _tiktoken = tiktoken
        except ImportError:
            logger.warning(
                "tiktoken not installed. Using approximate token counting."
            )
            _tiktoken = False
    return _tiktoken


class TokenCounter:
    """Token counter for estimating message token counts.

    Uses tiktoken when available for accurate counting,
    falls back to character-based estimation otherwise.
    """

    # Model to encoding mapping
    MODEL_ENCODINGS = {
        "gpt-4": "cl100k_base",
        "gpt-4-turbo": "cl100k_base",
        "gpt-4o": "o200k_base",
        "gpt-4o-mini": "o200k_base",
        "gpt-3.5-turbo": "cl100k_base",
        "claude": "cl100k_base",  # Claude uses similar tokenization to GPT-4
        "gemini": "cl100k_base",  # Gemini uses similar tokenization
        "deepseek": "cl100k_base",  # DeepSeek uses similar tokenization
    }

    def __init__(self, model_name: str = "gpt-4"):
        """Initialize token counter.

        Args:
            model_name: Model name to determine encoding
        """
        self.model_name = model_name
        self._encoding = None
        self._use_tiktoken = True

        # Try to initialize tiktoken encoding
        tiktoken = _get_tiktoken()
        if tiktoken and tiktoken is not False:
            try:
                encoding_name = self._get_encoding_name(model_name)
                self._encoding = tiktoken.get_encoding(encoding_name)
            except Exception as e:
                logger.warning(f"Failed to get tiktoken encoding: {e}")
                self._use_tiktoken = False
        else:
            self._use_tiktoken = False

    def _get_encoding_name(self, model_name: str) -> str:
        """Get the encoding name for a model.

        Args:
            model_name: Model name

        Returns:
            Encoding name (e.g., "cl100k_base")
        """
        model_lower = model_name.lower()
        for prefix, encoding in self.MODEL_ENCODINGS.items():
            if model_lower.startswith(prefix):
                return encoding
        return "cl100k_base"  # Default encoding

    def count_tokens(self, text: str) -> int:
        """Count tokens in a text string.

        Args:
            text: Text to count tokens for

        Returns:
            Token count
        """
        if not text:
            return 0

        if self._use_tiktoken and self._encoding is not None:
            try:
                return len(self._encoding.encode(text))
            except Exception as e:
                logger.warning(f"tiktoken encoding failed: {e}, using fallback")

        # Fallback: approximate 4 characters per token (common for English)
        return len(text) // 4 + 1

    def count_message_tokens(self, message: dict[str, Any]) -> int:
        """Count tokens in a message dictionary.

        Handles both simple string content and complex content arrays
        (e.g., vision messages with images).

        Args:
            message: Message dictionary with 'role' and 'content'

        Returns:
            Estimated token count
        """
        # Base overhead per message (role, formatting)
        tokens = 4

        # Count role tokens
        role = message.get("role", "user")
        tokens += self.count_tokens(role)

        # Count content tokens
        content = message.get("content", "")

        if isinstance(content, str):
            tokens += self.count_tokens(content)
        elif isinstance(content, list):
            # Handle content arrays (vision messages, etc.)
            for part in content:
                if isinstance(part, dict):
                    part_type = part.get("type", "")
                    if part_type == "text":
                        tokens += self.count_tokens(part.get("text", ""))
                    elif part_type == "image_url":
                        # Images typically add ~85-170 tokens depending on model
                        # Using conservative estimate
                        tokens += 170
                    else:
                        # Unknown type, estimate based on string representation
                        tokens += self.count_tokens(str(part))
                elif isinstance(part, str):
                    tokens += self.count_tokens(part)

        return tokens

    def count_messages_tokens(self, messages: list[dict[str, Any]]) -> int:
        """Count total tokens in a list of messages.

        Args:
            messages: List of message dictionaries

        Returns:
            Total token count
        """
        total = 0
        for message in messages:
            total += self.count_message_tokens(message)

        # Add base overhead for the conversation
        total += 3  # Every reply is primed with assistant

        return total
