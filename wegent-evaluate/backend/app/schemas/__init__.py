"""Schemas package initialization."""

from app.schemas.analytics import (
    ContextComparisonRecord,
    ContextComparisonResponse,
    EmbeddingComparisonItem,
    EmbeddingComparisonResponse,
    IssuesAnalyticsResponse,
    IssueTypeCount,
    RetrieverComparisonItem,
    RetrieverComparisonResponse,
    TrendDataPoint,
    TrendsResponse,
)
from app.schemas.evaluation import (
    EvaluationResultDetail,
    EvaluationResultItem,
    EvaluationResultsResponse,
    EvaluationStatusResponse,
    EvaluationSummaryResponse,
    EvaluationTriggerRequest,
    EvaluationTriggerResponse,
    ImprovementSuggestion,
    LLMAnalysis,
    QualityAssessment,
    RetrievalDiagnosis,
)
from app.schemas.external_api import (
    KnowledgeBaseConfig,
    KnowledgeBaseResult,
)
from app.schemas.sync import (
    SyncHistoryItem,
    SyncHistoryResponse,
    SyncStatusResponse,
    SyncTriggerRequest,
    SyncTriggerResponse,
)

__all__ = [
    # External API
    "KnowledgeBaseConfig",
    "KnowledgeBaseResult",
    # Sync
    "SyncHistoryItem",
    "SyncHistoryResponse",
    "SyncStatusResponse",
    "SyncTriggerRequest",
    "SyncTriggerResponse",
    # Evaluation
    "EvaluationResultDetail",
    "EvaluationResultItem",
    "EvaluationResultsResponse",
    "EvaluationStatusResponse",
    "EvaluationSummaryResponse",
    "EvaluationTriggerRequest",
    "EvaluationTriggerResponse",
    "ImprovementSuggestion",
    "LLMAnalysis",
    "QualityAssessment",
    "RetrievalDiagnosis",
    # Analytics
    "ContextComparisonRecord",
    "ContextComparisonResponse",
    "EmbeddingComparisonItem",
    "EmbeddingComparisonResponse",
    "IssuesAnalyticsResponse",
    "IssueTypeCount",
    "RetrieverComparisonItem",
    "RetrieverComparisonResponse",
    "TrendDataPoint",
    "TrendsResponse",
]
