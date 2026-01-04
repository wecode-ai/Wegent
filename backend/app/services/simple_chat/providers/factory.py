# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""LLM Provider factory for Simple Chat."""

import logging
from typing import Any, Dict

import httpx

from app.services.simple_chat.providers.base import LLMProvider, ProviderConfig
from app.services.simple_chat.providers.claude import ClaudeProvider
from app.services.simple_chat.providers.gemini import GeminiProvider
from app.services.simple_chat.providers.openai import OpenAIProvider

logger = logging.getLogger(__name__)


def get_provider(
    model_config: Dict[str, Any],
    client: httpx.AsyncClient,
) -> LLMProvider:
    """
    Create an LLM provider based on model configuration.

    Args:
        model_config: Model configuration dictionary containing:
            - model: Provider type ('openai', 'claude', 'gemini')
            - api_key: API key
            - base_url: API base URL
            - model_id: Model identifier
            - default_headers: Optional custom headers
        client: Shared HTTP client

    Returns:
        LLMProvider instance

    Raises:
        ValueError: If provider type is unknown
    """
    model_type = model_config.get("model", "openai")

    config = ProviderConfig(
        api_key=model_config.get("api_key", ""),
        base_url=model_config.get("base_url", ""),
        model_id=model_config.get("model_id", "gpt-4"),
        default_headers=model_config.get("default_headers", {}),
    )

    if model_type == "claude":
        logger.debug("Creating Claude provider for model %s", config.model_id)
        return ClaudeProvider(config, client)
    elif model_type == "gemini":
        logger.debug("Creating Gemini provider for model %s", config.model_id)
        return GeminiProvider(config, client)
    else:
        # Default to OpenAI-compatible
        logger.debug("Creating OpenAI provider for model %s", config.model_id)
        return OpenAIProvider(config, client)
