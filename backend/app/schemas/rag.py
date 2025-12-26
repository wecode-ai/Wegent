# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from enum import Enum
from typing import Dict, List, Literal, Optional, Union

from pydantic import BaseModel, Field, field_validator

from app.schemas.kind import EmbeddingModelRef, RetrieverRef


class RetrievalMode(str, Enum):
    """Retrieval mode enum."""

    VECTOR = "vector"  # Pure vector search
    KEYWORD = "keyword"  # Pure BM25 keyword search (full-text search)
    HYBRID = "hybrid"  # Hybrid search (vector + BM25)


class SplitterType(str, Enum):
    """Document splitter type enum."""

    SEMANTIC = "semantic"  # Semantic-based splitting using embeddings
    SENTENCE = "sentence"  # Sentence/text-based splitting with separators


class SemanticSplitterConfig(BaseModel):
    """Configuration for semantic splitter."""

    type: Literal["semantic"] = "semantic"
    buffer_size: int = Field(
        1, ge=1, le=10, description="Buffer size for semantic splitter"
    )
    breakpoint_percentile_threshold: int = Field(
        95,
        ge=50,
        le=100,
        description="Percentile threshold for determining breakpoints",
    )


class SentenceSplitterConfig(BaseModel):
    """Configuration for sentence splitter."""

    type: Literal["sentence"] = "sentence"
    chunk_size: int = Field(
        1024, ge=128, le=8192, description="Maximum chunk size in characters"
    )
    chunk_overlap: int = Field(
        200,
        ge=0,
        le=2048,
        description="Number of characters to overlap between chunks",
    )
    separator: str = Field(
        "\n\n",
        description="Separator for splitting. Common options: '\\n\\n' (paragraph, default), '\\n' (newline), ' ' (space), '.' (sentence)",
    )

    @field_validator("chunk_overlap")
    @classmethod
    def validate_overlap(cls, v, info):
        """Validate that chunk_overlap is less than chunk_size."""
        chunk_size = info.data.get("chunk_size", 1024)
        if v >= chunk_size:
            raise ValueError(
                f"chunk_overlap ({v}) must be less than chunk_size ({chunk_size})"
            )
        return v


# Union type for splitter configuration
SplitterConfig = Union[SemanticSplitterConfig, SentenceSplitterConfig]


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


class DocumentUploadRequest(BaseModel):
    """Document upload request."""

    knowledge_id: str = Field(..., description="Knowledge base ID")
    retriever_ref: RetrieverRef = Field(
        ..., description="Reference to Retriever configuration"
    )
    embedding_model_ref: EmbeddingModelRef = Field(
        ..., description="Reference to embedding Model CRD"
    )


class DocumentUploadResponse(BaseModel):
    """Document upload response."""

    doc_ref: str
    knowledge_id: str
    source_file: str
    chunk_count: int
    index_name: str
    status: str
    created_at: str


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


class DocumentDeleteRequest(BaseModel):
    """Document deletion request."""

    knowledge_id: str = Field(..., description="Knowledge base ID")
    retriever_ref: RetrieverRef = Field(
        ..., description="Reference to Retriever configuration"
    )


class DocumentDeleteResponse(BaseModel):
    """Document deletion response."""

    doc_ref: str
    knowledge_id: str
    deleted_chunks: int
    status: str


class DocumentDetailRequest(BaseModel):
    """Document detail request."""

    knowledge_id: str = Field(..., description="Knowledge base ID")
    retriever_ref: RetrieverRef = Field(
        ..., description="Reference to Retriever configuration"
    )


class DocumentDetailResponse(BaseModel):
    """Document detail response."""

    doc_ref: str
    knowledge_id: str
    source_file: str
    chunk_count: int
    chunks: List[Dict]


class DocumentListRequest(BaseModel):
    """Document list request."""

    knowledge_id: str = Field(..., description="Knowledge base ID")
    retriever_ref: RetrieverRef = Field(
        ..., description="Reference to Retriever configuration"
    )
    page: int = Field(1, ge=1)
    page_size: int = Field(20, ge=1, le=100)


class DocumentListResponse(BaseModel):
    """Document list response."""

    documents: List[Dict]
    total: int
    page: int
    page_size: int
    knowledge_id: str
