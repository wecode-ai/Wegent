# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Token counting utilities for message compression.

This module provides token counting functionality using LiteLLM for unified
multi-model support. LiteLLM automatically selects the appropriate tokenizer
based on the model and defaults to tiktoken if no model-specific tokenizer
is available.

Supported providers:
- OpenAI (GPT-4, GPT-4o, o1, o3, etc.)
- Anthropic (Claude)
- Google (Gemini)
- GLM (ChatGLM)
- And 100+ other models via LiteLLM
"""

import logging
from typing import Any

from litellm import token_counter as litellm_token_counter

logger = logging.getLogger(__name__)


def _detect_provider(model_id: str) -> str:
    """Detect the provider based on model identifier.

    Args:
        model_id: Model identifier string

    Returns:
        Provider name: "openai", "anthropic", "google", or "unknown"
    """
    model_id_lower = model_id.lower()

    # Anthropic models
    if any(prefix in model_id_lower for prefix in ["claude", "anthropic"]):
        return "anthropic"

    # Google models
    if any(prefix in model_id_lower for prefix in ["gemini", "palm", "bison"]):
        return "google"

    # OpenAI models (most gpt-*, o1*, o3* patterns)
    if any(prefix in model_id_lower for prefix in ["gpt-", "o1", "o3"]):
        return "openai"

    # Default to unknown if no pattern matches
    return "unknown"


class TokenCounter:
    """Token counter for various model providers using LiteLLM.

    LiteLLM provides unified token counting across 100+ LLM models,
    automatically selecting the appropriate tokenizer for each model.
    Supports text, images, and multimodal content.

    Usage:
        counter = TokenCounter(model_id="gpt-4o")
        token_count = counter.count_messages(messages)
    """

    def __init__(self, model_name: str | None = None, model_id: str | None = None):
        """Initialize token counter.

        Args:
            model_name: Model identifier for provider detection (preferred)
            model_id: Deprecated alias for model_name (for backward compatibility)
        """
        self.model_id = model_id or model_name or "gpt-4"

    @property
    def provider(self) -> str:
        """Get the detected provider for the model.

        Returns:
            Provider name: "openai", "anthropic", "google", or "unknown"
        """
        return _detect_provider(self.model_id)

    def count_text(self, text: str) -> int:
        """Count tokens in a text string.

        Args:
            text: Text to count tokens for

        Returns:
            Token count
        """
        if not text:
            return 0

        return litellm_token_counter(
            model=self.model_id,
            messages=[{"role": "user", "content": text}],
        )

    def count_image(self, image_data: dict[str, Any] | str) -> int:
        """Count tokens for an image.

        Args:
            image_data: Image data (base64 string or dict with image_url)

        Returns:
            Token count for the image
        """
        # Build image_url content for LiteLLM
        if isinstance(image_data, str):
            # Base64 string - wrap in image_url format
            content = [{"type": "image_url", "image_url": {"url": image_data}}]
        elif isinstance(image_data, dict):
            # Already in dict format
            if "image_url" in image_data:
                content = [image_data]
            elif "type" in image_data:
                content = [image_data]
            else:
                content = [{"type": "image_url", "image_url": image_data}]
        else:
            raise ValueError(f"Unsupported image_data type: {type(image_data)}")

        return litellm_token_counter(
            model=self.model_id,
            messages=[{"role": "user", "content": content}],
        )

    def count_message(self, message: dict[str, Any]) -> int:
        """Count tokens in a single message.

        Args:
            message: Message dictionary with role and content

        Returns:
            Token count (excluding per-message overhead)
        """
        return litellm_token_counter(model=self.model_id, messages=[message])

    def count_messages(self, messages: list[dict[str, Any]]) -> int:
        """Count total tokens in a list of messages.

        Args:
            messages: List of message dictionaries

        Returns:
            Total token count
        """
        return litellm_token_counter(model=self.model_id, messages=messages)

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
