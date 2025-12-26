# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Default context limits for common LLM models.

These values represent the maximum context window size in tokens
for various LLM models. When a model is not explicitly configured
with a context limit, these defaults are used.
"""

# Default context limits (in tokens) for common models
DEFAULT_CONTEXT_LIMITS: dict[str, int] = {
    # Anthropic Claude models
    "claude-3-5-sonnet-20241022": 200000,
    "claude-3-5-haiku-20241022": 200000,
    "claude-3-opus-20240229": 200000,
    "claude-3-sonnet-20240229": 200000,
    "claude-3-haiku-20240307": 200000,
    "claude-sonnet-4-20250514": 200000,
    "claude-opus-4-20250514": 200000,
    # OpenAI GPT models
    "gpt-4-turbo": 128000,
    "gpt-4-turbo-preview": 128000,
    "gpt-4o": 128000,
    "gpt-4o-mini": 128000,
    "gpt-4": 8192,
    "gpt-4-32k": 32768,
    "gpt-3.5-turbo": 16385,
    "gpt-3.5-turbo-16k": 16385,
    # DeepSeek models
    "deepseek-chat": 64000,
    "deepseek-coder": 64000,
    "deepseek-reasoner": 64000,
    # Google models
    "gemini-pro": 32000,
    "gemini-1.5-pro": 1000000,
    "gemini-1.5-flash": 1000000,
    # Default fallback
    "default": 8192,
}

# Default ratio of context tokens reserved for output
DEFAULT_RESERVED_OUTPUT_RATIO = 0.2


def get_default_context_limit(model_name: str) -> int:
    """Get the default context limit for a model.

    Performs prefix matching to handle model name variants.

    Args:
        model_name: The model name (e.g., "claude-3-5-sonnet-20241022")

    Returns:
        The context limit in tokens
    """
    # Direct match first
    if model_name in DEFAULT_CONTEXT_LIMITS:
        return DEFAULT_CONTEXT_LIMITS[model_name]

    # Prefix matching for model families
    model_lower = model_name.lower()

    # Anthropic Claude
    if model_lower.startswith("claude"):
        # Default for Claude models is 200k
        return 200000

    # OpenAI GPT-4
    if model_lower.startswith("gpt-4o"):
        return 128000
    if model_lower.startswith("gpt-4-turbo"):
        return 128000
    if model_lower.startswith("gpt-4-32k"):
        return 32768
    if model_lower.startswith("gpt-4"):
        return 8192

    # OpenAI GPT-3.5
    if model_lower.startswith("gpt-3.5"):
        return 16385

    # DeepSeek
    if model_lower.startswith("deepseek"):
        return 64000

    # Google Gemini
    if model_lower.startswith("gemini-1.5"):
        return 1000000
    if model_lower.startswith("gemini"):
        return 32000

    # Default fallback
    return DEFAULT_CONTEXT_LIMITS["default"]
