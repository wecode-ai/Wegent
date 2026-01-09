# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Token counting utilities for message compression.

This module provides token counting functionality using tiktoken for OpenAI models
and character-based estimation for other providers.
"""

import base64
import logging
from functools import lru_cache
from typing import Any

logger = logging.getLogger(__name__)


@lru_cache(maxsize=4)
def _get_encoding(model_name: str = "cl100k_base"):
    """Get tiktoken encoding with caching.

    Args:
        model_name: Encoding name to use

    Returns:
        tiktoken.Encoding instance
    """
    try:
        import tiktoken

        return tiktoken.get_encoding(model_name)
    except ImportError:
        logger.warning("tiktoken not available, falling back to character estimation")
        return None
    except Exception as e:
        logger.warning(f"Failed to load tiktoken encoding: {e}")
        return None


class TokenCounter:
    """Token counter for various model providers.

    Supports accurate counting for OpenAI models using tiktoken,
    and character-based estimation for other providers.

    Usage:
        counter = TokenCounter(model_id="gpt-4")
        token_count = counter.count_messages(messages)
    """

    # Average characters per token for different providers
    # These are rough estimates based on typical text
    CHARS_PER_TOKEN: dict[str, float] = {
        "openai": 4.0,  # GPT models
        "anthropic": 3.5,  # Claude models (slightly more efficient)
        "google": 4.0,  # Gemini models
        "default": 4.0,
    }

    # Tokens per image (rough estimates)
    # Claude: ~1600 tokens for a standard image
    # GPT-4V: ~85 tokens for low detail, ~765 for high detail
    TOKENS_PER_IMAGE: dict[str, int] = {
        "openai": 765,  # High detail estimate
        "anthropic": 1600,
        "google": 1000,
        "default": 1000,
    }

    def __init__(self, model_name: str | None = None, model_id: str | None = None):
        """Initialize token counter.

        Args:
            model_name: Model identifier for provider detection (preferred)
            model_id: Deprecated alias for model_name (for backward compatibility)
        """
        # Support both model_name and model_id for backward compatibility
        # model_id takes precedence if explicitly provided (for backward compatibility)
        self.model_id = (model_id or model_name or "gpt-4").lower()
        self.provider = self._detect_provider()
        self._encoding = None

        # Try to load tiktoken for OpenAI models
        if self.provider == "openai":
            self._encoding = _get_encoding("cl100k_base")

    def _detect_provider(self) -> str:
        if self.model_id.startswith(("gpt-", "o1-", "o3-", "chatgpt-")):
            return "openai"
        elif self.model_id.startswith("claude-"):
            return "anthropic"
        elif self.model_id.startswith("gemini-"):
            return "google"
        return "default"

    def count_text(self, text: str) -> int:
        """Count tokens in a text string.

        Args:
            text: Text to count tokens for

        Returns:
            Estimated token count
        """
        if not text:
            return 0

        # Use tiktoken for accurate counting if available
        if self._encoding:
            try:
                return len(self._encoding.encode(text))
            except Exception:
                pass

        # Fall back to character-based estimation
        chars_per_token = self.CHARS_PER_TOKEN.get(
            self.provider, self.CHARS_PER_TOKEN["default"]
        )
        return int(len(text) / chars_per_token)

    def count_image(self, image_data: dict[str, Any] | str) -> int:
        """Count tokens for an image.

        Args:
            image_data: Image data (base64 string or dict with image_url)

        Returns:
            Estimated token count for the image
        """
        tokens_per_image = self.TOKENS_PER_IMAGE.get(
            self.provider, self.TOKENS_PER_IMAGE["default"]
        )

        # For base64 images, estimate based on size
        if isinstance(image_data, str):
            # Base64 string
            try:
                image_bytes = len(base64.b64decode(image_data))
                # Larger images use more tokens
                if image_bytes > 1024 * 1024:  # > 1MB
                    return tokens_per_image * 2
            except Exception:
                pass
        elif isinstance(image_data, dict):
            # Check for image_url structure
            url = image_data.get("image_url", {})
            if isinstance(url, dict):
                url_str = url.get("url", "")
                if url_str.startswith("data:"):
                    # Extract base64 part
                    try:
                        base64_part = url_str.split(",", 1)[1]
                        image_bytes = len(base64.b64decode(base64_part))
                        if image_bytes > 1024 * 1024:
                            return tokens_per_image * 2
                    except Exception:
                        pass

        return tokens_per_image

    def count_message(self, message: dict[str, Any]) -> int:
        """Count tokens in a single message.

        Args:
            message: Message dictionary with role and content

        Returns:
            Estimated token count
        """
        tokens = 0

        # Count role (approximately 1-2 tokens)
        role = message.get("role", "")
        tokens += 2  # Role tokens

        content = message.get("content", "")

        if isinstance(content, str):
            # Simple text content
            tokens += self.count_text(content)
        elif isinstance(content, list):
            # Multimodal content (text + images)
            for part in content:
                if isinstance(part, dict):
                    part_type = part.get("type", "")
                    if part_type == "text":
                        tokens += self.count_text(part.get("text", ""))
                    elif part_type == "image_url":
                        tokens += self.count_image(part)
                elif isinstance(part, str):
                    tokens += self.count_text(part)

        return tokens

    def count_messages(self, messages: list[dict[str, Any]]) -> int:
        """Count total tokens in a list of messages.

        Args:
            messages: List of message dictionaries

        Returns:
            Total estimated token count
        """
        total = 0
        for msg in messages:
            total += self.count_message(msg)

        # Add overhead for message formatting (varies by provider)
        # Approximately 3 tokens per message for formatting
        total += len(messages) * 3

        return total

    def estimate_remaining(
        self, messages: list[dict[str, Any]], context_limit: int
    ) -> int:
        """Estimate remaining tokens after messages.

        Args:
            messages: List of message dictionaries
            context_limit: Maximum context window

        Returns:
            Estimated remaining tokens
        """
        used = self.count_messages(messages)
        return max(0, context_limit - used)

    def is_over_limit(self, messages: list[dict[str, Any]], context_limit: int) -> bool:
        """Check if messages exceed the context limit.

        Args:
            messages: List of message dictionaries
            context_limit: Maximum context window

        Returns:
            True if messages exceed the limit
        """
        return self.count_messages(messages) > context_limit
