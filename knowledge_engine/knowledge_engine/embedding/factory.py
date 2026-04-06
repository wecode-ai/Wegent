# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Embedding model factory for resolved runtime config."""

from __future__ import annotations

from typing import Any

from knowledge_engine.embedding.custom import CustomEmbedding
from shared.models import RuntimeEmbeddingModelConfig


def create_embedding_model_from_runtime_config(
    runtime_config: RuntimeEmbeddingModelConfig,
):
    resolved_config = runtime_config.resolved_config or {}
    return _create_embedding_model_from_resolved_values(
        protocol=resolved_config.get("protocol"),
        model_name=runtime_config.model_name,
        api_key=resolved_config.get("api_key"),
        base_url=resolved_config.get("base_url"),
        model_id=resolved_config.get("model_id"),
        custom_headers=resolved_config.get("custom_headers") or {},
        dimensions=resolved_config.get("dimensions"),
    )


def _create_embedding_model_from_resolved_values(
    *,
    protocol: str | None,
    model_name: str,
    api_key: str | None,
    base_url: str | None,
    model_id: str | None,
    custom_headers: dict[str, Any],
    dimensions: int | None,
):
    if protocol == "openai":
        if custom_headers:
            api_url = (
                f"{base_url.rstrip('/')}/embeddings"
                if base_url
                else "https://api.openai.com/v1/embeddings"
            )
            return CustomEmbedding(
                api_url=api_url,
                model=model_id or model_name or "text-embedding-3-small",
                headers=custom_headers,
                api_key=api_key,
                dimensions=dimensions,
            )

        from llama_index.embeddings.openai import OpenAIEmbedding

        return OpenAIEmbedding(
            model=model_id or model_name or "text-embedding-3-small",
            api_key=api_key,
            api_base=base_url,
            dimensions=dimensions,
        )

    if protocol in {"cohere", "jina", "custom"}:
        if not base_url:
            raise ValueError(
                f"Embedding model '{model_name}' with protocol '{protocol}' "
                "requires base_url"
            )
        return CustomEmbedding(
            api_url=base_url,
            model=model_id or model_name,
            headers=custom_headers if isinstance(custom_headers, dict) else {},
            api_key=api_key,
            dimensions=dimensions,
        )

    raise ValueError(
        f"Unsupported embedding protocol for model '{model_name}': {protocol}"
    )
