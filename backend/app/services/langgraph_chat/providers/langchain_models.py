# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""LangChain model wrappers for providers.

NOTE: This module is deprecated. Use app.services.langgraph_chat.models.LangChainModelFactory instead.
The new model factory uses database-based model configuration.
"""

import warnings

from langchain_anthropic import ChatAnthropic
from langchain_core.language_models import BaseChatModel
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_openai import ChatOpenAI


class LangChainModelFactory:
    """Factory for creating LangChain chat model instances.

    DEPRECATED: Use app.services.langgraph_chat.models.LangChainModelFactory instead.
    That implementation uses database-based model configuration.
    """

    @staticmethod
    def create_model(
        model: str,
        api_key: str | None = None,
        base_url: str | None = None,
        **kwargs,
    ) -> BaseChatModel:
        """Create LangChain model instance based on model name.

        DEPRECATED: Use models.LangChainModelFactory.create_from_config() instead.

        Args:
            model: Model identifier (gpt-4o, claude-3-5-sonnet, gemini-2.0-flash, etc.)
            api_key: API key (required, no longer auto-resolved from config)
            base_url: Optional base URL for OpenAI-compatible APIs
            **kwargs: Additional parameters (temperature, max_tokens, etc.)

        Returns:
            BaseChatModel instance

        Raises:
            ValueError: If model provider is not supported or API key missing
        """
        warnings.warn(
            "LangChainModelFactory from providers is deprecated. "
            "Use app.services.langgraph_chat.models.LangChainModelFactory instead.",
            DeprecationWarning,
            stacklevel=2,
        )

        if not api_key:
            raise ValueError("API key is required. Use create_from_config() instead.")

        model_lower = model.lower()

        # OpenAI models
        if any(prefix in model_lower for prefix in ["gpt-", "o1-", "o3-"]):
            return ChatOpenAI(
                model=model,
                api_key=api_key,
                base_url=base_url,
                temperature=kwargs.get("temperature", 1.0),
                max_tokens=kwargs.get("max_tokens"),
                streaming=kwargs.get("streaming", False),
            )

        # Anthropic models
        elif any(prefix in model_lower for prefix in ["claude-"]):
            return ChatAnthropic(
                model=model,
                api_key=api_key,
                temperature=kwargs.get("temperature", 1.0),
                max_tokens=kwargs.get("max_tokens", 4096),
                streaming=kwargs.get("streaming", False),
            )

        # Google models
        elif any(prefix in model_lower for prefix in ["gemini-"]):
            return ChatGoogleGenerativeAI(
                model=model,
                google_api_key=api_key,
                temperature=kwargs.get("temperature", 1.0),
                max_tokens=kwargs.get("max_tokens"),
                streaming=kwargs.get("streaming", False),
            )

        else:
            raise ValueError(f"Unsupported model: {model}")

    @staticmethod
    def is_supported(model: str) -> bool:
        """Check if model is supported.

        Args:
            model: Model identifier

        Returns:
            True if supported, False otherwise
        """
        model_lower = model.lower()
        supported_prefixes = ["gpt-", "o1-", "o3-", "claude-", "gemini-"]
        return any(prefix in model_lower for prefix in supported_prefixes)
