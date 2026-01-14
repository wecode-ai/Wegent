"""
Service for evaluating conversation records using RAGAS and TruLens.
"""

import asyncio
import math
import time
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional, Union

import structlog
from sqlalchemy import Integer, and_, case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models import (
    ConversationRecord,
    EvaluationAlert,
    EvaluationResult,
    EvaluationStatus,
)
from app.services.cross_validation import cross_validation_service
from app.services.diagnostic_analyzer import diagnostic_analyzer
from app.services.ragas import (
    embedding_metrics_evaluator,
    llm_analyzer,
    llm_metrics_evaluator,
    ragas_evaluator,
)
from app.services.trulens import trulens_embedding_evaluator, trulens_llm_evaluator

logger = structlog.get_logger(__name__)


# In-memory job tracking (for simplicity - could use Redis in production)
evaluation_jobs: Dict[str, Dict[str, Any]] = {}


def sanitize_float(value: Any) -> Optional[float]:
    """
    Sanitize a float value for MySQL storage.
    Converts NaN and Inf values to None since MySQL doesn't support them.

    Args:
        value: The value to sanitize

    Returns:
        The sanitized float value or None if invalid
    """
    if value is None:
        return None
    try:
        float_val = float(value)
        if math.isnan(float_val) or math.isinf(float_val):
            return None
        return float_val
    except (TypeError, ValueError):
        return None


def sanitize_dict(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Recursively sanitize a dictionary, converting NaN/Inf float values to None.

    Args:
        data: The dictionary to sanitize

    Returns:
        The sanitized dictionary
    """
    if not isinstance(data, dict):
        return data

    result = {}
    for key, value in data.items():
        if isinstance(value, dict):
            result[key] = sanitize_dict(value)
        elif isinstance(value, list):
            result[key] = [
                (
                    sanitize_dict(item)
                    if isinstance(item, dict)
                    else sanitize_float(item) if isinstance(item, float) else item
                )
                for item in value
            ]
        elif isinstance(value, float):
            result[key] = sanitize_float(value)
        else:
            result[key] = value
    return result


class EvaluationService:
    """Service for evaluating conversation records using RAGAS and TruLens."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def trigger_evaluation(
        self,
        mode: str,
        start_id: Optional[int] = None,
        end_id: Optional[int] = None,
        record_ids: Optional[List[int]] = None,
        force: bool = False,
    ) -> tuple[str, int]:
        """
        Trigger a new evaluation job.

        Args:
            mode: 'range' or 'ids'
            start_id: Starting record ID (for range mode)
            end_id: Ending record ID (for range mode)
            record_ids: List of specific record IDs (for ids mode)
            force: If True, re-evaluate all records including completed ones

        Returns:
            (job_id, total_records)
        """
        job_id = str(uuid.uuid4())

        # Build query based on mode
        if force:
            # Force mode: evaluate all records regardless of status
            if mode == "range":
                query = select(ConversationRecord).where(
                    and_(
                        ConversationRecord.id >= start_id,
                        ConversationRecord.id <= end_id,
                    )
                )
            else:  # ids mode
                query = select(ConversationRecord).where(
                    ConversationRecord.id.in_(record_ids)
                )
        else:
            # Normal mode: only evaluate PENDING and FAILED records
            allowed_statuses = [EvaluationStatus.PENDING, EvaluationStatus.FAILED]

            if mode == "range":
                query = select(ConversationRecord).where(
                    and_(
                        ConversationRecord.id >= start_id,
                        ConversationRecord.id <= end_id,
                        ConversationRecord.evaluation_status.in_(allowed_statuses),
                    )
                )
            else:  # ids mode
                query = select(ConversationRecord).where(
                    and_(
                        ConversationRecord.id.in_(record_ids),
                        ConversationRecord.evaluation_status.in_(allowed_statuses),
                    )
                )

        result = await self.db.execute(query)
        records = result.scalars().all()
        total_records = len(records)

        # Store job info
        evaluation_jobs[job_id] = {
            "status": "started",
            "total": total_records,
            "completed": 0,
            "failed": 0,
            "skipped": 0,
            "record_ids": [r.id for r in records],
        }

        return job_id, total_records

    async def execute_evaluation(self, job_id: str) -> None:
        """Execute the evaluation job."""
        if job_id not in evaluation_jobs:
            logger.error("Evaluation job not found", job_id=job_id)
            return

        job = evaluation_jobs[job_id]
        job["status"] = "running"

        record_ids = job["record_ids"]

        for record_id in record_ids:
            try:
                await self._evaluate_single_record(record_id)
                job["completed"] += 1
            except Exception as e:
                logger.exception(
                    "Failed to evaluate record", record_id=record_id, error=str(e)
                )
                job["failed"] += 1

        job["status"] = "completed"
        logger.info(
            "Evaluation job completed",
            job_id=job_id,
            completed=job["completed"],
            failed=job["failed"],
        )

    async def _evaluate_single_record(self, record_id: int) -> None:
        """Evaluate a single conversation record using both RAGAS and TruLens."""
        start_time = time.time()

        # Get record
        result = await self.db.execute(
            select(ConversationRecord).where(ConversationRecord.id == record_id)
        )
        record = result.scalar_one_or_none()

        if not record:
            logger.warning("Record not found", record_id=record_id)
            return

        if not record.extracted_text:
            logger.warning("Record has no extracted text", record_id=record_id)
            record.evaluation_status = EvaluationStatus.SKIPPED
            record.skip_reason = "no_extracted_text"
            await self.db.commit()
            return

        try:
            # Update status to processing
            record.evaluation_status = EvaluationStatus.PROCESSING
            await self.db.commit()

            # Prepare contexts list
            contexts = [record.extracted_text]

            # Run all evaluations in parallel
            (
                ragas_result,
                ragas_emb_result,
                ragas_llm_ext_result,
                trulens_emb_result,
                trulens_llm_result,
                legacy_analysis_result,
            ) = await asyncio.gather(
                # Original RAGAS evaluation (faithfulness, answer_relevancy, context_precision)
                ragas_evaluator.evaluate(
                    user_prompt=record.user_prompt,
                    assistant_answer=record.assistant_answer,
                    extracted_text=record.extracted_text,
                ),
                # RAGAS Embedding metrics
                embedding_metrics_evaluator.evaluate_all(
                    query=record.user_prompt,
                    contexts=contexts,
                ),
                # RAGAS LLM extended metrics
                llm_metrics_evaluator.evaluate_all(
                    question=record.user_prompt,
                    context=record.extracted_text,
                    answer=record.assistant_answer,
                ),
                # TruLens Embedding metrics
                trulens_embedding_evaluator.evaluate_all(
                    query=record.user_prompt,
                    contexts=contexts,
                    answer=record.assistant_answer,
                ),
                # TruLens LLM metrics
                trulens_llm_evaluator.evaluate_all(
                    question=record.user_prompt,
                    context=record.extracted_text,
                    answer=record.assistant_answer,
                ),
                # Legacy LLM analysis
                llm_analyzer.analyze(
                    user_prompt=record.user_prompt,
                    assistant_answer=record.assistant_answer,
                    extracted_text=record.extracted_text,
                    faithfulness_score=None,  # Will be filled after RAGAS completes
                    answer_relevancy_score=None,
                    context_precision_score=None,
                    overall_score=None,
                ),
                return_exceptions=True,
            )

            # Handle exceptions in results
            if isinstance(ragas_result, Exception):
                logger.error("RAGAS evaluation failed", error=str(ragas_result))
                ragas_result = {
                    "faithfulness_score": None,
                    "answer_relevancy_score": None,
                    "context_precision_score": None,
                    "overall_score": None,
                    "raw_result": None,
                    "model": settings.RAGAS_LLM_MODEL,
                }

            if isinstance(ragas_emb_result, Exception):
                logger.error(
                    "RAGAS embedding metrics failed", error=str(ragas_emb_result)
                )
                ragas_emb_result = {
                    "query_context_relevance": None,
                    "context_precision_emb": None,
                    "context_diversity": None,
                }

            if isinstance(ragas_llm_ext_result, Exception):
                logger.error(
                    "RAGAS LLM extended metrics failed", error=str(ragas_llm_ext_result)
                )
                ragas_llm_ext_result = {
                    "context_utilization": None,
                    "coherence": None,
                }

            if isinstance(trulens_emb_result, Exception):
                logger.error(
                    "TruLens embedding metrics failed", error=str(trulens_emb_result)
                )
                trulens_emb_result = {
                    "context_relevance": None,
                    "relevance_embedding": None,
                }

            if isinstance(trulens_llm_result, Exception):
                logger.error(
                    "TruLens LLM metrics failed", error=str(trulens_llm_result)
                )
                trulens_llm_result = {
                    "groundedness": None,
                    "relevance_llm": None,
                    "coherence": None,
                    "harmlessness": None,
                }

            if isinstance(legacy_analysis_result, Exception):
                logger.error(
                    "Legacy LLM analysis failed", error=str(legacy_analysis_result)
                )
                legacy_analysis_result = {
                    "analysis": None,
                    "suggestions_summary": None,
                    "has_issue": False,
                    "issue_types": [],
                }

            # Collect all RAGAS metrics
            ragas_metrics = {
                "faithfulness_score": ragas_result.get("faithfulness_score"),
                "answer_relevancy_score": ragas_result.get("answer_relevancy_score"),
                "context_precision_score": ragas_result.get("context_precision_score"),
                "ragas_query_context_relevance": ragas_emb_result.get(
                    "query_context_relevance"
                ),
                "ragas_context_precision_emb": ragas_emb_result.get(
                    "context_precision_emb"
                ),
                "ragas_context_diversity": ragas_emb_result.get("context_diversity"),
                "ragas_context_utilization": ragas_llm_ext_result.get(
                    "context_utilization"
                ),
                "ragas_coherence": ragas_llm_ext_result.get("coherence"),
            }

            # Collect all TruLens metrics
            trulens_metrics = {
                "trulens_context_relevance": trulens_emb_result.get(
                    "context_relevance"
                ),
                "trulens_relevance_embedding": trulens_emb_result.get(
                    "relevance_embedding"
                ),
                "trulens_groundedness": trulens_llm_result.get("groundedness"),
                "trulens_relevance_llm": trulens_llm_result.get("relevance_llm"),
                "trulens_coherence": trulens_llm_result.get("coherence"),
                "trulens_harmlessness": trulens_llm_result.get("harmlessness"),
            }

            # Cross-validation
            cv_result = cross_validation_service.validate(
                ragas_metrics, trulens_metrics
            )

            # Generate diagnostic analyses
            diagnostic_results = await diagnostic_analyzer.analyze_all(
                ragas_metrics=ragas_metrics,
                trulens_metrics=trulens_metrics,
                cross_validation_results=cv_result,
            )

            # Calculate overall score (average of available core scores)
            # Sanitize scores first to handle NaN values
            sanitized_faithfulness = sanitize_float(
                ragas_result.get("faithfulness_score")
            )
            sanitized_answer_relevancy = sanitize_float(
                ragas_result.get("answer_relevancy_score")
            )
            sanitized_context_precision = sanitize_float(
                ragas_result.get("context_precision_score")
            )

            core_scores = [
                sanitized_faithfulness,
                sanitized_answer_relevancy,
                sanitized_context_precision,
            ]
            valid_scores = [s for s in core_scores if s is not None]
            overall_score = sanitize_float(
                sum(valid_scores) / len(valid_scores) if valid_scores else None
            )

            duration_ms = int((time.time() - start_time) * 1000)

            # Sanitize JSON fields to handle NaN values in nested structures
            sanitized_cv_result = sanitize_dict(cv_result) if cv_result else None
            sanitized_ragas_raw = (
                sanitize_dict(ragas_result.get("raw_result"))
                if ragas_result.get("raw_result")
                else None
            )
            sanitized_ragas_analysis = (
                sanitize_dict(diagnostic_results.get("ragas_analysis"))
                if diagnostic_results.get("ragas_analysis")
                else None
            )
            sanitized_trulens_analysis = (
                sanitize_dict(diagnostic_results.get("trulens_analysis"))
                if diagnostic_results.get("trulens_analysis")
                else None
            )
            sanitized_overall_analysis = (
                sanitize_dict(diagnostic_results.get("overall_analysis"))
                if diagnostic_results.get("overall_analysis")
                else None
            )
            sanitized_llm_analysis = (
                sanitize_dict(legacy_analysis_result.get("analysis"))
                if legacy_analysis_result.get("analysis")
                else None
            )

            # Create or update evaluation result
            existing_result = await self.db.execute(
                select(EvaluationResult).where(
                    EvaluationResult.conversation_record_id == record_id
                )
            )
            evaluation = existing_result.scalar_one_or_none()

            if evaluation:
                # Update existing evaluation
                self._update_evaluation_result(
                    evaluation,
                    ragas_result,
                    ragas_emb_result,
                    ragas_llm_ext_result,
                    trulens_emb_result,
                    trulens_llm_result,
                    sanitized_cv_result,
                    {
                        "ragas_analysis": sanitized_ragas_analysis,
                        "trulens_analysis": sanitized_trulens_analysis,
                        "overall_analysis": sanitized_overall_analysis,
                    },
                    legacy_analysis_result,
                    overall_score,
                    duration_ms,
                )
            else:
                # Create new evaluation with sanitized float values
                evaluation = EvaluationResult(
                    conversation_record_id=record_id,
                    # Legacy RAGAS scores (sanitized)
                    faithfulness_score=sanitized_faithfulness,
                    answer_relevancy_score=sanitized_answer_relevancy,
                    context_precision_score=sanitized_context_precision,
                    overall_score=overall_score,
                    ragas_raw_result=sanitized_ragas_raw,
                    # RAGAS Embedding metrics (sanitized)
                    ragas_query_context_relevance=sanitize_float(
                        ragas_emb_result.get("query_context_relevance")
                    ),
                    ragas_context_precision_emb=sanitize_float(
                        ragas_emb_result.get("context_precision_emb")
                    ),
                    ragas_context_diversity=sanitize_float(
                        ragas_emb_result.get("context_diversity")
                    ),
                    # RAGAS LLM extended metrics (sanitized)
                    ragas_context_utilization=sanitize_float(
                        ragas_llm_ext_result.get("context_utilization")
                    ),
                    ragas_coherence=sanitize_float(
                        ragas_llm_ext_result.get("coherence")
                    ),
                    # TruLens Embedding metrics (sanitized)
                    trulens_context_relevance=sanitize_float(
                        trulens_emb_result.get("context_relevance")
                    ),
                    trulens_relevance_embedding=sanitize_float(
                        trulens_emb_result.get("relevance_embedding")
                    ),
                    # TruLens LLM metrics (sanitized)
                    trulens_groundedness=sanitize_float(
                        trulens_llm_result.get("groundedness")
                    ),
                    trulens_relevance_llm=sanitize_float(
                        trulens_llm_result.get("relevance_llm")
                    ),
                    trulens_coherence=sanitize_float(
                        trulens_llm_result.get("coherence")
                    ),
                    trulens_harmlessness=sanitize_float(
                        trulens_llm_result.get("harmlessness")
                    ),
                    # Cross-validation (sanitized)
                    cross_validation_results=sanitized_cv_result,
                    has_cross_validation_alert=(
                        sanitized_cv_result.get("has_alert", False)
                        if sanitized_cv_result
                        else False
                    ),
                    # Diagnostic analyses (sanitized)
                    ragas_analysis=sanitized_ragas_analysis,
                    trulens_analysis=sanitized_trulens_analysis,
                    overall_analysis=sanitized_overall_analysis,
                    # Legacy
                    llm_analysis=sanitized_llm_analysis,
                    llm_suggestions=legacy_analysis_result.get("suggestions_summary"),
                    has_issue=legacy_analysis_result.get("has_issue", False),
                    issue_types=legacy_analysis_result.get("issue_types", []),
                    evaluation_model=settings.RAGAS_LLM_MODEL,
                    evaluation_duration_ms=duration_ms,
                )
                self.db.add(evaluation)

            # Calculate tiered scores
            evaluation.calculate_tiered_scores()

            await self.db.flush()

            # Create alerts if needed
            if cv_result.get("has_alert", False):
                await self._create_alerts(evaluation.id, cv_result)

            # Update record status
            record.evaluation_status = EvaluationStatus.COMPLETED
            await self.db.commit()

            logger.info(
                "Record evaluated successfully",
                record_id=record_id,
                overall_score=overall_score,
                has_cv_alert=cv_result.get("has_alert", False),
                duration_ms=duration_ms,
            )

        except Exception as e:
            logger.exception("Evaluation failed", record_id=record_id, error=str(e))
            record.evaluation_status = EvaluationStatus.FAILED
            await self.db.commit()
            raise

    def _update_evaluation_result(
        self,
        evaluation: EvaluationResult,
        ragas_result: Dict,
        ragas_emb_result: Dict,
        ragas_llm_ext_result: Dict,
        trulens_emb_result: Dict,
        trulens_llm_result: Dict,
        cv_result: Dict,
        diagnostic_results: Dict,
        legacy_analysis_result: Dict,
        overall_score: Optional[float],
        duration_ms: int,
    ) -> None:
        """Update an existing evaluation result with new data.

        Note: cv_result and diagnostic_results should already be sanitized
        by the caller to handle NaN values in JSON fields.
        """
        # Legacy RAGAS scores (sanitized)
        evaluation.faithfulness_score = sanitize_float(
            ragas_result.get("faithfulness_score")
        )
        evaluation.answer_relevancy_score = sanitize_float(
            ragas_result.get("answer_relevancy_score")
        )
        evaluation.context_precision_score = sanitize_float(
            ragas_result.get("context_precision_score")
        )
        evaluation.overall_score = sanitize_float(overall_score)
        # Sanitize raw_result JSON
        raw_result = ragas_result.get("raw_result")
        evaluation.ragas_raw_result = sanitize_dict(raw_result) if raw_result else None
        # RAGAS Embedding metrics (sanitized)
        evaluation.ragas_query_context_relevance = sanitize_float(
            ragas_emb_result.get("query_context_relevance")
        )
        evaluation.ragas_context_precision_emb = sanitize_float(
            ragas_emb_result.get("context_precision_emb")
        )
        evaluation.ragas_context_diversity = sanitize_float(
            ragas_emb_result.get("context_diversity")
        )
        # RAGAS LLM extended metrics (sanitized)
        evaluation.ragas_context_utilization = sanitize_float(
            ragas_llm_ext_result.get("context_utilization")
        )
        evaluation.ragas_coherence = sanitize_float(
            ragas_llm_ext_result.get("coherence")
        )
        # TruLens Embedding metrics (sanitized)
        evaluation.trulens_context_relevance = sanitize_float(
            trulens_emb_result.get("context_relevance")
        )
        evaluation.trulens_relevance_embedding = sanitize_float(
            trulens_emb_result.get("relevance_embedding")
        )
        # TruLens LLM metrics (sanitized)
        evaluation.trulens_groundedness = sanitize_float(
            trulens_llm_result.get("groundedness")
        )
        evaluation.trulens_relevance_llm = sanitize_float(
            trulens_llm_result.get("relevance_llm")
        )
        evaluation.trulens_coherence = sanitize_float(
            trulens_llm_result.get("coherence")
        )
        evaluation.trulens_harmlessness = sanitize_float(
            trulens_llm_result.get("harmlessness")
        )
        # Cross-validation (already sanitized by caller)
        evaluation.cross_validation_results = cv_result
        evaluation.has_cross_validation_alert = (
            cv_result.get("has_alert", False) if cv_result else False
        )
        # Diagnostic analyses (already sanitized by caller)
        evaluation.ragas_analysis = diagnostic_results.get("ragas_analysis")
        evaluation.trulens_analysis = diagnostic_results.get("trulens_analysis")
        evaluation.overall_analysis = diagnostic_results.get("overall_analysis")
        # Legacy - sanitize llm_analysis JSON
        llm_analysis = legacy_analysis_result.get("analysis")
        evaluation.llm_analysis = sanitize_dict(llm_analysis) if llm_analysis else None
        evaluation.llm_suggestions = legacy_analysis_result.get("suggestions_summary")
        evaluation.has_issue = legacy_analysis_result.get("has_issue", False)
        evaluation.issue_types = legacy_analysis_result.get("issue_types", [])
        evaluation.evaluation_model = settings.RAGAS_LLM_MODEL
        evaluation.evaluation_duration_ms = duration_ms
        evaluation.created_at = datetime.utcnow()
        # Calculate tiered scores
        evaluation.calculate_tiered_scores()

    async def _create_alerts(self, evaluation_id: int, cv_result: Dict) -> None:
        """Create alert records for cross-validation alerts."""
        for pair in cv_result.get("pairs", []):
            if pair.get("is_alert", False):
                alert = EvaluationAlert(
                    evaluation_id=evaluation_id,
                    pair_name=pair["name"],
                    eval_target=pair.get("eval_target"),
                    signal_source=pair.get("signal_source"),
                    scoring_goal=pair.get("scoring_goal"),
                    ragas_metric=pair.get("ragas_metric"),
                    trulens_metric=pair.get("trulens_metric"),
                    # Sanitize float values for alerts
                    ragas_score=sanitize_float(pair.get("ragas_score")),
                    trulens_score=sanitize_float(pair.get("trulens_score")),
                    difference=sanitize_float(pair.get("difference")),
                    threshold=sanitize_float(pair.get("threshold")),
                )
                self.db.add(alert)

    def get_job_status(self, job_id: str) -> Optional[Dict[str, Any]]:
        """Get status of an evaluation job."""
        return evaluation_jobs.get(job_id)

    async def get_results(
        self,
        page: int = 1,
        page_size: int = 20,
        start_date: Optional[datetime] = None,
        end_date: Optional[datetime] = None,
        has_issue: Optional[bool] = None,
        min_score: Optional[float] = None,
        max_score: Optional[float] = None,
        retriever_name: Optional[str] = None,
        embedding_model: Optional[str] = None,
        knowledge_id: Optional[int] = None,
        evaluation_status: Optional[str] = None,
        has_cv_alert: Optional[bool] = None,
        issue_type: Optional[str] = None,
        version_id: Optional[int] = None,
    ) -> tuple[List[Dict[str, Any]], int]:
        """Get evaluation results with filtering and pagination."""
        from app.services.filter_utils import apply_user_filter

        # Build query
        query = select(ConversationRecord, EvaluationResult).outerjoin(
            EvaluationResult,
            ConversationRecord.id == EvaluationResult.conversation_record_id,
        )

        # Apply user ID exclusion filter
        query = apply_user_filter(query)

        conditions = []

        # Version filter
        if version_id is not None:
            conditions.append(ConversationRecord.version_id == version_id)

        if start_date:
            conditions.append(ConversationRecord.original_created_at >= start_date)
        if end_date:
            conditions.append(ConversationRecord.original_created_at <= end_date)
        if has_issue is not None:
            conditions.append(EvaluationResult.has_issue == has_issue)
        if min_score is not None:
            conditions.append(EvaluationResult.overall_score >= min_score)
        if max_score is not None:
            conditions.append(EvaluationResult.overall_score <= max_score)
        if retriever_name:
            conditions.append(ConversationRecord.retriever_name == retriever_name)
        if embedding_model:
            conditions.append(ConversationRecord.embedding_model == embedding_model)
        if knowledge_id:
            conditions.append(ConversationRecord.knowledge_id == knowledge_id)
        if evaluation_status:
            conditions.append(
                ConversationRecord.evaluation_status
                == EvaluationStatus(evaluation_status)
            )
        if has_cv_alert is not None:
            conditions.append(
                EvaluationResult.has_cross_validation_alert == has_cv_alert
            )
        if issue_type:
            # Filter by issue_type using JSON_CONTAINS for MySQL
            # issue_types is a JSON array, e.g., ["retrieval_miss", "answer_incomplete"]
            conditions.append(
                func.json_contains(
                    EvaluationResult.issue_types,
                    func.json_quote(issue_type),
                )
                == 1
            )

        if conditions:
            query = query.where(and_(*conditions))

        # Count total
        count_query = select(func.count()).select_from(query.subquery())
        count_result = await self.db.execute(count_query)
        total = count_result.scalar()

        # Get paginated results
        offset = (page - 1) * page_size
        query = (
            query.order_by(ConversationRecord.original_created_at.desc())
            .offset(offset)
            .limit(page_size)
        )

        result = await self.db.execute(query)
        rows = result.all()

        items = []
        for record, evaluation in rows:
            item = {
                "id": evaluation.id if evaluation else None,
                "conversation_record_id": record.id,
                "user_prompt": (
                    record.user_prompt[:200] + "..."
                    if len(record.user_prompt) > 200
                    else record.user_prompt
                ),
                "assistant_answer": (
                    record.assistant_answer[:200] + "..."
                    if len(record.assistant_answer) > 200
                    else record.assistant_answer
                ),
                "extracted_text": (
                    record.extracted_text[:200] + "..."
                    if record.extracted_text and len(record.extracted_text) > 200
                    else record.extracted_text
                ),
                "faithfulness_score": (
                    evaluation.faithfulness_score if evaluation else None
                ),
                "answer_relevancy_score": (
                    evaluation.answer_relevancy_score if evaluation else None
                ),
                "context_precision_score": (
                    evaluation.context_precision_score if evaluation else None
                ),
                "overall_score": evaluation.overall_score if evaluation else None,
                "has_issue": evaluation.has_issue if evaluation else False,
                "has_cv_alert": (
                    evaluation.has_cross_validation_alert if evaluation else False
                ),
                "issue_types": evaluation.issue_types if evaluation else None,
                "retriever_name": record.retriever_name,
                "embedding_model": record.embedding_model,
                "knowledge_name": record.knowledge_name,
                "evaluation_status": record.evaluation_status.value,
                "created_at": (
                    evaluation.created_at if evaluation else record.created_at
                ),
                # New tiered metrics fields
                "total_score": evaluation.total_score if evaluation else None,
                "retrieval_score": evaluation.retrieval_score if evaluation else None,
                "generation_score": evaluation.generation_score if evaluation else None,
                "is_failed": evaluation.is_failed if evaluation else False,
                "failure_reason": evaluation.failure_reason if evaluation else None,
                # TruLens groundedness for list view (事实性)
                "trulens_groundedness": (
                    evaluation.trulens_groundedness if evaluation else None
                ),
            }
            items.append(item)

        return items, total

    async def get_result_detail(self, result_id: int) -> Optional[Dict[str, Any]]:
        """Get detailed evaluation result including all metrics."""
        query = (
            select(ConversationRecord, EvaluationResult)
            .outerjoin(
                EvaluationResult,
                ConversationRecord.id == EvaluationResult.conversation_record_id,
            )
            .where(EvaluationResult.id == result_id)
        )

        result = await self.db.execute(query)
        row = result.first()

        if not row:
            return None

        record, evaluation = row

        return {
            "id": evaluation.id,
            "conversation_record_id": record.id,
            "user_prompt": record.user_prompt,
            "assistant_answer": record.assistant_answer,
            "extracted_text": record.extracted_text,
            "knowledge_id": record.knowledge_id,
            "knowledge_name": record.knowledge_name,
            "retriever_name": record.retriever_name,
            "embedding_model": record.embedding_model,
            "retrieval_mode": record.retrieval_mode,
            "knowledge_base_result": record.knowledge_base_result,
            "knowledge_base_config": record.knowledge_base_config,
            # Legacy RAGAS scores
            "faithfulness_score": evaluation.faithfulness_score,
            "answer_relevancy_score": evaluation.answer_relevancy_score,
            "context_precision_score": evaluation.context_precision_score,
            "overall_score": evaluation.overall_score,
            # RAGAS Embedding metrics
            "ragas_query_context_relevance": evaluation.ragas_query_context_relevance,
            "ragas_context_precision_emb": evaluation.ragas_context_precision_emb,
            "ragas_context_diversity": evaluation.ragas_context_diversity,
            # RAGAS LLM metrics
            "ragas_context_utilization": evaluation.ragas_context_utilization,
            "ragas_coherence": evaluation.ragas_coherence,
            # TruLens Embedding metrics
            "trulens_context_relevance": evaluation.trulens_context_relevance,
            "trulens_relevance_embedding": evaluation.trulens_relevance_embedding,
            # TruLens LLM metrics
            "trulens_groundedness": evaluation.trulens_groundedness,
            "trulens_relevance_llm": evaluation.trulens_relevance_llm,
            "trulens_coherence": evaluation.trulens_coherence,
            "trulens_harmlessness": evaluation.trulens_harmlessness,
            # New tiered metrics fields
            "total_score": evaluation.total_score,
            "retrieval_score": evaluation.retrieval_score,
            "generation_score": evaluation.generation_score,
            "is_failed": evaluation.is_failed,
            "failure_reason": evaluation.failure_reason,
            # Cross-validation
            "cross_validation_results": evaluation.cross_validation_results,
            "has_cross_validation_alert": evaluation.has_cross_validation_alert,
            # Diagnostic analyses
            "ragas_analysis": evaluation.ragas_analysis,
            "trulens_analysis": evaluation.trulens_analysis,
            "overall_analysis": evaluation.overall_analysis,
            # Legacy
            "llm_analysis": evaluation.llm_analysis,
            "llm_suggestions": evaluation.llm_suggestions,
            "has_issue": evaluation.has_issue,
            "issue_types": evaluation.issue_types,
            "evaluation_model": evaluation.evaluation_model,
            "evaluation_duration_ms": evaluation.evaluation_duration_ms,
            "evaluation_status": record.evaluation_status.value,
            "original_created_at": record.original_created_at,
            "created_at": evaluation.created_at,
        }

    async def get_summary(
        self,
        start_date: Optional[datetime] = None,
        end_date: Optional[datetime] = None,
        version_id: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Get summary statistics for evaluation results."""
        from app.services.filter_utils import apply_user_filter

        conditions = []

        # Version filter
        if version_id is not None:
            conditions.append(ConversationRecord.version_id == version_id)

        if start_date:
            conditions.append(ConversationRecord.original_created_at >= start_date)
        if end_date:
            conditions.append(ConversationRecord.original_created_at <= end_date)

        # Base query with join
        base_query = select(EvaluationResult).join(
            ConversationRecord,
            ConversationRecord.id == EvaluationResult.conversation_record_id,
        )

        # Apply user ID exclusion filter
        base_query = apply_user_filter(base_query)

        if conditions:
            base_query = base_query.where(and_(*conditions))

        # Count total
        count_query = select(func.count()).select_from(base_query.subquery())
        count_result = await self.db.execute(count_query)
        total = count_result.scalar() or 0

        # Get averages
        avg_query = select(
            func.avg(EvaluationResult.faithfulness_score),
            func.avg(EvaluationResult.answer_relevancy_score),
            func.avg(EvaluationResult.context_precision_score),
            func.avg(EvaluationResult.overall_score),
            func.sum(
                case((EvaluationResult.has_issue == True, 1), else_=0)
            ),  # noqa: E712
            func.sum(
                case((EvaluationResult.has_cross_validation_alert == True, 1), else_=0)
            ),  # noqa: E712
            # New tiered metrics averages
            func.avg(EvaluationResult.total_score),
            func.sum(
                case((EvaluationResult.is_failed == True, 1), else_=0)
            ),  # noqa: E712
            func.avg(EvaluationResult.ragas_query_context_relevance),
            func.avg(EvaluationResult.trulens_context_relevance),
            func.avg(EvaluationResult.trulens_groundedness),
            func.avg(EvaluationResult.trulens_relevance_llm),
            func.avg(EvaluationResult.ragas_context_precision_emb),
        ).join(
            ConversationRecord,
            ConversationRecord.id == EvaluationResult.conversation_record_id,
        )
        # Apply user ID exclusion filter
        avg_query = apply_user_filter(avg_query)
        if conditions:
            avg_query = avg_query.where(and_(*conditions))

        avg_result = await self.db.execute(avg_query)
        row = avg_result.first()

        issue_count = int(row[4]) if row and row[4] else 0
        cv_alert_count = int(row[5]) if row and row[5] else 0
        failed_count = int(row[7]) if row and row[7] else 0

        return {
            "total_evaluated": total,
            "avg_faithfulness": float(row[0]) if row and row[0] else None,
            "avg_answer_relevancy": float(row[1]) if row and row[1] else None,
            "avg_context_precision": float(row[2]) if row and row[2] else None,
            "avg_overall": float(row[3]) if row and row[3] else None,
            "issue_count": issue_count,
            "issue_rate": issue_count / total if total > 0 else 0,
            "cv_alert_count": cv_alert_count,
            "cv_alert_rate": cv_alert_count / total if total > 0 else 0,
            # New tiered metrics
            "avg_total_score": float(row[6]) if row and row[6] else None,
            "failed_count": failed_count,
            "failed_rate": failed_count / total if total > 0 else 0,
            "avg_ragas_query_context_relevance": (
                float(row[8]) if row and row[8] else None
            ),
            "avg_trulens_context_relevance": float(row[9]) if row and row[9] else None,
            "avg_trulens_groundedness": float(row[10]) if row and row[10] else None,
            "avg_trulens_relevance_llm": float(row[11]) if row and row[11] else None,
            "avg_ragas_context_precision_emb": (
                float(row[12]) if row and row[12] else None
            ),
        }

    async def get_alerts(
        self,
        page: int = 1,
        page_size: int = 20,
        threshold: Optional[float] = None,
        version_id: Optional[int] = None,
    ) -> tuple[List[Dict[str, Any]], int]:
        """Get cross-validation alerts with pagination."""
        from app.services.filter_utils import apply_user_filter

        # Build query with joins to filter by version and user
        query = (
            select(EvaluationAlert)
            .join(
                EvaluationResult,
                EvaluationAlert.evaluation_id == EvaluationResult.id,
            )
            .join(
                ConversationRecord,
                ConversationRecord.id == EvaluationResult.conversation_record_id,
            )
        )

        # Apply user ID exclusion filter
        query = apply_user_filter(query)

        conditions = []

        if threshold is not None:
            conditions.append(EvaluationAlert.difference > threshold)

        if version_id is not None:
            conditions.append(EvaluationResult.version_id == version_id)

        if conditions:
            query = query.where(and_(*conditions))

        # Count total
        count_query = select(func.count()).select_from(query.subquery())
        count_result = await self.db.execute(count_query)
        total = count_result.scalar() or 0

        # Get paginated results
        offset = (page - 1) * page_size
        query = (
            query.order_by(EvaluationAlert.created_at.desc())
            .offset(offset)
            .limit(page_size)
        )

        result = await self.db.execute(query)
        alerts = result.scalars().all()

        items = []
        for alert in alerts:
            items.append(
                {
                    "id": alert.id,
                    "evaluation_id": alert.evaluation_id,
                    "pair_name": alert.pair_name,
                    "eval_target": alert.eval_target,
                    "signal_source": alert.signal_source,
                    "scoring_goal": alert.scoring_goal,
                    "ragas_metric": alert.ragas_metric,
                    "trulens_metric": alert.trulens_metric,
                    "ragas_score": alert.ragas_score,
                    "trulens_score": alert.trulens_score,
                    "difference": alert.difference,
                    "threshold": alert.threshold,
                    "created_at": alert.created_at,
                }
            )

        return items, total
