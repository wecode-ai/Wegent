# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Embedding model factory.
"""

from app.services.rag.embedding.custom import CustomEmbedding


def create_embedding_model(config: dict):
    """
    Factory function to create embedding model.

    Args:
        config: Dict with keys: provider, model, api_key/api_url/headers

    Returns:
        LlamaIndex-compatible embedding model

    Raises:
        ValueError: If provider is not supported

    Examples:
        >>> # OpenAI
        >>> config = {"provider": "openai", "model": "text-embedding-3-small", "api_key": "sk-xxx"}
        >>> model = create_embedding_model(config)

        >>> # Custom API
        >>> config = {
        ...     "provider": "custom",
        ...     "api_url": "http://api.example.com/embeddings",
        ...     "model": "bge-m3",
        ...     "headers": {"Authorization": "Bearer xxx"}
        ... }
        >>> model = create_embedding_model(config)
    """
    provider = config.get("provider")

    if provider == "openai":
        from llama_index.embeddings.openai import OpenAIEmbedding
        return OpenAIEmbedding(
            model=config["model"],
            api_key=config["api_key"]
        )
    elif provider == "custom":
        return CustomEmbedding(
            api_url=config["api_url"],
            model=config["model"],
            headers=config.get("headers", {})
        )
    else:
        raise ValueError(f"Unsupported embedding provider: {provider}")
