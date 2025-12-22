# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""LangChain model factory for creating provider-specific chat models.

This module creates LangChain chat model instances based on model configuration
retrieved from the database, supporting OpenAI, Anthropic, and Google providers.
"""

import logging
from typing import Any

from langchain_anthropic import ChatAnthropic
from langchain_core.language_models import BaseChatModel
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_openai import ChatOpenAI

logger = logging.getLogger(__name__)

# Model provider detection patterns
_OPENAI_PREFIXES = ("gpt-", "o1-", "o3-", "chatgpt-")
_ANTHROPIC_PREFIXES = ("claude-",)
_GOOGLE_PREFIXES = ("gemini-",)


class LangChainModelFactory:
    """Factory for creating LangChain chat model instances from model config."""

    @staticmethod
    def create_from_config(
        model_config: dict[str, Any],
        **kwargs,
    ) -> BaseChatModel:
        """
        Create LangChain model instance from database model configuration.

        This is the primary method for creating models, using the model config
        retrieved from the database (via ModelResolver).

        Args:
            model_config: Model configuration from database containing:
                - api_key: Decrypted API key
                - base_url: API base URL
                - model_id: Model identifier (e.g., "gpt-4o")
                - model: Provider type ("openai", "claude", "gemini")
                - default_headers: Optional custom headers
            **kwargs: Additional parameters (temperature, max_tokens, etc.)

        Returns:
            BaseChatModel instance

        Raises:
            ValueError: If model provider is not supported
        """
        model_id = model_config.get("model_id", "gpt-4")
        model_type = model_config.get("model", "openai").lower()
        api_key = model_config.get("api_key", "")
        base_url = model_config.get("base_url", "")
        default_headers = model_config.get("default_headers", {})

        # Log model creation (mask API key)
        masked_key = (
            f"{api_key[:8]}...{api_key[-4:]}"
            if api_key and len(api_key) > 12
            else ("***" if api_key else "EMPTY")
        )
        logger.info(
            f"Creating LangChain model: model_id={model_id}, type={model_type}, "
            f"api_key={masked_key}, base_url={base_url}"
        )

        # Determine provider from model_type or model_id
        provider = LangChainModelFactory._detect_provider(model_type, model_id)

        if provider == "openai":
            return LangChainModelFactory._create_openai_model(
                model_id=model_id,
                api_key=api_key,
                base_url=base_url,
                default_headers=default_headers,
                **kwargs,
            )
        elif provider == "anthropic":
            return LangChainModelFactory._create_anthropic_model(
                model_id=model_id,
                api_key=api_key,
                base_url=base_url,
                default_headers=default_headers,
                **kwargs,
            )
        elif provider == "google":
            return LangChainModelFactory._create_google_model(
                model_id=model_id,
                api_key=api_key,
                **kwargs,
            )
        else:
            raise ValueError(f"Unsupported model provider: {provider}")

    @staticmethod
    def create_from_name(
        model_name: str,
        api_key: str,
        base_url: str | None = None,
        **kwargs,
    ) -> BaseChatModel:
        """
        Create LangChain model instance from model name directly.

        This is a simpler method for cases where you have the API key
        and just need to create a model by name.

        Args:
            model_name: Model identifier (e.g., "gpt-4o", "claude-3-5-sonnet")
            api_key: API key for the provider
            base_url: Optional custom base URL
            **kwargs: Additional parameters

        Returns:
            BaseChatModel instance

        Raises:
            ValueError: If model provider is not supported
        """
        model_config = {
            "model_id": model_name,
            "model": LangChainModelFactory._detect_provider("", model_name),
            "api_key": api_key,
            "base_url": base_url or "",
        }
        return LangChainModelFactory.create_from_config(model_config, **kwargs)

    @staticmethod
    def _detect_provider(model_type: str, model_id: str) -> str:
        """Detect provider from model type or model ID."""
        # First check model_type if provided
        model_type_lower = model_type.lower()
        if model_type_lower in ("openai", "gpt"):
            return "openai"
        elif model_type_lower in ("anthropic", "claude"):
            return "anthropic"
        elif model_type_lower in ("google", "gemini"):
            return "google"

        # Fall back to model_id detection
        model_id_lower = model_id.lower()
        if any(prefix in model_id_lower for prefix in _OPENAI_PREFIXES):
            return "openai"
        elif any(prefix in model_id_lower for prefix in _ANTHROPIC_PREFIXES):
            return "anthropic"
        elif any(prefix in model_id_lower for prefix in _GOOGLE_PREFIXES):
            return "google"

        # Default to OpenAI for unknown models (common for OpenAI-compatible APIs)
        logger.warning(
            f"Could not detect provider for model_type={model_type}, "
            f"model_id={model_id}, defaulting to OpenAI"
        )
        return "openai"

    @staticmethod
    def _create_openai_model(
        model_id: str,
        api_key: str,
        base_url: str,
        default_headers: dict[str, Any] | None = None,
        **kwargs,
    ) -> ChatOpenAI:
        """Create OpenAI chat model instance."""
        model_kwargs = {}

        # Add default headers if provided
        if default_headers:
            model_kwargs["extra_headers"] = default_headers

        return ChatOpenAI(
            model=model_id,
            api_key=api_key,
            base_url=base_url if base_url else None,
            temperature=kwargs.get("temperature", 1.0),
            max_tokens=kwargs.get("max_tokens"),
            streaming=kwargs.get("streaming", False),
            model_kwargs=model_kwargs if model_kwargs else None,
        )

    @staticmethod
    def _create_anthropic_model(
        model_id: str,
        api_key: str,
        base_url: str,
        default_headers: dict[str, Any] | None = None,
        **kwargs,
    ) -> ChatAnthropic:
        """Create Anthropic chat model instance."""
        model_kwargs = {}

        # Add default headers if provided
        if default_headers:
            model_kwargs["extra_headers"] = default_headers

        # Anthropic requires max_tokens
        max_tokens = kwargs.get("max_tokens", 4096)

        return ChatAnthropic(
            model=model_id,
            api_key=api_key,
            anthropic_api_url=base_url if base_url else None,
            temperature=kwargs.get("temperature", 1.0),
            max_tokens=max_tokens,
            streaming=kwargs.get("streaming", False),
            model_kwargs=model_kwargs if model_kwargs else None,
        )

    @staticmethod
    def _create_google_model(
        model_id: str,
        api_key: str,
        **kwargs,
    ) -> ChatGoogleGenerativeAI:
        """Create Google Generative AI chat model instance."""
        return ChatGoogleGenerativeAI(
            model=model_id,
            google_api_key=api_key,
            temperature=kwargs.get("temperature", 1.0),
            max_tokens=kwargs.get("max_tokens"),
            streaming=kwargs.get("streaming", False),
        )

    @staticmethod
    def is_supported(model_id: str) -> bool:
        """Check if model is supported.

        Args:
            model_id: Model identifier

        Returns:
            True if supported, False otherwise
        """
        model_lower = model_id.lower()
        all_prefixes = _OPENAI_PREFIXES + _ANTHROPIC_PREFIXES + _GOOGLE_PREFIXES
        return any(prefix in model_lower for prefix in all_prefixes)

    @staticmethod
    def get_provider(model_id: str) -> str | None:
        """Get provider name for a model ID.

        Args:
            model_id: Model identifier

        Returns:
            Provider name or None if not recognized
        """
        model_lower = model_id.lower()
        if any(prefix in model_lower for prefix in _OPENAI_PREFIXES):
            return "openai"
        elif any(prefix in model_lower for prefix in _ANTHROPIC_PREFIXES):
            return "anthropic"
        elif any(prefix in model_lower for prefix in _GOOGLE_PREFIXES):
            return "google"
        return None
