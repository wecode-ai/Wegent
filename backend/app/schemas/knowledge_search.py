# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Schemas for public knowledge search endpoints."""

from pydantic import BaseModel, Field


class KnowledgeSearchRequest(BaseModel):
    """Request schema for v1 knowledge base search endpoint.

    Resolves retriever and embedding model automatically from KB config,
    so callers only need to specify what to search, not how.
    """

    knowledge_base_id: int = Field(..., description="Knowledge base ID to search in")
    query: str = Field(
        ..., min_length=1, max_length=2000, description="Search query text"
    )
    top_k: int = Field(5, ge=1, le=100, description="Number of results to return")
    score_threshold: float = Field(
        0.7, ge=0.0, le=1.0, description="Minimum similarity score threshold"
    )
    route_mode: str = Field(
        "auto",
        description="Retrieval mode: 'auto', 'direct_injection', or 'rag_retrieval'",
    )
    context_window: int = Field(
        128000,
        ge=1,
        description="Context window size for direct injection mode",
    )
    used_context_tokens: int = Field(
        0,
        ge=0,
        description="Already used context tokens",
    )
    reserved_output_tokens: int = Field(
        4096,
        ge=0,
        description="Reserved output tokens",
    )
    context_buffer_ratio: float = Field(
        0.1,
        ge=0.0,
        le=1.0,
        description="Context buffer ratio for safety margin",
    )
    max_direct_chunks: int = Field(
        500,
        ge=1,
        le=10000,
        description="Maximum chunks for direct injection",
    )
