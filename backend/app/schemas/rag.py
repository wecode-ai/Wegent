# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from enum import Enum
from typing import Dict, List, Optional

from pydantic import BaseModel, Field, field_validator

from app.schemas.kind import EmbeddingModelRef, RetrieverRef
from shared.models.splitter_config import (  # noqa: F401
    FlatChunkConfig,
    HierarchicalChunkConfig,
    MarkdownEnhancementConfig,
    NormalizedSplitterConfig,
    SemanticSplitterConfig,
    SentenceSplitterConfig,
    SmartSplitterConfig,
    SplitterConfig,
)


class RetrievalMode(str, Enum):
    """Retrieval mode enum."""

    VECTOR = "vector"  # Pure vector search
    KEYWORD = "keyword"  # Pure BM25 keyword search (full-text search)
    HYBRID = "hybrid"  # Hybrid search (vector + BM25)


class SplitterType(str, Enum):
    """Document splitter type enum."""

    FLAT = "flat"
    HIERARCHICAL = "hierarchical"
    SEMANTIC = "semantic"


class HybridWeights(BaseModel):
    """Hybrid search weights configuration."""

    vector_weight: float = Field(
        0.7, ge=0.0, le=1.0, description="Weight for vector search (0.0-1.0)"
    )
    keyword_weight: float = Field(
        0.3, ge=0.0, le=1.0, description="Weight for BM25 keyword search (0.0-1.0)"
    )

    @field_validator("keyword_weight")
    @classmethod
    def validate_weights_sum(cls, v, info):
        """Validate that weights sum to 1.0."""
        vector_weight = info.data.get("vector_weight", 0.7)
        total = vector_weight + v
        if not (0.99 <= total <= 1.01):  # Allow small floating point errors
            raise ValueError(
                f"vector_weight ({vector_weight}) + keyword_weight ({v}) must equal 1.0, got {total}"
            )
        return v


class RetrieveRequest(BaseModel):
    """Document retrieval request."""

    query: str
    knowledge_id: str = Field(..., description="Knowledge base ID")
    retriever_ref: RetrieverRef = Field(
        ..., description="Reference to Retriever configuration"
    )
    embedding_model_ref: EmbeddingModelRef = Field(
        ..., description="Reference to embedding Model CRD"
    )
    top_k: int = Field(5, ge=1, le=100)
    score_threshold: float = Field(
        0.7,
        ge=0.0,
        le=1.0,
        description="Minimum similarity score (renamed from similarity_threshold)",
    )
    retrieval_mode: RetrievalMode = Field(
        RetrievalMode.VECTOR,
        description="Retrieval mode: 'vector' for pure vector search, 'keyword' for pure BM25 keyword search, 'hybrid' for vector + BM25",
    )
    hybrid_weights: Optional[HybridWeights] = Field(
        None,
        description="Weights for hybrid search (only used when retrieval_mode='hybrid')",
    )
    metadata_condition: Optional[Dict] = Field(
        None, description="Optional metadata filtering conditions"
    )

    @field_validator("hybrid_weights")
    @classmethod
    def validate_hybrid_config(cls, v, info):
        """Validate hybrid_weights is provided when using hybrid mode."""
        mode = info.data.get("retrieval_mode")
        if mode == RetrievalMode.HYBRID and v is None:
            # Provide default weights if not specified
            return HybridWeights()
        return v


class RetrievalResult(BaseModel):
    """Single retrieval result (Dify-compatible format)."""

    content: str = Field(..., description="Chunk text content from data source")
    score: float = Field(..., description="Relevance score (0-1)")
    title: str = Field(..., description="Document title/source file")
    metadata: Optional[Dict] = Field(
        None, description="Document metadata attributes and values"
    )


class RetrieveResponse(BaseModel):
    """Document retrieval response (Dify-compatible format)."""

    records: List[RetrievalResult] = Field(
        ..., description="List of records from querying the knowledge base"
    )


class RagChunkRecord(BaseModel):
    """Single chunk record from the index engine."""

    content: str = Field(..., description="Chunk text content")
    title: str = Field(..., description="Document title/source file")
    chunk_id: Optional[int] = Field(None, description="Chunk identifier in index")
    doc_ref: Optional[str] = Field(None, description="Document reference")
    metadata: Optional[Dict] = Field(None, description="Chunk metadata")


class RagChunkListResponse(BaseModel):
    """Paginated chunk list response for index inspection."""

    items: List[RagChunkRecord] = Field(
        ..., description="Paginated chunk records from the index engine"
    )
    total: int = Field(..., description="Total chunk count available")
    page: int = Field(..., ge=1, description="Current page number")
    page_size: int = Field(..., ge=1, description="Current page size")
