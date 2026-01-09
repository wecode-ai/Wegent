"""
Service for analytics and statistics.
"""
from collections import defaultdict
from datetime import datetime
from typing import Any, Dict, List, Optional

import structlog
from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ConversationRecord, EvaluationResult

logger = structlog.get_logger(__name__)


class AnalyticsService:
    """Service for analytics and statistics."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def get_trends(
        self,
        start_date: datetime,
        end_date: datetime,
        metric: str = "overall",
        group_by: str = "day",
        retriever_name: Optional[str] = None,
        embedding_model: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Get trend data for a specific metric over time."""
        # Determine date truncation based on group_by
        if group_by == "day":
            date_trunc = func.date(ConversationRecord.original_created_at)
        elif group_by == "week":
            date_trunc = func.yearweek(ConversationRecord.original_created_at)
        else:  # month
            date_trunc = func.date_format(
                ConversationRecord.original_created_at, "%Y-%m"
            )

        # Map metric name to column
        metric_map = {
            "faithfulness": EvaluationResult.faithfulness_score,
            "answer_relevancy": EvaluationResult.answer_relevancy_score,
            "context_precision": EvaluationResult.context_precision_score,
            "overall": EvaluationResult.overall_score,
        }

        metric_column = metric_map.get(metric, EvaluationResult.overall_score)

        # Build query
        query = (
            select(
                date_trunc.label("date"),
                func.avg(metric_column).label("avg_score"),
                func.count().label("count"),
            )
            .join(
                ConversationRecord,
                ConversationRecord.id == EvaluationResult.conversation_record_id,
            )
            .where(
                and_(
                    ConversationRecord.original_created_at >= start_date,
                    ConversationRecord.original_created_at <= end_date,
                )
            )
            .group_by(date_trunc)
            .order_by(date_trunc)
        )

        if retriever_name:
            query = query.where(ConversationRecord.retriever_name == retriever_name)
        if embedding_model:
            query = query.where(ConversationRecord.embedding_model == embedding_model)

        result = await self.db.execute(query)
        rows = result.all()

        return [
            {
                "date": str(row.date),
                "avg_score": float(row.avg_score) if row.avg_score else 0,
                "count": row.count,
            }
            for row in rows
        ]

    async def get_retriever_comparison(
        self,
        start_date: datetime,
        end_date: datetime,
    ) -> List[Dict[str, Any]]:
        """Compare evaluation metrics across different retrievers."""
        query = (
            select(
                ConversationRecord.retriever_name,
                func.avg(EvaluationResult.faithfulness_score).label("avg_faithfulness"),
                func.avg(EvaluationResult.answer_relevancy_score).label(
                    "avg_answer_relevancy"
                ),
                func.avg(EvaluationResult.context_precision_score).label(
                    "avg_context_precision"
                ),
                func.avg(EvaluationResult.overall_score).label("avg_overall"),
                func.count().label("count"),
            )
            .join(
                ConversationRecord,
                ConversationRecord.id == EvaluationResult.conversation_record_id,
            )
            .where(
                and_(
                    ConversationRecord.original_created_at >= start_date,
                    ConversationRecord.original_created_at <= end_date,
                    ConversationRecord.retriever_name.isnot(None),
                )
            )
            .group_by(ConversationRecord.retriever_name)
        )

        result = await self.db.execute(query)
        rows = result.all()

        return [
            {
                "retriever_name": row.retriever_name,
                "avg_faithfulness": float(row.avg_faithfulness) if row.avg_faithfulness else None,
                "avg_answer_relevancy": float(row.avg_answer_relevancy) if row.avg_answer_relevancy else None,
                "avg_context_precision": float(row.avg_context_precision) if row.avg_context_precision else None,
                "avg_overall": float(row.avg_overall) if row.avg_overall else None,
                "count": row.count,
            }
            for row in rows
        ]

    async def get_embedding_comparison(
        self,
        start_date: datetime,
        end_date: datetime,
    ) -> List[Dict[str, Any]]:
        """Compare evaluation metrics across different embedding models."""
        query = (
            select(
                ConversationRecord.embedding_model,
                func.avg(EvaluationResult.faithfulness_score).label("avg_faithfulness"),
                func.avg(EvaluationResult.answer_relevancy_score).label(
                    "avg_answer_relevancy"
                ),
                func.avg(EvaluationResult.context_precision_score).label(
                    "avg_context_precision"
                ),
                func.avg(EvaluationResult.overall_score).label("avg_overall"),
                func.count().label("count"),
            )
            .join(
                ConversationRecord,
                ConversationRecord.id == EvaluationResult.conversation_record_id,
            )
            .where(
                and_(
                    ConversationRecord.original_created_at >= start_date,
                    ConversationRecord.original_created_at <= end_date,
                    ConversationRecord.embedding_model.isnot(None),
                )
            )
            .group_by(ConversationRecord.embedding_model)
        )

        result = await self.db.execute(query)
        rows = result.all()

        return [
            {
                "embedding_model": row.embedding_model,
                "avg_faithfulness": float(row.avg_faithfulness) if row.avg_faithfulness else None,
                "avg_answer_relevancy": float(row.avg_answer_relevancy) if row.avg_answer_relevancy else None,
                "avg_context_precision": float(row.avg_context_precision) if row.avg_context_precision else None,
                "avg_overall": float(row.avg_overall) if row.avg_overall else None,
                "count": row.count,
            }
            for row in rows
        ]

    async def get_context_comparison(
        self,
        subtask_context_id: int,
    ) -> Dict[str, Any]:
        """Get comparison of all evaluations for a specific context."""
        query = (
            select(ConversationRecord, EvaluationResult)
            .outerjoin(
                EvaluationResult,
                ConversationRecord.id == EvaluationResult.conversation_record_id,
            )
            .where(ConversationRecord.subtask_context_id == subtask_context_id)
            .order_by(ConversationRecord.original_created_at)
        )

        result = await self.db.execute(query)
        rows = result.all()

        records = []
        for record, evaluation in rows:
            records.append(
                {
                    "id": record.id,
                    "original_created_at": record.original_created_at,
                    "retriever_name": record.retriever_name,
                    "embedding_model": record.embedding_model,
                    "faithfulness_score": evaluation.faithfulness_score if evaluation else None,
                    "answer_relevancy_score": evaluation.answer_relevancy_score if evaluation else None,
                    "context_precision_score": evaluation.context_precision_score if evaluation else None,
                    "overall_score": evaluation.overall_score if evaluation else None,
                }
            )

        return {
            "subtask_context_id": subtask_context_id,
            "records": records,
        }

    async def get_issues_analytics(
        self,
        start_date: datetime,
        end_date: datetime,
    ) -> Dict[str, Any]:
        """Get analytics on issue types."""
        query = (
            select(EvaluationResult.issue_types)
            .join(
                ConversationRecord,
                ConversationRecord.id == EvaluationResult.conversation_record_id,
            )
            .where(
                and_(
                    ConversationRecord.original_created_at >= start_date,
                    ConversationRecord.original_created_at <= end_date,
                    EvaluationResult.has_issue == True,
                )
            )
        )

        result = await self.db.execute(query)
        rows = result.scalars().all()

        # Count issue types
        issue_counts: Dict[str, int] = defaultdict(int)
        total_issues = 0

        for issue_types in rows:
            if issue_types:
                for issue_type in issue_types:
                    issue_counts[issue_type] += 1
                    total_issues += 1

        # Calculate percentages
        by_type = []
        for issue_type, count in sorted(
            issue_counts.items(), key=lambda x: x[1], reverse=True
        ):
            by_type.append(
                {
                    "type": issue_type,
                    "count": count,
                    "percentage": count / total_issues if total_issues > 0 else 0,
                }
            )

        return {
            "total_issues": len(rows),
            "by_type": by_type,
        }
