# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Embedding model factory for resolved runtime config."""

from __future__ import annotations

from typing import Any

from knowledge_engine.embedding.capabilities import (
    normalize_additional_input_modalities,
)
from knowledge_engine.embedding.custom import CustomEmbedding
from knowledge_engine.embedding.errors import EmbeddingSpaceConfigurationError
from knowledge_engine.embedding.space import (
    EMBEDDING_SPACE_ID_ATTRIBUTE,
    derive_embedding_space_id,
)
from shared.models import RuntimeEmbeddingModelConfig

# The provider protocols this factory can build a model for. The value is
# normalized before it is used, so it is part of the embedding space identity
# rather than a spelling the caller has to match.
SUPPORTED_PROTOCOLS = ("openai", "cohere", "jina", "custom")


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
        encoding_format=resolved_config.get("encoding_format"),
        additional_input_modalities=resolved_config.get("additional_input_modalities"),
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
    encoding_format: str | None,
    additional_input_modalities: list[str] | None,
) -> Any:
    resolved_protocol = _normalize_protocol(protocol)
    provider_model_id = _resolve_provider_model_id(
        model_id=model_id, model_name=model_name
    )
    resolved_modalities = normalize_additional_input_modalities(
        additional_input_modalities
    )
    embed_model = _build_embed_model(
        protocol=resolved_protocol,
        model_name=model_name,
        model_id=provider_model_id,
        api_key=api_key,
        base_url=base_url,
        custom_headers=custom_headers,
        dimensions=dimensions,
        encoding_format=encoding_format,
    )
    return _attach_runtime_identity(
        embed_model,
        protocol=resolved_protocol,
        model_id=provider_model_id,
        additional_input_modalities=resolved_modalities,
    )


def _build_embed_model(
    *,
    protocol: str,
    model_name: str,
    model_id: str,
    api_key: str | None,
    base_url: str | None,
    custom_headers: dict[str, Any],
    dimensions: int | None,
    encoding_format: str | None,
) -> Any:
    """Build the provider client for one normalized protocol."""
    if protocol == "openai":
        if custom_headers:
            api_url = (
                f"{base_url.rstrip('/')}/embeddings"
                if base_url
                else "https://api.openai.com/v1/embeddings"
            )
            return CustomEmbedding(
                api_url=api_url,
                model=model_id,
                headers=custom_headers,
                api_key=api_key,
                dimensions=dimensions,
                encoding_format=encoding_format,
            )

        from llama_index.embeddings.openai import OpenAIEmbedding

        return OpenAIEmbedding(
            model=model_id,
            api_key=api_key,
            api_base=base_url,
            dimensions=dimensions,
        )

    if not base_url:
        raise EmbeddingSpaceConfigurationError(
            f"Embedding model '{model_name}' with protocol "
            f"'{protocol}' requires base_url"
        )
    return CustomEmbedding(
        api_url=base_url,
        model=model_id,
        headers=custom_headers if isinstance(custom_headers, dict) else {},
        api_key=api_key,
        dimensions=dimensions,
        encoding_format=encoding_format,
    )


def _normalize_protocol(protocol: Any) -> str:
    """Normalize the provider protocol the space identity is derived from."""
    if not isinstance(protocol, str) or not protocol.strip():
        raise EmbeddingSpaceConfigurationError(
            "An embedding model needs a provider protocol to declare which "
            "vector space it produces."
        )
    normalized = protocol.strip().lower()
    if normalized not in SUPPORTED_PROTOCOLS:
        raise EmbeddingSpaceConfigurationError(
            f"Unsupported embedding protocol '{protocol}'. Supported protocols: "
            f"{', '.join(SUPPORTED_PROTOCOLS)}."
        )
    return normalized


def _resolve_provider_model_id(*, model_id: Any, model_name: Any) -> str:
    """Resolve the model ID actually sent to the provider.

    The configured model ID wins over the display name because the provider
    sees it; falling back would let two display names of one model, or one
    display name of two models, share a vector space. Guessing a default model
    is not an option either, so a model without one fails here.
    """
    for candidate in (model_id, model_name):
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    raise EmbeddingSpaceConfigurationError(
        "An embedding model needs a stable model ID to declare which vector "
        "space it produces."
    )


def _attach_runtime_identity(
    embed_model: Any,
    *,
    protocol: str,
    model_id: str,
    additional_input_modalities: list[str],
) -> Any:
    """Expose the resolved capabilities and space identity on the model."""
    object.__setattr__(
        embed_model,
        "_additional_input_modalities",
        list(additional_input_modalities),
    )
    object.__setattr__(
        embed_model,
        EMBEDDING_SPACE_ID_ATTRIBUTE,
        derive_embedding_space_id(protocol=protocol, model_id=model_id),
    )
    return embed_model
