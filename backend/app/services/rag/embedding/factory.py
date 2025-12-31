# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Embedding model factory.
"""

from typing import Any, Dict

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.services.rag.embedding.custom import CustomEmbedding


def create_embedding_model_from_crd(
    db: Session, user_id: int, model_name: str, model_namespace: str = "default"
):
    """
    Create embedding model from Model CRD.

    Query logic:
    - If namespace='default': query with user_id filter (personal model) or public model (user_id=0)
    - If namespace!='default': query without user_id filter (group model)
      Group models may be created by other users in the same group.

    Args:
        db: Database session
        user_id: User ID
        model_name: Model name
        model_namespace: Model namespace (default: "default")

    Returns:
        LlamaIndex-compatible embedding model

    Raises:
        ValueError: If model not found or not an embedding model
    """
    # Query Model CRD from kinds table
    # For group resources (namespace != 'default'), don't filter by user_id
    # since the model may be created by other users in the same group
    if model_namespace == "default":
        # Personal or public model: filter by user_id or public (user_id=0)
        model_kind = (
            db.query(Kind)
            .filter(
                Kind.kind == "Model",
                Kind.name == model_name,
                Kind.namespace == model_namespace,
                Kind.is_active == True,
            )
            .filter((Kind.user_id == user_id) | (Kind.user_id == 0))
            .order_by(Kind.user_id.desc())  # Prioritize user's models
            .first()
        )
    else:
        # Group model: no user_id filter
        model_kind = (
            db.query(Kind)
            .filter(
                Kind.kind == "Model",
                Kind.name == model_name,
                Kind.namespace == model_namespace,
                Kind.is_active == True,
            )
            .first()
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

    # Build embedding config based on protocol
    if protocol == "openai":
        # OpenAI protocol (supports custom headers for internal gateways)
        # If custom headers are provided, use CustomEmbedding for flexibility
        if (
            custom_headers
            and isinstance(custom_headers, dict)
            and len(custom_headers) > 0
        ):
            # Construct OpenAI-compatible endpoint
            api_url = (
                f"{base_url.rstrip('/')}/embeddings"
                if base_url
                else "https://api.openai.com/v1/embeddings"
            )

            return CustomEmbedding(
                api_url=api_url,
                model=model_id or "text-embedding-3-small",
                headers=custom_headers,
                api_key=api_key,
            )
        else:
            # Standard OpenAI embedding
            from llama_index.embeddings.openai import OpenAIEmbedding

            return OpenAIEmbedding(
                model=model_id or "text-embedding-3-small",
                api_key=api_key,
                api_base=base_url if base_url else None,
            )
    elif protocol in ["cohere", "jina", "custom"]:
        # Custom API endpoint for Cohere, Jina, or other custom providers
        if not base_url:
            raise ValueError(
                f"Model '{model_name}' with protocol '{protocol}' requires base_url"
            )

        # Ensure base_url ends with /embeddings or appropriate endpoint
        if not base_url.endswith("/embeddings"):
            api_url = f"{base_url.rstrip('/')}/embeddings"
        else:
            api_url = base_url

        return CustomEmbedding(
            api_url=api_url,
            model=model_id,
            headers=custom_headers if isinstance(custom_headers, dict) else {},
            api_key=api_key,
        )
    else:
        raise ValueError(
            f"Unsupported embedding protocol: {protocol}. Supported: openai, cohere, jina, custom"
        )
