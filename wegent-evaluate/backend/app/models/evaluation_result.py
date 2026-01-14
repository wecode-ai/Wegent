"""
EvaluationResult model for storing RAGAS and TruLens evaluation results.
"""
from datetime import datetime
from typing import Optional

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
)
from sqlalchemy.orm import relationship

from app.core.database import Base


class EvaluationResult(Base):
    """Model for storing RAGAS and TruLens evaluation results."""

    __tablename__ = "evaluation_results"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    conversation_record_id = Column(
        BigInteger,
        ForeignKey("conversation_records.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
    )

    # Version ID for data versioning
    version_id = Column(
        BigInteger,
        ForeignKey("data_versions.id"),
        nullable=False,
        index=True,
    )

    # Legacy RAGAS scores (0-1) - kept for backward compatibility
    faithfulness_score = Column(Float, nullable=True)
    answer_relevancy_score = Column(Float, nullable=True)
    context_precision_score = Column(Float, nullable=True)
    overall_score = Column(Float, nullable=True)

    # RAGAS Embedding-based metrics
    ragas_query_context_relevance = Column(Float, nullable=True)
    ragas_context_precision_emb = Column(Float, nullable=True)
    ragas_context_diversity = Column(Float, nullable=True)

    # RAGAS LLM-based metrics (faithfulness and answer_relevancy above are kept for compatibility)
    ragas_context_utilization = Column(Float, nullable=True)
    ragas_coherence = Column(Float, nullable=True)

    # TruLens Embedding-based metrics
    trulens_context_relevance = Column(Float, nullable=True)
    trulens_relevance_embedding = Column(Float, nullable=True)

    # TruLens LLM-based metrics
    trulens_groundedness = Column(Float, nullable=True)
    trulens_relevance_llm = Column(Float, nullable=True)
    trulens_coherence = Column(Float, nullable=True)
    trulens_harmlessness = Column(Float, nullable=True)

    # New tiered metrics fields
    total_score = Column(Float, nullable=True)  # 0-100
    retrieval_score = Column(Float, nullable=True)  # 0-1
    generation_score = Column(Float, nullable=True)  # 0-1
    is_failed = Column(Boolean, default=False, nullable=True)
    failure_reason = Column(String(500), nullable=True)

    # Cross-validation results
    cross_validation_results = Column(JSON, nullable=True)
    has_cross_validation_alert = Column(Boolean, default=False, nullable=True)

    # LLM diagnostic analysis results
    ragas_analysis = Column(JSON, nullable=True)
    trulens_analysis = Column(JSON, nullable=True)
    overall_analysis = Column(JSON, nullable=True)

    # Raw RAGAS result
    ragas_raw_result = Column(JSON, nullable=True)

    # LLM analysis result (legacy)
    llm_analysis = Column(JSON, nullable=True)
    llm_suggestions = Column(Text, nullable=True)

    # Issue tracking
    has_issue = Column(Boolean, default=False, nullable=False, index=True)
    issue_types = Column(JSON, nullable=True)

    # Evaluation metadata
    evaluation_model = Column(String(100), nullable=True)
    evaluation_duration_ms = Column(Integer, nullable=True)

    # Timestamp
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)

    # Relationship to conversation record
    conversation_record = relationship(
        "ConversationRecord", back_populates="evaluation_result"
    )

    # Relationship to alerts
    alerts = relationship(
        "EvaluationAlert", back_populates="evaluation_result", cascade="all, delete-orphan"
    )

    __table_args__ = (
        Index("idx_conversation_record_id", "conversation_record_id"),
        Index("idx_created_at", "created_at"),
        Index("idx_has_issue", "has_issue"),
        Index("idx_overall_score", "overall_score"),
        Index("idx_er_has_cv_alert", "has_cross_validation_alert"),
        Index("idx_total_score", "total_score"),
        Index("idx_is_failed", "is_failed"),
        Index("idx_er_version_id", "version_id"),
    )

    def calculate_tiered_scores(self) -> None:
        """Calculate total score, retrieval score, generation score, and failure status."""
        # Retrieval Score (45%)
        retrieval = (
            0.25 * (self.ragas_query_context_relevance or 0)
            + 0.15 * (self.trulens_context_relevance or 0)
            + 0.05 * (self.ragas_context_precision_emb or 0)
        )

        # Generation Score (55%)
        generation = (
            0.30 * (self.faithfulness_score or 0)
            + 0.20 * (self.trulens_groundedness or 0)
            + 0.05 * (self.answer_relevancy_score or 0)
        )

        self.retrieval_score = retrieval
        self.generation_score = generation
        self.total_score = 100 * (retrieval + generation)

        # Hard threshold check
        faithfulness = self.faithfulness_score or 0
        groundedness = self.trulens_groundedness or 0

        reasons = []
        if faithfulness < 0.6:
            reasons.append(f"Faithfulness ({faithfulness:.2f}) < 0.6")
        if groundedness < 0.6:
            reasons.append(f"Groundedness ({groundedness:.2f}) < 0.6")

        self.is_failed = len(reasons) > 0
        self.failure_reason = "; ".join(reasons) if reasons else None

    def __repr__(self) -> str:
        return f"<EvaluationResult(id={self.id}, total_score={self.total_score}, is_failed={self.is_failed})>"


class EvaluationAlert(Base):
    """Model for storing cross-validation alerts."""

    __tablename__ = "evaluation_alerts"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    evaluation_id = Column(
        BigInteger,
        ForeignKey("evaluation_results.id", ondelete="CASCADE"),
        nullable=False,
    )
    pair_name = Column(String(100), nullable=False)
    eval_target = Column(String(50), nullable=True)
    signal_source = Column(String(50), nullable=True)
    scoring_goal = Column(String(50), nullable=True)
    ragas_metric = Column(String(100), nullable=True)
    trulens_metric = Column(String(100), nullable=True)
    ragas_score = Column(Float, nullable=True)
    trulens_score = Column(Float, nullable=True)
    difference = Column(Float, nullable=True)
    threshold = Column(Float, default=0.2, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    # Relationship to evaluation result
    evaluation_result = relationship("EvaluationResult", back_populates="alerts")

    __table_args__ = (
        Index("idx_ea_evaluation_id", "evaluation_id"),
        Index("idx_ea_pair_name", "pair_name"),
        Index("idx_ea_created_at", "created_at"),
    )

    def __repr__(self) -> str:
        return f"<EvaluationAlert(id={self.id}, pair_name={self.pair_name}, difference={self.difference})>"
