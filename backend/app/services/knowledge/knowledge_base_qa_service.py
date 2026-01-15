# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Service for querying knowledge base QA history.

Queries subtask_contexts with context_type='knowledge_base' to retrieve
QA history including user questions, assistant answers, and retrieval results.
"""

import logging
import math
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple

from shared.models.db.enums import SubtaskRole
from shared.models.db.subtask import Subtask
from shared.models.db.subtask_context import SubtaskContext
from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.schemas.knowledge_qa_history import (
    EmbeddingConfigInfo,
    HybridWeightsInfo,
    KnowledgeBaseConfigInfo,
    KnowledgeBaseResult,
    KnowledgeBaseTypeData,
    PaginationInfo,
    QAHistoryItem,
    QAHistoryResponse,
    RetrievalConfigInfo,
)

logger = logging.getLogger(__name__)

# Maximum query time range in days
MAX_QUERY_DAYS = 30


class KnowledgeBaseQAService:
    """Service for querying knowledge base QA history."""

    @staticmethod
    def validate_time_range(start_time: datetime, end_time: datetime) -> None:
        """
        Validate the time range for the query.

        Args:
            start_time: Query start time
            end_time: Query end time

        Raises:
            ValueError: If time range is invalid
        """
        if start_time >= end_time:
            raise ValueError("start_time must be earlier than end_time")

        time_diff = end_time - start_time
        if time_diff > timedelta(days=MAX_QUERY_DAYS):
            raise ValueError(
                f"Query time range cannot exceed {MAX_QUERY_DAYS} days. "
                f"Current range: {time_diff.days} days"
            )

    @staticmethod
    def get_qa_history(
        db: Session,
        start_time: datetime,
        end_time: datetime,
        user_id: Optional[int] = None,
        page: int = 1,
        page_size: int = 20,
    ) -> QAHistoryResponse:
        """
        Query knowledge base QA history based on time range.

        Args:
            db: Database session
            start_time: Query start time
            end_time: Query end time
            user_id: Optional user ID filter
            page: Page number (1-indexed)
            page_size: Number of items per page

        Returns:
            QAHistoryResponse with paginated QA history items

        Raises:
            ValueError: If parameters are invalid
        """
        # Validate time range
        KnowledgeBaseQAService.validate_time_range(start_time, end_time)

        # Validate pagination parameters
        if page < 1:
            page = 1
        if page_size < 1:
            page_size = 20
        if page_size > 100:
            page_size = 100

        # Build base query for subtask_contexts with context_type='knowledge_base'
        base_query = db.query(SubtaskContext).filter(
            SubtaskContext.context_type == "knowledge_base",
            SubtaskContext.created_at >= start_time,
            SubtaskContext.created_at <= end_time,
        )

        # Add user_id filter if provided
        if user_id is not None:
            base_query = base_query.filter(SubtaskContext.user_id == user_id)

        # Get total count for pagination
        total = base_query.count()

        # Calculate pagination
        total_pages = math.ceil(total / page_size) if total > 0 else 1
        offset = (page - 1) * page_size

        # Get paginated contexts ordered by created_at desc
        contexts = (
            base_query.order_by(SubtaskContext.created_at.desc())
            .offset(offset)
            .limit(page_size)
            .all()
        )

        # Build QA history items
        items = []
        for ctx in contexts:
            item = KnowledgeBaseQAService._build_qa_history_item(db, ctx)
            if item:
                items.append(item)

        return QAHistoryResponse(
            items=items,
            pagination=PaginationInfo(
                page=page,
                page_size=page_size,
                total=total,
                total_pages=total_pages,
            ),
        )

    @staticmethod
    def _build_qa_history_item(
        db: Session, context: SubtaskContext
    ) -> Optional[QAHistoryItem]:
        """
        Build a QAHistoryItem from a SubtaskContext.

        Args:
            db: Database session
            context: SubtaskContext record

        Returns:
            QAHistoryItem or None if data is incomplete
        """
        try:
            # Get the USER subtask that this context belongs to
            user_subtask = (
                db.query(Subtask)
                .filter(
                    Subtask.id == context.subtask_id,
                    Subtask.role == SubtaskRole.USER,
                )
                .first()
            )

            if not user_subtask:
                # Try to find the USER subtask by context's subtask_id
                # The context might be linked to an ASSISTANT subtask, so find the parent
                subtask = (
                    db.query(Subtask).filter(Subtask.id == context.subtask_id).first()
                )
                if subtask and subtask.role == SubtaskRole.ASSISTANT:
                    # Find the USER subtask by parent_id
                    user_subtask = (
                        db.query(Subtask)
                        .filter(
                            Subtask.task_id == subtask.task_id,
                            Subtask.message_id == subtask.parent_id,
                            Subtask.role == SubtaskRole.USER,
                        )
                        .first()
                    )
                if not user_subtask:
                    logger.warning(
                        f"Could not find USER subtask for context {context.id}"
                    )
                    return None

            # Get the ASSISTANT subtask response
            assistant_answer = KnowledgeBaseQAService._get_assistant_answer(
                db, user_subtask
            )

            # Parse knowledge base result from context
            kb_result = KnowledgeBaseQAService._parse_knowledge_base_result(context)

            # Get knowledge base config if knowledge_id is available
            kb_config = None
            type_data = context.type_data or {}
            knowledge_id = type_data.get("knowledge_id")
            if knowledge_id:
                kb_config = KnowledgeBaseQAService._get_knowledge_base_config(
                    db, knowledge_id
                )

            return QAHistoryItem(
                task_id=user_subtask.task_id,
                user_id=context.user_id,
                subtask_id=user_subtask.id,
                subtask_context_id=context.id,
                user_prompt=user_subtask.prompt,
                assistant_answer=assistant_answer,
                knowledge_base_result=kb_result,
                knowledge_base_config=kb_config,
                created_at=context.created_at,
            )

        except Exception as e:
            logger.error(
                f"Error building QA history item for context {context.id}: {e}"
            )
            return None

    @staticmethod
    def _get_assistant_answer(db: Session, user_subtask: Subtask) -> Optional[str]:
        """
        Get the assistant's answer for a user subtask.

        Args:
            db: Database session
            user_subtask: The USER subtask

        Returns:
            Assistant's answer text or None
        """
        try:
            # Find ASSISTANT subtask by task_id and parent_id matching USER's message_id
            assistant_subtask = (
                db.query(Subtask)
                .filter(
                    Subtask.task_id == user_subtask.task_id,
                    Subtask.parent_id == user_subtask.message_id,
                    Subtask.role == SubtaskRole.ASSISTANT,
                )
                .first()
            )

            if assistant_subtask and assistant_subtask.result:
                # Extract value from result JSON
                return assistant_subtask.result.get("value")

            return None

        except Exception as e:
            logger.error(
                f"Error getting assistant answer for subtask {user_subtask.id}: {e}"
            )
            return None

    @staticmethod
    def _parse_knowledge_base_result(
        context: SubtaskContext,
    ) -> Optional[KnowledgeBaseResult]:
        """
        Parse knowledge base result from SubtaskContext.

        Args:
            context: SubtaskContext record

        Returns:
            KnowledgeBaseResult or None
        """
        try:
            type_data = context.type_data or {}

            # Parse type_data into KnowledgeBaseTypeData
            kb_type_data = KnowledgeBaseTypeData(
                knowledge_id=type_data.get("knowledge_id"),
                document_count=type_data.get("document_count"),
                sources=type_data.get("sources"),
            )

            return KnowledgeBaseResult(
                extracted_text=context.extracted_text or None,
                type_data=kb_type_data,
            )

        except Exception as e:
            logger.error(
                f"Error parsing knowledge base result for context {context.id}: {e}"
            )
            return None

    @staticmethod
    def _get_knowledge_base_config(
        db: Session, knowledge_id: int
    ) -> Optional[KnowledgeBaseConfigInfo]:
        """
        Get knowledge base configuration from kinds table.

        Args:
            db: Database session
            knowledge_id: Knowledge base ID

        Returns:
            KnowledgeBaseConfigInfo or None
        """
        try:
            kb = (
                db.query(Kind)
                .filter(
                    Kind.id == knowledge_id,
                    Kind.kind == "KnowledgeBase",
                )
                .first()
            )

            if not kb:
                return None

            spec = kb.json.get("spec", {})
            kb_name = spec.get("name", "")

            # Parse retrieval config
            retrieval_config = None
            retrieval_config_data = spec.get("retrievalConfig")
            if retrieval_config_data:
                # Parse embedding config
                embedding_config = None
                embedding_data = retrieval_config_data.get("embedding_config")
                if embedding_data:
                    embedding_config = EmbeddingConfigInfo(
                        model_name=embedding_data.get("model_name"),
                        model_namespace=embedding_data.get(
                            "model_namespace", "default"
                        ),
                    )

                # Parse hybrid weights
                hybrid_weights = None
                hybrid_data = retrieval_config_data.get("hybrid_weights")
                if hybrid_data:
                    hybrid_weights = HybridWeightsInfo(
                        vector_weight=hybrid_data.get("vector_weight"),
                        keyword_weight=hybrid_data.get("keyword_weight"),
                    )

                retrieval_config = RetrievalConfigInfo(
                    retriever_name=retrieval_config_data.get("retriever_name"),
                    retriever_namespace=retrieval_config_data.get(
                        "retriever_namespace", "default"
                    ),
                    embedding_config=embedding_config,
                    retrieval_mode=retrieval_config_data.get("retrieval_mode"),
                    top_k=retrieval_config_data.get("top_k"),
                    score_threshold=retrieval_config_data.get("score_threshold"),
                    hybrid_weights=hybrid_weights,
                )

            return KnowledgeBaseConfigInfo(
                id=kb.id,
                name=kb_name,
                retrieval_config=retrieval_config,
            )

        except Exception as e:
            logger.error(
                f"Error getting knowledge base config for id {knowledge_id}: {e}"
            )
            return None


# Singleton instance for service
knowledge_base_qa_service = KnowledgeBaseQAService()
