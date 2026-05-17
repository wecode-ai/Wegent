# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Embedding generation endpoint for executor-side DuckDB semantic search."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from knowledge_engine.embedding.factory import (
    create_embedding_model_from_runtime_config,
)
from knowledge_runtime.services.config_resolver import ConfigResolver
from shared.db.sync_session import get_db

logger = logging.getLogger(__name__)

router = APIRouter()


class EmbedRequest(BaseModel):
    """Request body for the /internal/embed endpoint."""

    text: str = Field(..., description="Text to embed")
    model: str = Field(..., description="Embedding model name (e.g. BAAI/bge-small-zh)")
    model_namespace: str = Field(
        default="default",
        description="Embedding model namespace (default: 'default')",
    )


class EmbedResponse(BaseModel):
    """Response body for the /internal/embed endpoint."""

    embedding: list[float] = Field(..., description="Embedding vector")
    dim: int = Field(..., description="Embedding dimension")


@router.post("/embed", response_model=EmbedResponse)
async def generate_embedding(
    request: EmbedRequest,
    db: Session = Depends(get_db),
) -> EmbedResponse:
    """Generate a text embedding using the configured embedding model.

    This endpoint is designed for use by executor-side code that needs to
    perform semantic search against DuckDB files. The executor calls this
    endpoint to generate query embeddings, which are then used with
    DuckDB's VSS extension for vector similarity search.

    Authentication is handled by the router-level dependency (verify_internal_token).

    Args:
        request: Embed request containing text and model name.
        db: Database session for config resolution.

    Returns:
        EmbedResponse with the embedding vector and its dimension.
    """
    resolver = ConfigResolver()

    # Use user_id=0 to resolve public/system embedding models.
    # Executors don't have a user context — they use shared system models.
    embedding_model_config = resolver._build_resolved_embedding_model_config(
        db=db,
        user_id=0,
        model_name=request.model,
        model_namespace=request.model_namespace,
        user_name=None,
    )

    embed_model = create_embedding_model_from_runtime_config(embedding_model_config)

    # Use async embedding to avoid blocking the event loop
    embedding: list[float] = await embed_model.aget_query_embedding(request.text)

    logger.info(
        "Generated embedding: model=%s, text_len=%d, dim=%d",
        request.model,
        len(request.text),
        len(embedding),
    )

    return EmbedResponse(embedding=embedding, dim=len(embedding))
