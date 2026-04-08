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

from .openai_reasoning import ChatOpenAIWithReasoning
from .providers import PROVIDER_ALIASES, detect_provider

logger = logging.getLogger(__name__)

# Allowed think_config keys per provider, mapped directly to constructor params.
# NOTE: Only keys that are safe as direct constructor params belong here.
# For openai, "reasoning" (dict) is NOT whitelisted because setting it as a
# direct ChatOpenAI param implicitly activates the Responses API format
# ("input" instead of "messages"), breaking OpenAI-compatible providers like
# OpenRouter.  Instead, "reasoning" falls through to extra_body, which merges
# it into the request body while keeping the Chat Completions format.
_PROVIDER_THINK_KEYS: dict[str, set[str]] = {
    "anthropic": {"thinking", "effort"},
    "openai": {"reasoning_effort"},
    "google": {"thinking_level", "thinking_budget", "include_thoughts"},
}


def _extract_think_params(provider: str, think_config: dict | None) -> dict:
    """Extract provider-specific thinking params from think_config.

    For known providers, only whitelisted keys are passed through.
    For OpenAI-compatible providers with unrecognized keys (e.g. Kimi's 'thinking'),
    extra keys are merged into 'extra_body' for passthrough.
    """
    if not think_config:
        return {}

    allowed = _PROVIDER_THINK_KEYS.get(provider, set())
    params: dict = {}
    extra_body: dict = {}

    for key, value in think_config.items():
        if key in allowed:
            params[key] = value
        elif provider == "openai" and key not in allowed:
            # Unknown keys for openai provider go into extra_body (e.g. Kimi thinking)
            extra_body[key] = value

    if extra_body:
        params["extra_body"] = extra_body

    return params


def _detect_provider(model_type: str, model_id: str) -> str:
    """Detect provider from model type.

    Delegates to the shared :func:`detect_provider`.  Falls back to
    ``"openai"`` when ``model_type`` is not recognized (common for
    OpenAI-compatible APIs).
    """
    try:
        return detect_provider(model_type)
    except ValueError:
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
                "temperature": kw.get("temperature"),
                "max_tokens": cfg.get("max_tokens"),
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
                "temperature": kw.get("temperature"),
                "max_tokens": cfg.get("max_tokens"),
                "streaming": kw.get("streaming", False),
                # Caching strategy:
                # - Automatic caching (top-level cache_control): available when
                #   the provider supports it (is_support_claude_automatic_caching).
                # - Explicit cache breakpoints: added to message content blocks
                #   by the MessageConverter when automatic caching is unavailable.
                "model_kwargs": {
                    "extra_headers": {
                        **(cfg.get("default_headers") or {}),
                    },
                    **(
                        {"cache_control": {"type": "ephemeral"}}
                        if cfg.get("is_support_claude_automatic_caching")
                        else {}
                    ),
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
                "temperature": kw.get("temperature"),
                "max_output_tokens": cfg.get("max_tokens"),
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
                - think_config: Optional provider-native thinking/reasoning params
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
            "max_tokens": model_config.get("max_output_tokens")
            or model_config.get("max_tokens"),
            "is_support_claude_automatic_caching": model_config.get(
                "is_support_claude_automatic_caching", False
            ),
        }
        model_type = model_config.get("model", "openai")
        think_config = model_config.get("think_config")

        # User-configured temperature from model env takes priority over kwargs
        config_temperature = model_config.get("temperature")
        if config_temperature is not None:
            kwargs["temperature"] = config_temperature

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

        # Apply thinking/reasoning configuration from think_config
        use_reasoning_wrapper = False
        if think_config:
            think_params = _extract_think_params(provider, think_config)
            if think_params:
                # For Anthropic: thinking mode requires temperature=1
                if provider == "anthropic" and "thinking" in think_params:
                    params["temperature"] = 1.0
                    logger.info("Anthropic thinking enabled: forcing temperature=1.0")

                # For OpenAI-compatible providers: use reasoning-aware subclass
                # to capture reasoning_content from non-standard deltas
                if provider == "openai":
                    use_reasoning_wrapper = True

                # Merge extra_body with existing extra_body if present
                if "extra_body" in think_params and "extra_body" in params:
                    params["extra_body"] = {
                        **params["extra_body"],
                        **think_params.pop("extra_body"),
                    }

                params.update(think_params)
                logger.info(
                    "Applied think_config for provider=%s: keys=%s",
                    provider,
                    list(think_params.keys()),
                )

        # Use ChatOpenAIWithReasoning for OpenAI providers with think_config
        # to capture reasoning_content from non-standard API responses
        model_class = provider_cfg["class"]
        if use_reasoning_wrapper and model_class is ChatOpenAI:
            model_class = ChatOpenAIWithReasoning

        add_span_event("instantiating_model_class", {"class": model_class.__name__})
        model = model_class(**params)
        add_span_event("model_instance_created")

        # Attach provider metadata for downstream think-block normalization.
        # These are read by LangGraphAgentBuilder to tag serialized messages
        # with model_info, enabling cross-model think-block filtering.
        model._wegent_provider = provider  # type: ignore[attr-defined]
        model._wegent_model_id = cfg["model_id"]  # type: ignore[attr-defined]
        model._wegent_api_format = cfg.get("api_format") or ""  # type: ignore[attr-defined]

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
                "model": PROVIDER_ALIASES.get(
                    model_name.split("-")[0].lower(), "openai"
                ),
                "api_key": api_key,
                "base_url": base_url or "",
            },
            **kwargs,
        )

    @staticmethod
    def get_provider(model_id: str) -> str | None:
        """Get provider name for a model ID.

        Uses the model_id prefix (e.g. ``"gpt-"`` -> ``"openai"``) as a
        convenience lookup.  For accurate detection, prefer
        :func:`detect_provider` with ``model_type``.

        Args:
            model_id: Model identifier

        Returns:
            Provider name ("openai", "anthropic", "google") or None if unknown
        """
        prefix = model_id.split("-")[0].lower()
        return PROVIDER_ALIASES.get(prefix)

    @classmethod
    def is_supported(cls, model_id: str) -> bool:
        """Check if model is supported by any provider."""
        return cls.get_provider(model_id) is not None
