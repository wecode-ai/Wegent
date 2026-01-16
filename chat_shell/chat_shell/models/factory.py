# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""LangChain model factory for creating provider-specific chat models.

This module creates LangChain chat model instances based on model configuration
retrieved from the database, supporting OpenAI, Anthropic, and Google providers.

Usage:
    from .models import LangChainModelFactory
    llm = LangChainModelFactory.create_from_config(model_config)
"""

import logging
from typing import Any

from langchain_anthropic import ChatAnthropic
from langchain_core.language_models import BaseChatModel
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_openai import ChatOpenAI
from shared.telemetry.decorators import add_span_event, trace_sync

logger = logging.getLogger(__name__)

# Provider detection: (prefixes, provider_name)
_PROVIDER_PATTERNS = [
    (("gpt-", "o1-", "o3-", "chatgpt-"), "openai"),
    (("claude-",), "anthropic"),
    (("gemini-",), "google"),
]

# Provider type aliases
_PROVIDER_ALIASES = {
    "openai": "openai",
    "gpt": "openai",
    "anthropic": "anthropic",
    "claude": "anthropic",
    "google": "google",
    "gemini": "google",
}


def _detect_provider(model_type: str, model_id: str) -> str:
    """Detect provider from model type or model ID."""
    # Check model_type alias first
    if provider := _PROVIDER_ALIASES.get(model_type.lower()):
        return provider

    # Fall back to model_id prefix detection
    model_lower = model_id.lower()
    for prefixes, provider in _PROVIDER_PATTERNS:
        if any(model_lower.startswith(p.lower()) for p in prefixes):
            return provider

    # Default to OpenAI for unknown models (common for OpenAI-compatible APIs)
    logger.warning(
        "Unknown provider for %s/%s, defaulting to OpenAI", model_type, model_id
    )
    return "openai"


def _mask_api_key(api_key: str) -> str:
    """Mask API key for logging."""
    if len(api_key) > 12:
        return f"{api_key[:8]}...{api_key[-4:]}"
    return "***" if api_key else "EMPTY"


class LangChainModelFactory:
    """Factory for creating LangChain chat model instances from model config.

    Supported providers:
    - OpenAI (gpt-*, o1-*, o3-*, chatgpt-*)
    - Anthropic (claude-*)
    - Google (gemini-*)
    """

    # Provider-specific model classes and their parameter mappings
    _PROVIDER_CONFIG = {
        "openai": {
            "class": ChatOpenAI,
            "params": lambda cfg, kw: {
                "model": cfg["model_id"],
                "api_key": cfg["api_key"],
                "base_url": cfg.get("base_url") or None,
                "temperature": kw.get("temperature", 1.0),
                "max_tokens": kw.get("max_tokens"),
                "streaming": kw.get("streaming", False),
                "model_kwargs": (
                    {"extra_headers": cfg.get("default_headers")}
                    if cfg.get("default_headers")
                    else None
                ),
                # Enable Responses API when api_format is "responses"
                "use_responses_api": cfg.get("api_format") == "responses" or None,
                # Include reasoning.encrypted_content for Responses API to properly handle
                # multi-turn conversations with reasoning models (e.g., GPT-5.x)
                # Without this, the server returns "unrecognized reasoning ID" errors
                "include": (
                    ["reasoning.encrypted_content"]
                    if cfg.get("api_format") == "responses"
                    else None
                ),
            },
        },
        "anthropic": {
            "class": ChatAnthropic,
            "params": lambda cfg, kw: {
                "model": cfg["model_id"],
                # Anthropic client requires api_key. If missing but using custom base_url (proxy),
                # provide dummy key to pass validation.
                "api_key": (
                    cfg["api_key"]
                    if cfg["api_key"]
                    else ("dummy" if cfg.get("base_url") else None)
                ),
                "anthropic_api_url": cfg.get("base_url") or None,
                "temperature": kw.get("temperature", 1.0),
                "max_tokens": kw.get("max_tokens", 4096),
                "streaming": kw.get("streaming", False),
                # Enable prompt caching for Anthropic models (90% cost reduction on cached tokens)
                # Merge user-provided headers with the prompt-caching beta header
                "model_kwargs": {
                    "extra_headers": {
                        **(cfg.get("default_headers") or {}),
                    }
                },
            },
        },
        "google": {
            "class": ChatGoogleGenerativeAI,
            "params": lambda cfg, kw: {
                "model": cfg["model_id"],
                # Google client requires api_key. If missing but using custom base_url (proxy),
                # provide dummy key to pass validation.
                "google_api_key": (
                    cfg["api_key"]
                    if cfg["api_key"]
                    else ("dummy" if cfg.get("base_url") else None)
                ),
                "base_url": cfg.get("base_url") or None,
                "temperature": kw.get("temperature", 1.0),
                "max_output_tokens": kw.get("max_tokens"),
                "streaming": kw.get("streaming", False),
                "additional_headers": cfg.get("default_headers") or None,
            },
        },
    }

    @classmethod
    @trace_sync(
        span_name="model_factory.create_from_config",
        tracer_name="chat_shell.models",
        extract_attributes=lambda cls, model_config, **kwargs: {
            "model.model_id": model_config.get("model_id", "unknown"),
            "model.provider": model_config.get("model", "openai"),
            "model.streaming": kwargs.get("streaming", False),
        },
    )
    def create_from_config(
        cls, model_config: dict[str, Any], **kwargs
    ) -> BaseChatModel:
        """Create LangChain model instance from database model configuration.

        Args:
            model_config: Model configuration dict with keys:
                - model_id: Model identifier (e.g., "gpt-4", "claude-3-sonnet")
                - model: Provider type hint (e.g., "openai", "anthropic")
                - api_key: API key for the provider
                - base_url: Optional custom API endpoint
                - default_headers: Optional custom headers
                - api_format: Optional API format for OpenAI ("chat/completions" or "responses")
                - max_output_tokens: Optional max output tokens from Model CRD spec
            **kwargs: Additional parameters (temperature, max_tokens, streaming)

        Returns:
            BaseChatModel instance ready for use with LangChain/LangGraph
        """
        # Extract config with defaults
        add_span_event("extracting_config")
        cfg = {
            "model_id": model_config.get("model_id", "gpt-4"),
            "api_key": model_config.get("api_key", ""),
            "base_url": model_config.get("base_url", ""),
            "default_headers": model_config.get("default_headers"),
            "api_format": model_config.get("api_format"),
        }
        model_type = model_config.get("model", "openai")

        # Log API format if using Responses API
        api_format_log = ""
        if cfg.get("api_format") == "responses":
            api_format_log = ", api_format=responses"

        logger.debug(
            "Creating LangChain model: %s, type=%s, key=%s%s",
            cfg["model_id"],
            model_type,
            _mask_api_key(cfg["api_key"]),
            api_format_log,
        )

        add_span_event("detecting_provider")
        provider = _detect_provider(model_type, cfg["model_id"])
        provider_cfg = cls._PROVIDER_CONFIG.get(provider)

        if not provider_cfg:
            raise ValueError(f"Unsupported model provider: {provider}")

        # Build params and create model instance
        add_span_event("building_params", {"provider": provider})
        params = provider_cfg["params"](cfg, kwargs)
        # Filter out None values to use defaults
        params = {k: v for k, v in params.items() if v is not None}

        add_span_event(
            "instantiating_model_class", {"class": provider_cfg["class"].__name__}
        )
        model = provider_cfg["class"](**params)
        add_span_event("model_instance_created")
        return model

    @classmethod
    def create_from_name(
        cls, model_name: str, api_key: str, base_url: str | None = None, **kwargs
    ) -> BaseChatModel:
        """Create LangChain model instance from model name directly.

        Args:
            model_name: Model identifier (provider auto-detected from name)
            api_key: API key for the provider
            base_url: Optional custom API endpoint
            **kwargs: Additional parameters

        Returns:
            BaseChatModel instance
        """
        return cls.create_from_config(
            {
                "model_id": model_name,
                "model": _detect_provider("", model_name),
                "api_key": api_key,
                "base_url": base_url or "",
            },
            **kwargs,
        )

    @staticmethod
    def get_provider(model_id: str) -> str | None:
        """Get provider name for a model ID.

        Args:
            model_id: Model identifier

        Returns:
            Provider name ("openai", "anthropic", "google") or None if unknown
        """
        model_lower = model_id.lower()
        for prefixes, provider in _PROVIDER_PATTERNS:
            if any(model_lower.startswith(p.lower()) for p in prefixes):
                return provider
        return None

    @classmethod
    def is_supported(cls, model_id: str) -> bool:
        """Check if model is supported by any provider."""
        return cls.get_provider(model_id) is not None
