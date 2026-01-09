"""
Schemas for analytics API endpoints.
"""
from datetime import datetime
from typing import List, Literal, Optional

from pydantic import BaseModel


class TrendDataPoint(BaseModel):
    """Single data point in trend chart."""

    date: str
    avg_score: float
    count: int


class TrendsResponse(BaseModel):
    """Response for trends endpoint."""

    metric: str
    group_by: str
    data: List[TrendDataPoint]


class RetrieverComparisonItem(BaseModel):
    """Comparison data for a single retriever."""

    retriever_name: str
    avg_faithfulness: Optional[float] = None
    avg_answer_relevancy: Optional[float] = None
    avg_context_precision: Optional[float] = None
    avg_overall: Optional[float] = None
    count: int


class RetrieverComparisonResponse(BaseModel):
    """Response for retriever comparison endpoint."""

    data: List[RetrieverComparisonItem]


class EmbeddingComparisonItem(BaseModel):
    """Comparison data for a single embedding model."""

    embedding_model: str
    avg_faithfulness: Optional[float] = None
    avg_answer_relevancy: Optional[float] = None
    avg_context_precision: Optional[float] = None
    avg_overall: Optional[float] = None
    count: int


class EmbeddingComparisonResponse(BaseModel):
    """Response for embedding comparison endpoint."""

    data: List[EmbeddingComparisonItem]


class ContextComparisonRecord(BaseModel):
    """Single evaluation record for context comparison."""

    id: int
    original_created_at: datetime
    retriever_name: Optional[str] = None
    embedding_model: Optional[str] = None
    faithfulness_score: Optional[float] = None
    answer_relevancy_score: Optional[float] = None
    context_precision_score: Optional[float] = None
    overall_score: Optional[float] = None


class ContextComparisonResponse(BaseModel):
    """Response for context comparison endpoint."""

    subtask_context_id: int
    records: List[ContextComparisonRecord]


class IssueTypeCount(BaseModel):
    """Count for a single issue type."""

    type: str
    count: int
    percentage: float


class IssuesAnalyticsResponse(BaseModel):
    """Response for issues analytics endpoint."""

    total_issues: int
    by_type: List[IssueTypeCount]
