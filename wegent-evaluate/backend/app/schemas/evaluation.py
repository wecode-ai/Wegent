"""
Schemas for evaluation API endpoints.
"""
from datetime import datetime
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field


class EvaluationTriggerRequest(BaseModel):
    """Request body for triggering evaluation."""

    mode: Literal["range", "ids"]
    start_id: Optional[int] = None  # For mode=range
    end_id: Optional[int] = None  # For mode=range
    record_ids: Optional[List[int]] = None  # For mode=ids
    force: bool = False  # Force re-evaluation of all records including completed ones


class EvaluationTriggerResponse(BaseModel):
    """Response for evaluation trigger endpoint."""

    job_id: str
    status: str
    total_records: int


class EvaluationStatusResponse(BaseModel):
    """Response for evaluation status endpoint."""

    job_id: str
    status: str
    total: int
    completed: int
    failed: int
    skipped: int


class EvaluationResultItem(BaseModel):
    """Single evaluation result in list."""

    id: Optional[int] = None
    conversation_record_id: int
    user_prompt: str
    assistant_answer: str
    extracted_text: Optional[str] = None
    faithfulness_score: Optional[float] = None
    answer_relevancy_score: Optional[float] = None
    context_precision_score: Optional[float] = None
    overall_score: Optional[float] = None
    has_issue: bool
    has_cv_alert: bool = False
    issue_types: Optional[List[str]] = None
    retriever_name: Optional[str] = None
    embedding_model: Optional[str] = None
    knowledge_name: Optional[str] = None
    evaluation_status: str
    created_at: datetime
    # New tiered metrics fields
    total_score: Optional[float] = None
    retrieval_score: Optional[float] = None
    generation_score: Optional[float] = None
    is_failed: Optional[bool] = False
    failure_reason: Optional[str] = None

    class Config:
        from_attributes = True


class EvaluationResultsResponse(BaseModel):
    """Response for evaluation results list endpoint."""

    items: List[EvaluationResultItem]
    total: int
    page: int
    page_size: int
    total_pages: int


class ImprovementSuggestion(BaseModel):
    """Single improvement suggestion."""

    category: str
    suggestion: str
    priority: str
    expected_impact: str


class QualityAssessment(BaseModel):
    """Quality assessment from LLM analysis."""

    overall_quality: str
    answer_accuracy: str
    answer_completeness: str
    strengths: List[str]
    weaknesses: List[str]


class RetrievalDiagnosis(BaseModel):
    """Retrieval diagnosis from LLM analysis."""

    retrieval_quality: str
    relevance_analysis: str
    coverage_analysis: str
    issues: List[str]
    root_cause: Optional[str] = None


class LLMAnalysis(BaseModel):
    """Full LLM analysis result."""

    quality_assessment: QualityAssessment
    retrieval_diagnosis: RetrievalDiagnosis
    improvement_suggestions: List[ImprovementSuggestion]
    has_critical_issue: bool
    issue_types: List[str]
    summary: str


# Cross-validation schemas
class CrossValidationPair(BaseModel):
    """Cross-validation pair result."""

    name: str
    ragas_metric: str
    trulens_metric: str
    eval_target: str
    signal_source: str
    scoring_goal: str
    ragas_score: Optional[float] = None
    trulens_score: Optional[float] = None
    difference: Optional[float] = None
    is_alert: bool = False
    threshold: float = 0.2


class CrossValidationResult(BaseModel):
    """Full cross-validation result."""

    pairs: List[CrossValidationPair]
    has_alert: bool
    alert_count: int
    threshold: float


# Diagnostic analysis schemas
class DiagnosticIssue(BaseModel):
    """Single diagnostic issue."""

    metric: str
    score: Optional[float] = None
    description: str
    severity: str


class DiagnosticSuggestion(BaseModel):
    """Single diagnostic suggestion."""

    title: str
    description: str
    related_metrics: List[str]


class DiagnosticAnalysis(BaseModel):
    """Diagnostic analysis report."""

    framework: str
    overall_rating: str
    has_issues: bool = False
    issues: List[DiagnosticIssue] = []
    suggestions: List[DiagnosticSuggestion] = []
    priority_order: List[str] = []
    summary: str = ""
    raw_analysis: Optional[str] = None


class EvaluationResultDetail(BaseModel):
    """Detailed evaluation result for single record with all metrics."""

    id: int
    conversation_record_id: int

    # Original conversation
    user_prompt: str
    assistant_answer: str
    extracted_text: Optional[str] = None

    # Knowledge base info
    knowledge_id: Optional[int] = None
    knowledge_name: Optional[str] = None
    retriever_name: Optional[str] = None
    embedding_model: Optional[str] = None
    retrieval_mode: Optional[str] = None
    knowledge_base_result: Optional[Dict[str, Any]] = None
    knowledge_base_config: Optional[Dict[str, Any]] = None

    # Legacy RAGAS scores
    faithfulness_score: Optional[float] = None
    answer_relevancy_score: Optional[float] = None
    context_precision_score: Optional[float] = None
    overall_score: Optional[float] = None

    # RAGAS Embedding metrics
    ragas_query_context_relevance: Optional[float] = None
    ragas_context_precision_emb: Optional[float] = None
    ragas_context_diversity: Optional[float] = None

    # RAGAS LLM metrics
    ragas_context_utilization: Optional[float] = None
    ragas_coherence: Optional[float] = None

    # TruLens Embedding metrics
    trulens_context_relevance: Optional[float] = None
    trulens_relevance_embedding: Optional[float] = None

    # TruLens LLM metrics
    trulens_groundedness: Optional[float] = None
    trulens_relevance_llm: Optional[float] = None
    trulens_coherence: Optional[float] = None
    trulens_harmlessness: Optional[float] = None

    # New tiered metrics fields
    total_score: Optional[float] = None
    retrieval_score: Optional[float] = None
    generation_score: Optional[float] = None
    is_failed: Optional[bool] = False
    failure_reason: Optional[str] = None

    # Cross-validation
    cross_validation_results: Optional[Dict[str, Any]] = None
    has_cross_validation_alert: bool = False

    # Diagnostic analyses
    ragas_analysis: Optional[Dict[str, Any]] = None
    trulens_analysis: Optional[Dict[str, Any]] = None
    overall_analysis: Optional[Dict[str, Any]] = None

    # Legacy LLM analysis
    llm_analysis: Optional[Dict[str, Any]] = None
    llm_suggestions: Optional[str] = None

    # Issue tracking
    has_issue: bool
    issue_types: Optional[List[str]] = None

    # Metadata
    evaluation_model: Optional[str] = None
    evaluation_duration_ms: Optional[int] = None
    evaluation_status: str
    original_created_at: datetime
    created_at: datetime

    class Config:
        from_attributes = True


class EvaluationSummaryResponse(BaseModel):
    """Summary statistics for evaluation results."""

    total_evaluated: int
    avg_faithfulness: Optional[float] = None
    avg_answer_relevancy: Optional[float] = None
    avg_context_precision: Optional[float] = None
    avg_overall: Optional[float] = None
    issue_count: int
    issue_rate: float
    cv_alert_count: int = 0
    cv_alert_rate: float = 0.0
    # New tiered metrics fields
    avg_total_score: Optional[float] = None
    failed_count: int = 0
    failed_rate: float = 0.0
    # Core metrics averages
    avg_ragas_query_context_relevance: Optional[float] = None
    avg_trulens_context_relevance: Optional[float] = None
    avg_trulens_groundedness: Optional[float] = None
    # Key metrics averages
    avg_trulens_relevance_llm: Optional[float] = None
    avg_ragas_context_precision_emb: Optional[float] = None


# Alert schemas
class EvaluationAlertItem(BaseModel):
    """Single cross-validation alert."""

    id: int
    evaluation_id: int
    pair_name: str
    eval_target: Optional[str] = None
    signal_source: Optional[str] = None
    scoring_goal: Optional[str] = None
    ragas_metric: Optional[str] = None
    trulens_metric: Optional[str] = None
    ragas_score: Optional[float] = None
    trulens_score: Optional[float] = None
    difference: Optional[float] = None
    threshold: Optional[float] = None
    created_at: datetime

    class Config:
        from_attributes = True


class EvaluationAlertsResponse(BaseModel):
    """Response for alerts list endpoint."""

    items: List[EvaluationAlertItem]
    total: int
    page: int
    page_size: int
    total_pages: int


# Metrics documentation schemas
class ScoreInterpretation(BaseModel):
    """Score interpretation level."""

    min: float
    label: str


class ScoreRange(BaseModel):
    """Score range information."""

    min: float
    max: float
    direction: str


class CrossValidationPairInfo(BaseModel):
    """Cross-validation pair information."""

    paired_metric: str
    paired_framework: str


class MetricDocumentation(BaseModel):
    """Single metric documentation."""

    id: str
    name: str
    name_zh: str
    framework: str
    signal_source: str
    tier: Optional[str] = None
    description: str
    description_zh: str
    implementation: str
    implementation_zh: str
    formula: Optional[str] = None
    score_range: ScoreRange
    interpretation: Dict[str, ScoreInterpretation]
    cross_validation_pair: Optional[CrossValidationPairInfo] = None


class MetricsDocumentationResponse(BaseModel):
    """Response for metrics documentation endpoint."""

    metrics: List[MetricDocumentation]
    total: int
