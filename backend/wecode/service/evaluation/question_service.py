# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Question service for evaluation module.

Handles CRUD operations and version management for examination questions.
"""

import logging
from typing import Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

from wecode.models.evaluation import (
    EvalQuestion,
    EvalQuestionVersion,
    QuestionStatus,
)
from wecode.service.evaluation.utils import generate_version

logger = logging.getLogger(__name__)


class QuestionService:
    """Service for managing evaluation questions."""

    def create(
        self,
        db: Session,
        topic_id: int,
        user_id: int,
        title: str,
        content_type: str = "text",
        content_data: Optional[Dict] = None,
        criteria_type: Optional[str] = None,
        criteria_data: Optional[Dict] = None,
        order_index: int = 0,
    ) -> EvalQuestion:
        """
        Create a new question.

        Args:
            db: Database session
            topic_id: Parent topic ID
            user_id: Creator user ID
            title: Question title
            content_type: Content type (text/url/attachment/mixed)
            content_data: Question content
            criteria_type: Criteria type (text/url/attachment/mixed), independent from content_type
            criteria_data: Grading criteria (stored in draft)
            order_index: Sort order

        Returns:
            Created question
        """
        if content_data is None:
            content_data = {}

        # Store criteria in content_data under "_criteria" key for draft
        # Include both criteria_type and criteria_data
        if criteria_data or criteria_type:
            content_data["_criteria"] = {
                "type": criteria_type or "text",
                "data": criteria_data or {},
            }

        question = EvalQuestion(
            topic_id=topic_id,
            title=title,
            content_type=content_type,
            content_data=content_data,
            creator_id=user_id,
            order_index=order_index,
            status=QuestionStatus.DRAFT,
        )
        db.add(question)
        db.flush()

        logger.info(f"Created question {question.id} for topic {topic_id}")
        return question

    def get(self, db: Session, question_id: int) -> Optional[EvalQuestion]:
        """
        Get a question by ID.

        Args:
            db: Database session
            question_id: Question ID

        Returns:
            Question if found and active
        """
        return (
            db.query(EvalQuestion)
            .filter(
                EvalQuestion.id == question_id,
                EvalQuestion.is_active,
            )
            .first()
        )

    def list_questions(
        self,
        db: Session,
        topic_id: int,
        page: int = 1,
        limit: int = 50,
        status: Optional[int] = None,
        include_criteria: bool = False,
    ) -> Tuple[List[EvalQuestion], int]:
        """
        List questions for a topic.

        Args:
            db: Database session
            topic_id: Topic ID
            page: Page number (1-indexed)
            limit: Items per page
            status: Filter by status
            include_criteria: Whether to include criteria data

        Returns:
            Tuple of (questions list, total count)
        """
        query = db.query(EvalQuestion).filter(
            EvalQuestion.topic_id == topic_id,
            EvalQuestion.is_active,
        )

        if status is not None:
            query = query.filter(EvalQuestion.status == status)

        total = query.count()
        questions = (
            query.order_by(EvalQuestion.order_index, EvalQuestion.id)
            .offset((page - 1) * limit)
            .limit(limit)
            .all()
        )

        return questions, total

    def update(
        self,
        db: Session,
        question: EvalQuestion,
        title: Optional[str] = None,
        content_type: Optional[str] = None,
        content_data: Optional[Dict] = None,
        criteria_type: Optional[str] = None,
        criteria_data: Optional[Dict] = None,
        order_index: Optional[int] = None,
    ) -> EvalQuestion:
        """
        Update a question.

        Note: Modifying a published question puts it in "modified" state
        until republished.

        Args:
            db: Database session
            question: Question to update
            title: New title
            content_type: New content type
            content_data: New content data
            criteria_type: New criteria type (text/url/attachment/mixed)
            criteria_data: New criteria data
            order_index: New order index

        Returns:
            Updated question
        """
        if title:
            question.title = title

        if content_type:
            question.content_type = content_type

        if content_data is not None:
            # Preserve criteria if not being updated
            existing_criteria = question.content_data.get("_criteria", {})
            question.content_data = content_data
            if "_criteria" not in question.content_data and existing_criteria:
                question.content_data["_criteria"] = existing_criteria

        # Update criteria (both type and data)
        if criteria_data is not None or criteria_type is not None:
            if not question.content_data:
                question.content_data = {}

            existing_criteria = question.content_data.get("_criteria", {})
            new_criteria = {
                "type": (
                    criteria_type
                    if criteria_type is not None
                    else existing_criteria.get("type", "text")
                ),
                "data": (
                    criteria_data
                    if criteria_data is not None
                    else existing_criteria.get("data", {})
                ),
            }
            question.content_data["_criteria"] = new_criteria

        if order_index is not None:
            question.order_index = order_index

        db.flush()
        logger.info(f"Updated question {question.id}")
        return question

    def delete(self, db: Session, question: EvalQuestion) -> bool:
        """
        Soft delete a question.

        Args:
            db: Database session
            question: Question to delete

        Returns:
            True if deleted
        """
        question.is_active = False
        db.flush()
        logger.info(f"Deleted question {question.id}")
        return True

    def publish(
        self, db: Session, question: EvalQuestion, user_id: int
    ) -> EvalQuestionVersion:
        """
        Publish a question and create a new version.

        Args:
            db: Database session
            question: Question to publish
            user_id: Publishing user ID

        Returns:
            Created question version
        """
        # Extract criteria from content_data
        content_data = dict(question.content_data)
        criteria_data = content_data.pop("_criteria", {"type": "text", "data": {}})

        # Generate new version
        version = generate_version()

        # Create question version record
        question_version = EvalQuestionVersion(
            question_id=question.id,
            version=version,
            content_data=content_data,
            criteria_data=criteria_data,
            published_by=user_id,
        )
        db.add(question_version)

        # Update question status and version
        question.status = QuestionStatus.PUBLISHED
        question.current_version = version
        db.flush()

        logger.info(f"Published question {question.id} version {version}")
        return question_version

    def get_version(
        self, db: Session, question_id: int, version: str
    ) -> Optional[EvalQuestionVersion]:
        """
        Get a specific question version.

        Args:
            db: Database session
            question_id: Question ID
            version: Version string

        Returns:
            Question version if found
        """
        return (
            db.query(EvalQuestionVersion)
            .filter(
                EvalQuestionVersion.question_id == question_id,
                EvalQuestionVersion.version == version,
            )
            .first()
        )

    def get_latest_version(
        self, db: Session, question_id: int
    ) -> Optional[EvalQuestionVersion]:
        """
        Get the latest published version of a question.

        Args:
            db: Database session
            question_id: Question ID

        Returns:
            Latest question version if any
        """
        return (
            db.query(EvalQuestionVersion)
            .filter(EvalQuestionVersion.question_id == question_id)
            .order_by(EvalQuestionVersion.published_at.desc())
            .first()
        )

    def list_versions(self, db: Session, question_id: int) -> List[EvalQuestionVersion]:
        """
        List all versions of a question.

        Args:
            db: Database session
            question_id: Question ID

        Returns:
            List of question versions (newest first)
        """
        return (
            db.query(EvalQuestionVersion)
            .filter(EvalQuestionVersion.question_id == question_id)
            .order_by(EvalQuestionVersion.published_at.desc())
            .all()
        )

    def reorder_questions(
        self, db: Session, topic_id: int, question_ids: List[int]
    ) -> bool:
        """
        Reorder questions in a topic.

        Args:
            db: Database session
            topic_id: Topic ID
            question_ids: Ordered list of question IDs

        Returns:
            True if successful
        """
        for index, question_id in enumerate(question_ids):
            db.query(EvalQuestion).filter(
                EvalQuestion.id == question_id,
                EvalQuestion.topic_id == topic_id,
            ).update({"order_index": index})

        db.flush()
        logger.info(f"Reordered {len(question_ids)} questions in topic {topic_id}")
        return True

    def get_criteria_data(self, db: Session, question: EvalQuestion) -> Dict:
        """
        Get grading criteria for a question.

        Returns criteria from the current version if published,
        otherwise from draft content_data.

        Args:
            db: Database session
            question: Question

        Returns:
            Criteria data dictionary
        """
        if question.current_version:
            version = self.get_version(db, question.id, question.current_version)
            if version:
                return version.criteria_data

        # Fall back to draft criteria
        return question.content_data.get("_criteria", {})

    def get_content_data(
        self, db: Session, question: EvalQuestion, version: Optional[str] = None
    ) -> Dict:
        """
        Get content data for a question.

        Args:
            db: Database session
            question: Question
            version: Specific version (uses current if not specified)

        Returns:
            Content data dictionary (without _criteria)
        """
        target_version = version or question.current_version

        if target_version:
            qv = self.get_version(db, question.id, target_version)
            if qv:
                return qv.content_data

        # Fall back to draft content (excluding criteria)
        content = dict(question.content_data)
        content.pop("_criteria", None)
        return content
