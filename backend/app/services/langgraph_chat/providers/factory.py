# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""LLM provider factory.

NOTE: This module is deprecated. Use app.services.langgraph_chat.models.LangChainModelFactory instead.
The new model factory uses database-based model configuration.
"""

import warnings

from .anthropic_provider import AnthropicProvider
from .base import BaseLLMProvider
from .google_provider import GoogleProvider
from .openai_provider import OpenAIProvider


class ProviderFactory:
    """Factory for creating LLM providers.

    DEPRECATED: Use LangChainModelFactory with database-resolved model config instead.
    """

    _provider_map = {
        "openai": OpenAIProvider,
        "anthropic": AnthropicProvider,
        "google": GoogleProvider,
    }

    @classmethod
    def create_provider(
        cls,
        model: str,
        api_key: str | None = None,
        base_url: str | None = None,
        **kwargs,
    ) -> BaseLLMProvider:
        """Create LLM provider based on model name.

        DEPRECATED: Use LangChainModelFactory.create_from_config() instead.

        Args:
            model: Model identifier (e.g., gpt-4o, claude-3-5-sonnet, gemini-2.0-flash)
            api_key: API key (required, no longer auto-resolved from config)
            base_url: Optional base URL override
            **kwargs: Additional provider-specific parameters

        Returns:
            BaseLLMProvider instance

        Raises:
            ValueError: If provider cannot be determined or API key not provided
        """
        warnings.warn(
            "ProviderFactory is deprecated. Use LangChainModelFactory.create_from_config() instead.",
            DeprecationWarning,
            stacklevel=2,
        )

        provider_type = cls._detect_provider_type(model)

        if provider_type not in cls._provider_map:
            raise ValueError(f"Unknown provider for model: {model}")

        if not api_key:
            raise ValueError(f"API key is required for provider: {provider_type}")

        provider_class = cls._provider_map[provider_type]
        return provider_class(model=model, api_key=api_key, base_url=base_url, **kwargs)

    @classmethod
    def _detect_provider_type(cls, model: str) -> str:
        """Detect provider type from model name.

        Args:
            model: Model identifier

        Returns:
            Provider type string
        """
        model_lower = model.lower()

        if any(prefix in model_lower for prefix in ["gpt-", "o1-", "text-embedding"]):
            return "openai"
        elif any(prefix in model_lower for prefix in ["claude-", "anthropic"]):
            return "anthropic"
        elif any(prefix in model_lower for prefix in ["gemini-", "palm-", "bison"]):
            return "google"

        raise ValueError(f"Cannot detect provider from model name: {model}")
