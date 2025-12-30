# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Configuration for message compression.

This module defines model context limits and compression configurations.
"""

from dataclasses import dataclass


@dataclass
class ModelContextConfig:
    """Configuration for a specific model's context limits.

    Attributes:
        context_window: Maximum context window size in tokens
        output_tokens: Reserved tokens for model output
        safety_margin: Percentage of context window to use (0.0-1.0)
    """

    context_window: int
    output_tokens: int = 4096
    safety_margin: float = 0.90  # Use 90% of context window

    @property
    def effective_limit(self) -> int:
        """Calculate effective token limit after safety margin and output reservation."""
        return int((self.context_window - self.output_tokens) * self.safety_margin)


@dataclass
class CompressionConfig:
    """Configuration for compression behavior.

    Attributes:
        enabled: Whether compression is enabled
        default_context_window: Default context window for unknown models
        first_messages_to_keep: Number of first messages to always keep
        last_messages_to_keep: Number of last messages to always keep
        attachment_truncate_length: Maximum length for attachment text after truncation
        min_attachment_length: Minimum attachment length before considering truncation
    """

    enabled: bool = True
    default_context_window: int = 128000
    first_messages_to_keep: int = 2  # Keep system prompt + first user message
    last_messages_to_keep: int = 10  # Keep recent context
    attachment_truncate_length: int = 50000  # Truncate attachments to this length
    min_attachment_length: int = 10000  # Don't truncate if shorter than this

    @classmethod
    def from_settings(cls) -> "CompressionConfig":
        """Create CompressionConfig from application settings."""
        from app.core.config import settings

        return cls(
            enabled=settings.MESSAGE_COMPRESSION_ENABLED,
            first_messages_to_keep=settings.MESSAGE_COMPRESSION_FIRST_MESSAGES,
            last_messages_to_keep=settings.MESSAGE_COMPRESSION_LAST_MESSAGES,
            attachment_truncate_length=settings.MESSAGE_COMPRESSION_ATTACHMENT_LENGTH,
        )


# Model context limits based on provider documentation
# Reference: https://docs.anthropic.com/claude/docs/models-overview
# Reference: https://platform.openai.com/docs/models
# Reference: https://ai.google.dev/models/gemini
MODEL_CONTEXT_LIMITS: dict[str, ModelContextConfig] = {
    # Anthropic Claude models
    "claude-3-5-sonnet": ModelContextConfig(context_window=200000, output_tokens=8192),
    "claude-3-5-haiku": ModelContextConfig(context_window=200000, output_tokens=8192),
    "claude-3-opus": ModelContextConfig(context_window=200000, output_tokens=4096),
    "claude-3-sonnet": ModelContextConfig(context_window=200000, output_tokens=4096),
    "claude-3-haiku": ModelContextConfig(context_window=200000, output_tokens=4096),
    "claude-sonnet-4": ModelContextConfig(context_window=200000, output_tokens=64000),
    "claude-opus-4": ModelContextConfig(context_window=200000, output_tokens=32000),
    # OpenAI GPT models
    "gpt-4o": ModelContextConfig(context_window=128000, output_tokens=16384),
    "gpt-4o-mini": ModelContextConfig(context_window=128000, output_tokens=16384),
    "gpt-4-turbo": ModelContextConfig(context_window=128000, output_tokens=4096),
    "gpt-4": ModelContextConfig(context_window=8192, output_tokens=4096),
    "gpt-3.5-turbo": ModelContextConfig(context_window=16385, output_tokens=4096),
    "o1": ModelContextConfig(context_window=200000, output_tokens=100000),
    "o1-mini": ModelContextConfig(context_window=128000, output_tokens=65536),
    "o1-preview": ModelContextConfig(context_window=128000, output_tokens=32768),
    "o3": ModelContextConfig(context_window=200000, output_tokens=100000),
    "o3-mini": ModelContextConfig(context_window=200000, output_tokens=100000),
    # Google Gemini models
    "gemini-1.5-pro": ModelContextConfig(context_window=2097152, output_tokens=8192),
    "gemini-1.5-flash": ModelContextConfig(context_window=1048576, output_tokens=8192),
    "gemini-2.0-flash": ModelContextConfig(context_window=1048576, output_tokens=8192),
    "gemini-pro": ModelContextConfig(context_window=30720, output_tokens=2048),
}


def get_model_context_config(model_id: str) -> ModelContextConfig:
    """Get context configuration for a model.

    Args:
        model_id: Model identifier (e.g., "claude-3-5-sonnet-20241022")

    Returns:
        ModelContextConfig for the model
    """
    model_lower = model_id.lower()

    # Try exact match first
    if model_lower in MODEL_CONTEXT_LIMITS:
        return MODEL_CONTEXT_LIMITS[model_lower]

    # Try prefix matching (handles versioned model names)
    for prefix, config in MODEL_CONTEXT_LIMITS.items():
        if model_lower.startswith(prefix):
            return config

    # Default config for unknown models (conservative estimate)
    return ModelContextConfig(
        context_window=128000,
        output_tokens=4096,
        safety_margin=0.85,  # More conservative for unknown models
    )
