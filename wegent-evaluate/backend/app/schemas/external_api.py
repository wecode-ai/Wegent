"""
Schemas for external API responses.
"""
from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class KnowledgeSource(BaseModel):
    """Source document information."""

    score: Optional[float] = None
    document_name: Optional[str] = None


class KnowledgeTypeData(BaseModel):
    """Type-specific data from knowledge base result."""

    knowledge_id: Optional[int] = None
    document_count: Optional[int] = None
    sources: Optional[List[Dict[str, Any]]] = None


class KnowledgeBaseResult(BaseModel):
    """Knowledge base retrieval result."""

    extracted_text: Optional[str] = None
    type_data: Optional[KnowledgeTypeData] = None


class EmbeddingConfig(BaseModel):
    """Embedding model configuration."""

    model_name: Optional[str] = None
    model_namespace: Optional[str] = "default"


class HybridWeights(BaseModel):
    """Hybrid search weights."""

    vector_weight: Optional[float] = 0.7
    keyword_weight: Optional[float] = 0.3


class RetrievalConfig(BaseModel):
    """Retrieval configuration."""

    retriever_name: Optional[str] = None
    retriever_namespace: Optional[str] = "default"
    embedding_config: Optional[EmbeddingConfig] = None
    retrieval_mode: Optional[str] = "vector"
    top_k: Optional[int] = 5
    score_threshold: Optional[float] = 0.7
    hybrid_weights: Optional[HybridWeights] = None


class KnowledgeBaseConfig(BaseModel):
    """Knowledge base configuration."""

    id: int
    name: str
    retrieval_config: Optional[RetrievalConfig] = None


class QAHistoryItem(BaseModel):
    """Single QA history item from external API."""

    task_id: int
    user_id: int
    subtask_id: int
    subtask_context_id: int
    user_prompt: Optional[str] = None
    assistant_answer: Optional[str] = None
    knowledge_base_result: Optional[KnowledgeBaseResult] = None
    knowledge_base_config: Optional[KnowledgeBaseConfig] = None
    created_at: datetime


class Pagination(BaseModel):
    """Pagination information."""

    page: int
    page_size: int
    total: int
    total_pages: int


class QAHistoryResponse(BaseModel):
    """Response from external QA history API."""

    items: List[QAHistoryItem] = Field(default_factory=list)
    pagination: Pagination
