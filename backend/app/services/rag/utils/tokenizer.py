# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Token calculation utility using embedding model's tokenizer.
"""

from functools import lru_cache
from typing import Callable, List

import tiktoken


@lru_cache(maxsize=10)
def get_tokenizer_for_model(model_name: str) -> Callable[[str], List[int]]:
    """
    Get tokenizer for embedding model (with cache).

    Args:
        model_name: Name of the embedding model

    Returns:
        Tokenizer encode function
    """
    model_lower = model_name.lower()

    # OpenAI text-embedding series
    if "text-embedding" in model_lower or "ada" in model_lower:
        return tiktoken.encoding_for_model("text-embedding-ada-002").encode

    # OpenAI GPT series
    if any(x in model_lower for x in ["gpt-4", "gpt-3.5", "turbo"]):
        return tiktoken.get_encoding("cl100k_base").encode

    # Default to cl100k_base for other models (Claude, etc.)
    return tiktoken.get_encoding("cl100k_base").encode


def count_tokens(text: str, model_name: str = "cl100k_base") -> int:
    """
    Count tokens in text using model's tokenizer.

    Args:
        text: Text to count tokens for
        model_name: Name of the embedding model

    Returns:
        Number of tokens
    """
    if not text:
        return 0
    tokenizer = get_tokenizer_for_model(model_name)
    return len(tokenizer(text))
