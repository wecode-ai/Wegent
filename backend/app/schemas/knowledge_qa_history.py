# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Pydantic schemas for knowledge base QA history query.
"""

from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class KnowledgeBaseTypeData(BaseModel):
    """Type data from subtask_contexts for knowledge_base type."""

    knowledge_id: Optional[int] = Field(None, description="Knowledge base ID")
    document_count: Optional[int] = Field(None, description="Document count")
    sources: Optional[List[Dict[str, Any]]] = Field(
        None, description="Retrieved document sources (raw data from database)"
    )


class KnowledgeBaseResult(BaseModel):
    """Knowledge base retrieval result from subtask_contexts."""

    extracted_text: Optional[str] = Field(
        None, description="Extracted text from vector search"
    )
    type_data: Optional[KnowledgeBaseTypeData] = Field(
        None, description="Type-specific metadata"
    )


class EmbeddingConfigInfo(BaseModel):
    """Embedding model configuration."""

    model_name: Optional[str] = Field(None, description="Embedding model name")
    model_namespace: Optional[str] = Field(
        "default", description="Embedding model namespace"
    )


class HybridWeightsInfo(BaseModel):
    """Hybrid search weights configuration."""

    vector_weight: Optional[float] = Field(None, description="Vector search weight")
    keyword_weight: Optional[float] = Field(None, description="Keyword search weight")


class RetrievalConfigInfo(BaseModel):
    """Retrieval configuration from knowledge base."""

    retriever_name: Optional[str] = Field(None, description="Retriever name")
    retriever_namespace: Optional[str] = Field(
        "default", description="Retriever namespace"
    )
    embedding_config: Optional[EmbeddingConfigInfo] = Field(
        None, description="Embedding configuration"
    )
    retrieval_mode: Optional[str] = Field(
        None, description="Retrieval mode: vector, keyword, or hybrid"
    )
    top_k: Optional[int] = Field(None, description="Number of results to return")
    score_threshold: Optional[float] = Field(
        None, description="Minimum score threshold"
    )
    hybrid_weights: Optional[HybridWeightsInfo] = Field(
        None, description="Hybrid search weights"
    )


class KnowledgeBaseConfigInfo(BaseModel):
    """Knowledge base configuration information."""

    id: int = Field(..., description="Knowledge base ID")
    name: str = Field(..., description="Knowledge base name")
    retrieval_config: Optional[RetrievalConfigInfo] = Field(
        None, description="Retrieval configuration"
    )


class QAHistoryItem(BaseModel):
    """Single QA history record."""

    task_id: int = Field(..., description="Task ID")
    user_id: int = Field(..., description="User ID")
    subtask_id: int = Field(..., description="Subtask ID (USER message)")
    subtask_context_id: int = Field(..., description="Subtask context ID")
    user_prompt: Optional[str] = Field(None, description="User's question")
    assistant_answer: Optional[str] = Field(None, description="Assistant's answer")
    knowledge_base_result: Optional[KnowledgeBaseResult] = Field(
        None, description="Knowledge base retrieval result"
    )
    knowledge_base_config: Optional[KnowledgeBaseConfigInfo] = Field(
        None, description="Knowledge base configuration"
    )
    created_at: datetime = Field(..., description="Record creation time")


class PaginationInfo(BaseModel):
    """Pagination information."""

    page: int = Field(..., description="Current page number")
    page_size: int = Field(..., description="Page size")
    total: int = Field(..., description="Total number of records")
    total_pages: int = Field(..., description="Total number of pages")


class QAHistoryResponse(BaseModel):
    """Response for QA history query."""

    items: List[QAHistoryItem] = Field(
        default_factory=list, description="List of QA history items"
    )
    pagination: PaginationInfo = Field(..., description="Pagination information")
