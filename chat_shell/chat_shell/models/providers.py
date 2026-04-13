# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Provider detection utilities shared across the chat_shell package.

The ``model_type`` (e.g. ``"claude"``, ``"openai"``, ``"gemini"``) is the
authoritative source for provider detection because the same ``model_id``
can be served by multiple protocols (e.g. ``thudm-glm-5`` may support both
OpenAI and Anthropic protocols).

Modules that need provider detection should call :func:`detect_provider`
with the ``model_type`` value from the model configuration.
"""

# Mapping from model_type values (env.model) to canonical provider names.
# This is the authoritative mapping used by both the model factory and the
# compression pipeline.
PROVIDER_ALIASES: dict[str, str] = {
    "openai": "openai",
    "gpt": "openai",
    "o1": "openai",
    "o3": "openai",
    "chatgpt": "openai",
    "anthropic": "anthropic",
    "claude": "anthropic",
    "google": "google",
    "gemini": "google",
}


def detect_provider(model_type: str) -> str:
    """Detect the provider from model type.

    Args:
        model_type: The protocol / model type string (e.g. ``"claude"``,
            ``"openai"``, ``"gemini"``).  This is the authoritative source
            from the model configuration's ``model`` field.

    Returns:
        Canonical provider name: ``"openai"``, ``"anthropic"``, or ``"google"``.

    Raises:
        ValueError: If ``model_type`` is not recognized.
    """
    provider = PROVIDER_ALIASES.get(model_type.lower())
    if provider:
        return provider

    raise ValueError(
        f"Unknown model_type '{model_type}'. "
        f"Supported values: {', '.join(sorted(PROVIDER_ALIASES.keys()))}"
    )
