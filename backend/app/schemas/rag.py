# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from pydantic import BaseModel, Field, field_validator
from typing import Optional, Dict, List, Literal
from enum import Enum

from app.schemas.kind import RetrieverRef


class RetrievalMode(str, Enum):
    """Retrieval mode enum."""
    VECTOR = "vector"  # Pure vector search
    HYBRID = "hybrid"  # Hybrid search (vector + BM25)


class EmbeddingConfig(BaseModel):
    """Embedding model configuration."""
    provider: str = Field(..., description="'openai' or 'custom'")
    model: str
    api_key: Optional[str] = None
    api_url: Optional[str] = None
    headers: Optional[Dict[str, str]] = None


class HybridWeights(BaseModel):
    """Hybrid search weights configuration."""
    vector_weight: float = Field(
        0.7,
        ge=0.0,
        le=1.0,
        description="Weight for vector search (0.0-1.0)"
    )
    keyword_weight: float = Field(
        0.3,
        ge=0.0,
        le=1.0,
        description="Weight for BM25 keyword search (0.0-1.0)"
    )

    @field_validator('keyword_weight')
    @classmethod
    def validate_weights_sum(cls, v, info):
        """Validate that weights sum to 1.0."""
        vector_weight = info.data.get('vector_weight', 0.7)
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
    retriever_ref: RetrieverRef = Field(..., description="Reference to Retriever configuration")
    embedding_config: EmbeddingConfig
    top_k: int = Field(5, ge=1, le=100)
    score_threshold: float = Field(0.7, ge=0.0, le=1.0, description="Minimum similarity score (renamed from similarity_threshold)")
    retrieval_mode: RetrievalMode = Field(
        RetrievalMode.VECTOR,
        description="Retrieval mode: 'vector' for pure vector search, 'hybrid' for vector + BM25"
    )
    hybrid_weights: Optional[HybridWeights] = Field(
        None,
        description="Weights for hybrid search (only used when retrieval_mode='hybrid')"
    )
    metadata_condition: Optional[Dict] = Field(
        None,
        description="Optional metadata filtering conditions"
    )

    @field_validator('hybrid_weights')
    @classmethod
    def validate_hybrid_config(cls, v, info):
        """Validate hybrid_weights is provided when using hybrid mode."""
        mode = info.data.get('retrieval_mode')
        if mode == RetrievalMode.HYBRID and v is None:
            # Provide default weights if not specified
            return HybridWeights()
        return v


class DocumentUploadRequest(BaseModel):
    """Document upload request."""
    knowledge_id: str = Field(..., description="Knowledge base ID")
    retriever_ref: RetrieverRef = Field(..., description="Reference to Retriever configuration")
    embedding_config: EmbeddingConfig


class DocumentUploadResponse(BaseModel):
    """Document upload response."""
    document_id: str
    knowledge_id: str
    source_file: str
    chunk_count: int
    index_name: str
    status: str
    created_at: str


class RetrievalResult(BaseModel):
    """Single retrieval result."""
    document_id: str
    chunk_index: int
    source_file: str
    content: str
    similarity_score: float
    metadata: Dict


class RetrieveResponse(BaseModel):
    """Document retrieval response."""
    records: List[RetrievalResult] = Field(..., description="Retrieved document chunks (renamed from results)")
    query: str
    knowledge_id: str
    total: int = Field(..., description="Total number of results (renamed from total_results)")
    retrieval_mode: str = Field(..., description="Retrieval mode used")


class DocumentDeleteRequest(BaseModel):
    """Document deletion request."""
    knowledge_id: str = Field(..., description="Knowledge base ID")
    retriever_ref: RetrieverRef = Field(..., description="Reference to Retriever configuration")


class DocumentDeleteResponse(BaseModel):
    """Document deletion response."""
    document_id: str
    knowledge_id: str
    deleted_chunks: int
    status: str


class DocumentDetailRequest(BaseModel):
    """Document detail request."""
    knowledge_id: str = Field(..., description="Knowledge base ID")
    retriever_ref: RetrieverRef = Field(..., description="Reference to Retriever configuration")


class DocumentDetailResponse(BaseModel):
    """Document detail response."""
    document_id: str
    knowledge_id: str
    source_file: str
    chunk_count: int
    chunks: List[Dict]


class DocumentListRequest(BaseModel):
    """Document list request."""
    knowledge_id: str = Field(..., description="Knowledge base ID")
    retriever_ref: RetrieverRef = Field(..., description="Reference to Retriever configuration")
    page: int = Field(1, ge=1)
    page_size: int = Field(20, ge=1, le=100)


class DocumentListResponse(BaseModel):
    """Document list response."""
    documents: List[Dict]
    total: int
    page: int
    page_size: int
    knowledge_id: str