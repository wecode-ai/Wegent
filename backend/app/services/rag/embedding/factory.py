# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Embedding model factory.
"""

import logging
from typing import Any, Dict, Optional

from llama_index.core.base.embeddings.base import BaseEmbedding
from sqlalchemy.orm import Session

from knowledge_engine.embedding.capabilities import (
    embedding_supports_image_input,
    normalize_additional_input_modalities,
)
from knowledge_engine.embedding.factory import (
    create_embedding_model_from_runtime_config as engine_create_embedding_model_from_runtime_config,
)
from shared.db.capability_reference import resolve_model_kind
from shared.models import RuntimeEmbeddingModelConfig
from shared.utils.crypto import decrypt_api_key
from shared.utils.placeholder import process_custom_headers_placeholders

logger = logging.getLogger(__name__)


def create_embedding_model_from_crd(
    db: Session,
    user_id: int,
    model_name: str,
    model_namespace: str = "default",
    user_name: Optional[str] = None,
) -> BaseEmbedding:
    """
    Create embedding model from Model CRD.

    Resolution logic:
    - Prefer a direct Model in the caller-visible namespace.
    - Fall back to an approved shared Model reference.

    Args:
        db: Database session
        user_id: User ID
        model_name: Model name
        model_namespace: Model namespace (default: "default")
        user_name: User name for placeholder replacement in custom headers (optional)

    Returns:
        LlamaIndex-compatible embedding model

    Raises:
        ValueError: If model not found or not an embedding model
    """
    model_kind = resolve_model_kind(
        db,
        name=model_name,
        namespace=model_namespace,
        user_id=user_id,
    )

    if not model_kind:
        raise ValueError(
            f"Embedding model '{model_name}' not found in namespace '{model_namespace}'"
        )

    # Parse Model CRD
    model_data = model_kind.json
    spec = model_data.get("spec", {})

    # Extract modelConfig
    model_config = spec.get("modelConfig", {})

    # Validate modelType - support both new format (spec.modelType) and old format (spec.modelConfig.modelType)
    # New format: modelType is at spec.modelType (e.g., "embedding")
    # Old format: modelType is at spec.modelConfig.modelType (e.g., "embedding")
    model_type = spec.get("modelType")
    if model_type is None:
        # Fallback to old format: check modelConfig.modelType
        model_type = model_config.get("modelType", "llm")

    if model_type != "embedding":
        raise ValueError(
            f"Model '{model_name}' is not an embedding model (modelType='{model_type}')"
        )

    # Get protocol from spec.protocol or fallback to modelConfig.env.model
    protocol = spec.get("protocol")
    if not protocol:
        # Fallback: extract from modelConfig.env.model (current frontend format)
        env = model_config.get("env", {})
        protocol = env.get(
            "model"
        )  # 'openai', 'claude', 'gemini', 'cohere', 'jina', 'custom'

    # Extract config from env (current frontend format)
    env = model_config.get("env", {})
    api_key = env.get("api_key")
    base_url = env.get("base_url")
    model_id = env.get("model_id")
    custom_headers = env.get("custom_headers", {})

    # Decrypt API key if present (handles both encrypted and plain keys)
    if api_key:
        try:
            api_key = decrypt_api_key(api_key)
        except Exception as e:
            # Log error but continue - decryption may fail if key is not encrypted
            # The decrypt_api_key function should handle backward compatibility
            logger.warning(
                f"Failed to decrypt API key for embedding_model '{model_name}': {str(e)}. Using as-is."
            )

    # Process placeholders in custom_headers (e.g., ${user.name})
    if custom_headers and isinstance(custom_headers, dict):
        custom_headers = process_custom_headers_placeholders(custom_headers, user_name)
        logger.info(
            f"Processed custom_headers placeholders for embedding_model '{model_name}'"
        )

    # Extract embedding dimensions from embeddingConfig
    # This is used by Milvus to create collections with the correct dimension
    embedding_config = spec.get("embeddingConfig", {})
    dimensions = embedding_config.get("dimensions") if embedding_config else None
    encoding_format = (
        embedding_config.get("encoding_format") if embedding_config else None
    )
    additional_input_modalities = normalize_additional_input_modalities(
        embedding_config.get("additional_input_modalities")
        if embedding_config
        else None
    )
    if dimensions:
        logger.info(
            f"[EmbeddingFactory] Model '{model_name}' has configured dimensions: {dimensions}"
        )
    if additional_input_modalities:
        logger.info(
            "[EmbeddingFactory] Model '%s' additional input modalities: %s "
            "(supports_image_input=%s)",
            model_name,
            additional_input_modalities,
            embedding_supports_image_input(additional_input_modalities),
        )

    return engine_create_embedding_model_from_runtime_config(
        RuntimeEmbeddingModelConfig(
            model_name=model_name,
            model_namespace=model_namespace,
            resolved_config={
                "protocol": protocol,
                "api_key": api_key,
                "base_url": base_url,
                "model_id": model_id,
                "custom_headers": (
                    custom_headers if isinstance(custom_headers, dict) else {}
                ),
                "dimensions": dimensions,
                "encoding_format": encoding_format,
                "additional_input_modalities": additional_input_modalities,
            },
        )
    )


def create_embedding_model_from_runtime_config(
    runtime_config: RuntimeEmbeddingModelConfig,
) -> BaseEmbedding:
    """Create embedding model directly from resolved runtime config."""
    return engine_create_embedding_model_from_runtime_config(runtime_config)
