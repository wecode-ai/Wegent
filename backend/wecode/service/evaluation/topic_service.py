# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Topic service for evaluation module.

Handles CRUD operations and version management for examination topics.
"""

import logging
from typing import Dict, List, Optional, Tuple

from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session

from wecode.models.evaluation import (
    EvalPermission,
    EvalQuestion,
    EvalTopic,
    EvalTopicVersion,
    QuestionStatus,
    TopicStatus,
    TopicVisibility,
)
from wecode.service.evaluation.utils import generate_version

logger = logging.getLogger(__name__)


class TopicService:
    """Service for managing evaluation topics."""

    def create(
        self,
        db: Session,
        user_id: int,
        name: str,
        description: Optional[str] = None,
        visibility: str = TopicVisibility.PRIVATE,
        grading_team_id: Optional[int] = None,
    ) -> EvalTopic:
        """
        Create a new topic.

        Args:
            db: Database session
            user_id: Creator user ID
            name: Topic name
            description: Topic description
            visibility: 'public' or 'private'
            grading_team_id: Optional team ID for AI grading

        Returns:
            Created topic
        """
        extra_data = {}
        if description:
            extra_data["description"] = description

        grading_config = {}
        if grading_team_id:
            grading_config["team_id"] = grading_team_id

        topic = EvalTopic(
            name=name,
            creator_id=user_id,
            visibility=visibility,
            status=TopicStatus.DRAFT,
            extra_data=extra_data,
            grading_team_config=grading_config,
        )
        db.add(topic)
        db.flush()

        logger.info(f"[Evaluation] Created topic {topic.id}: {name}")
        return topic

    def get(self, db: Session, topic_id: int) -> Optional[EvalTopic]:
        """
        Get a topic by ID.

        Args:
            db: Database session
            topic_id: Topic ID

        Returns:
            Topic if found and active, None otherwise
        """
        return (
            db.query(EvalTopic)
            .filter(
                EvalTopic.id == topic_id,
                EvalTopic.is_active,
            )
            .first()
        )

    def list_topics(
        self,
        db: Session,
        user_id: int,
        page: int = 1,
        limit: int = 20,
        visibility: Optional[str] = None,
        status: Optional[int] = None,
        search: Optional[str] = None,
        my_only: bool = False,
    ) -> Tuple[List[EvalTopic], int]:
        """
        List topics accessible to a user.

        Access rules:
        - Creator: Can see all their own topics (including drafts)
        - Others: Can only see published topics that are either:
          - Public and published
          - Topics where user has explicit permission

        Args:
            db: Database session
            user_id: Current user ID
            page: Page number (1-indexed)
            limit: Items per page
            visibility: Filter by visibility
            status: Filter by status
            search: Search by name
            my_only: Only show user's own topics

        Returns:
            Tuple of (topics list, total count)
        """
        query = db.query(EvalTopic).filter(EvalTopic.is_active)

        if my_only:
            # Only user's own topics (can see all including drafts)
            query = query.filter(EvalTopic.creator_id == user_id)
        else:
            # Topics user can access:
            # 1. User's own topics (all statuses)
            # 2. Public AND published topics
            # 3. Topics where user has explicit permission (all statuses)
            permitted_topic_ids = (
                db.query(EvalPermission.topic_id)
                .filter(EvalPermission.user_id == user_id)
                .subquery()
            )

            query = query.filter(
                or_(
                    # User's own topics - can see all
                    EvalTopic.creator_id == user_id,
                    # Public topics - only if published
                    and_(
                        EvalTopic.visibility == TopicVisibility.PUBLIC,
                        EvalTopic.status == TopicStatus.PUBLISHED,
                    ),
                    # Topics with explicit permission - can see all
                    EvalTopic.id.in_(permitted_topic_ids),
                )
            )

        if visibility:
            query = query.filter(EvalTopic.visibility == visibility)

        if status is not None:
            query = query.filter(EvalTopic.status == status)

        if search:
            query = query.filter(EvalTopic.name.ilike(f"%{search}%"))

        total = query.count()
        topics = (
            query.order_by(EvalTopic.updated_at.desc())
            .offset((page - 1) * limit)
            .limit(limit)
            .all()
        )

        return topics, total

    def update(
        self,
        db: Session,
        topic: EvalTopic,
        name: Optional[str] = None,
        description: Optional[str] = None,
        visibility: Optional[str] = None,
        grading_team_id: Optional[int] = None,
    ) -> EvalTopic:
        """
        Update a topic.

        Args:
            db: Database session
            topic: Topic to update
            name: New name (optional)
            description: New description (optional)
            visibility: New visibility (optional)
            grading_team_id: New grading team ID (optional)

        Returns:
            Updated topic
        """
        if name:
            topic.name = name

        if description is not None:
            if not topic.extra_data:
                topic.extra_data = {}
            topic.extra_data["description"] = description

        if visibility:
            topic.visibility = visibility

        if grading_team_id is not None:
            if not topic.grading_team_config:
                topic.grading_team_config = {}
            topic.grading_team_config["team_id"] = grading_team_id

        db.flush()
        logger.info(f"[Evaluation] Updated topic {topic.id}")
        return topic

    def delete(self, db: Session, topic: EvalTopic) -> bool:
        """
        Soft delete a topic.

        Args:
            db: Database session
            topic: Topic to delete

        Returns:
            True if deleted
        """
        topic.is_active = False
        db.flush()
        logger.info(f"[Evaluation] Deleted topic {topic.id}")
        return True

    def publish(self, db: Session, topic: EvalTopic, user_id: int) -> EvalTopicVersion:
        """
        Publish a topic and create a new version.

        Creates a snapshot of all published questions at this point in time.

        Args:
            db: Database session
            topic: Topic to publish
            user_id: Publishing user ID

        Returns:
            Created topic version
        """
        # Get all published questions for this topic
        questions = (
            db.query(EvalQuestion)
            .filter(
                EvalQuestion.topic_id == topic.id,
                EvalQuestion.is_active,
                EvalQuestion.status == QuestionStatus.PUBLISHED,
            )
            .order_by(EvalQuestion.order_index)
            .all()
        )

        # Create snapshot of question versions
        question_snapshots = []
        for q in questions:
            question_snapshots.append(
                {
                    "question_id": q.id,
                    "version": q.current_version,
                    "title": q.title,
                    "order_index": q.order_index,
                }
            )

        # Generate new version
        version = generate_version()

        # Create topic version record
        topic_version = EvalTopicVersion(
            topic_id=topic.id,
            version=version,
            question_snapshots=question_snapshots,
            published_by=user_id,
        )
        db.add(topic_version)

        # Update topic status and version
        topic.status = TopicStatus.PUBLISHED
        topic.current_version = version
        db.flush()

        logger.info(
            f"[Evaluation] Published topic {topic.id} version {version} with {len(questions)} questions"
        )
        return topic_version

    def get_version(
        self, db: Session, topic_id: int, version: str
    ) -> Optional[EvalTopicVersion]:
        """
        Get a specific topic version.

        Args:
            db: Database session
            topic_id: Topic ID
            version: Version string

        Returns:
            Topic version if found
        """
        return (
            db.query(EvalTopicVersion)
            .filter(
                EvalTopicVersion.topic_id == topic_id,
                EvalTopicVersion.version == version,
            )
            .first()
        )

    def list_versions(
        self,
        db: Session,
        topic_id: int,
        page: int = 1,
        limit: int = 20,
    ) -> Tuple[List[EvalTopicVersion], int]:
        """
        List all versions of a topic with pagination.

        Args:
            db: Database session
            topic_id: Topic ID
            page: Page number (1-indexed)
            limit: Items per page

        Returns:
            Tuple of (versions list, total count)
        """
        query = db.query(EvalTopicVersion).filter(EvalTopicVersion.topic_id == topic_id)
        total = query.count()
        versions = (
            query.order_by(EvalTopicVersion.published_at.desc())
            .offset((page - 1) * limit)
            .limit(limit)
            .all()
        )
        return versions, total

    def get_statistics(self, db: Session, topic_id: int) -> Dict:
        """
        Get statistics for a topic.

        Args:
            db: Database session
            topic_id: Topic ID

        Returns:
            Dictionary with statistics
        """
        from wecode.models.evaluation import (
            EvalAnswer,
            EvalGradingTask,
            GradingTaskStatus,
        )

        # Question counts
        total_questions = (
            db.query(func.count(EvalQuestion.id))
            .filter(
                EvalQuestion.topic_id == topic_id,
                EvalQuestion.is_active,
            )
            .scalar()
        )

        published_questions = (
            db.query(func.count(EvalQuestion.id))
            .filter(
                EvalQuestion.topic_id == topic_id,
                EvalQuestion.is_active,
                EvalQuestion.status == QuestionStatus.PUBLISHED,
            )
            .scalar()
        )

        # Get question IDs for this topic
        question_ids = (
            db.query(EvalQuestion.id)
            .filter(
                EvalQuestion.topic_id == topic_id,
                EvalQuestion.is_active,
            )
            .subquery()
        )

        # Answer counts
        total_answers = (
            db.query(func.count(EvalAnswer.id))
            .filter(EvalAnswer.question_id.in_(question_ids))
            .scalar()
        )

        total_respondents = (
            db.query(func.count(func.distinct(EvalAnswer.respondent_id)))
            .filter(EvalAnswer.question_id.in_(question_ids))
            .scalar()
        )

        # Grading counts
        grading_pending = (
            db.query(func.count(EvalGradingTask.id))
            .filter(
                EvalGradingTask.question_id.in_(question_ids),
                EvalGradingTask.status == GradingTaskStatus.PENDING,
            )
            .scalar()
        )

        grading_completed = (
            db.query(func.count(EvalGradingTask.id))
            .filter(
                EvalGradingTask.question_id.in_(question_ids),
                EvalGradingTask.status == GradingTaskStatus.COMPLETED,
            )
            .scalar()
        )

        grading_published = (
            db.query(func.count(EvalGradingTask.id))
            .filter(
                EvalGradingTask.question_id.in_(question_ids),
                EvalGradingTask.status == GradingTaskStatus.PUBLISHED,
            )
            .scalar()
        )

        return {
            "total_questions": total_questions,
            "published_questions": published_questions,
            "total_answers": total_answers,
            "total_respondents": total_respondents,
            "grading_pending": grading_pending,
            "grading_completed": grading_completed,
            "grading_published": grading_published,
        }
