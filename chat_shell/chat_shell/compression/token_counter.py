# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Token counting utilities for message compression.

This module provides token counting functionality using tiktoken for efficient
token counting. tiktoken is much lighter than litellm (~1MB vs ~156MB) while
providing accurate token counts for OpenAI-compatible models.

For non-OpenAI models (Claude, Gemini, etc.), we use cl100k_base encoding
which provides a reasonable approximation.

Supported providers:
- OpenAI (GPT-4, GPT-4o, o1, o3, etc.) - exact counts
- Anthropic (Claude) - approximate counts using cl100k_base
- Google (Gemini) - approximate counts using cl100k_base
- Other models - approximate counts using cl100k_base
"""

import json
import logging
from typing import Any

import tiktoken

from chat_shell.models.providers import detect_provider

logger = logging.getLogger(__name__)

# Cache for tiktoken encodings
_encoding_cache: dict[str, tiktoken.Encoding] = {}


def _get_encoding_for_model(model_id: str) -> tiktoken.Encoding:
    """Get the appropriate tiktoken encoding for a model.

    Args:
        model_id: Model identifier string

    Returns:
        tiktoken.Encoding instance
    """
    model_lower = model_id.lower()

    # Try to get encoding from cache
    cache_key = model_lower

    if cache_key in _encoding_cache:
        return _encoding_cache[cache_key]

    # Try to get model-specific encoding for OpenAI models
    try:
        encoding = tiktoken.encoding_for_model(model_id)
        _encoding_cache[cache_key] = encoding
        return encoding
    except KeyError:
        pass

    # For non-OpenAI models, use cl100k_base (GPT-4 encoding)
    # This provides a reasonable approximation for most models
    if "cl100k_base" not in _encoding_cache:
        _encoding_cache["cl100k_base"] = tiktoken.get_encoding("cl100k_base")

    return _encoding_cache["cl100k_base"]


def _count_tokens_for_messages(model_id: str, messages: list[dict[str, Any]]) -> int:
    """Count tokens for a list of messages.

    This function counts tokens similar to how OpenAI counts them,
    including message overhead tokens.

    Args:
        model_id: Model identifier
        messages: List of message dictionaries

    Returns:
        Total token count
    """
    encoding = _get_encoding_for_model(model_id)

    # Token overhead per message (role, content separators, etc.)
    # OpenAI uses ~4 tokens per message for GPT-4
    tokens_per_message = 4

    total_tokens = 0

    for message in messages:
        total_tokens += tokens_per_message

        # Count role tokens
        role = message.get("role", "")
        if role:
            total_tokens += len(encoding.encode(role))

        # Count content tokens
        content = message.get("content", "")
        if isinstance(content, str):
            total_tokens += len(encoding.encode(content))
        elif isinstance(content, list):
            # Multimodal content (text + images)
            for item in content:
                if isinstance(item, dict):
                    if item.get("type") == "text":
                        text = item.get("text", "")
                        total_tokens += len(encoding.encode(text))
                    elif item.get("type") == "image_url":
                        # Approximate image tokens (varies by resolution)
                        # OpenAI uses ~85 tokens for low-res, ~170 for high-res
                        total_tokens += 170
                elif isinstance(item, str):
                    total_tokens += len(encoding.encode(item))

        # Count name tokens if present
        name = message.get("name", "")
        if name:
            total_tokens += len(encoding.encode(name))
            total_tokens += 1  # Extra token for name field

        # Count tool_calls tokens if present
        tool_calls = message.get("tool_calls", [])
        if tool_calls:
            for tool_call in tool_calls:
                # Function name
                func_name = tool_call.get("function", {}).get("name", "")
                if func_name:
                    total_tokens += len(encoding.encode(func_name))

                # Function arguments (JSON)
                func_args = tool_call.get("function", {}).get("arguments", "")
                if func_args:
                    if isinstance(func_args, str):
                        total_tokens += len(encoding.encode(func_args))
                    else:
                        total_tokens += len(encoding.encode(json.dumps(func_args)))

    # Add 3 tokens for assistant reply priming
    total_tokens += 3

    return total_tokens


class TokenCounter:
    """Token counter for various model providers using tiktoken.

    This implementation uses tiktoken for efficient token counting.
    For OpenAI models, it provides exact counts. For other models
    (Claude, Gemini, etc.), it uses cl100k_base encoding which
    provides a reasonable approximation.

    Usage:
        counter = TokenCounter(model_id="gpt-4o")
        token_count = counter.count_messages(messages)
    """

    def __init__(
        self,
        model_name: str | None = None,
        model_id: str | None = None,
        model_type: str | None = None,
    ):
        """Initialize token counter.

        Args:
            model_name: Model identifier for provider detection (preferred)
            model_id: Deprecated alias for model_name (for backward compatibility)
            model_type: Model protocol type (e.g. "claude", "openai", "gemini").
                This is the authoritative source for provider detection.
        """
        self.model_id = model_id or model_name or "gpt-4"
        self._model_type = model_type
        self._encoding: tiktoken.Encoding | None = None

    @property
    def encoding(self) -> tiktoken.Encoding:
        """Get the tiktoken encoding for this model (lazy loaded)."""
        if self._encoding is None:
            self._encoding = _get_encoding_for_model(self.model_id)
        return self._encoding

    @property
    def provider(self) -> str:
        """Get the detected provider for the model.

        Returns:
            Provider name: "openai", "anthropic", "google".

        Raises:
            ValueError: If model_type was not provided and cannot be resolved.
        """
        return detect_provider(self._model_type or self.model_id)

    def count_text(self, text: str) -> int:
        """Count tokens in a text string.

        Args:
            text: Text to count tokens for

        Returns:
            Token count
        """
        if not text:
            return 0

        return len(self.encoding.encode(text))

    def count_image(self, image_data: dict[str, Any] | str) -> int:
        """Count tokens for an image.

        Args:
            image_data: Image data (base64 string or dict with image_url)

        Returns:
            Token count for the image (approximate)
        """
        # Image token counts vary by resolution
        # OpenAI uses ~85 tokens for low-res, ~170 for high-res
        # We use 170 as a reasonable default
        return 170

    def count_message(self, message: dict[str, Any]) -> int:
        """Count tokens in a single message.

        Args:
            message: Message dictionary with role and content

        Returns:
            Token count (excluding per-message overhead)
        """
        return _count_tokens_for_messages(self.model_id, [message])

    def count_messages(self, messages: list[dict[str, Any]]) -> int:
        """Count total tokens in a list of messages.

        Args:
            messages: List of message dictionaries

        Returns:
            Total token count
        """
        return _count_tokens_for_messages(self.model_id, messages)

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
