# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Answer service for evaluation module.

Handles answer submission and history management.
"""

import logging
from typing import Dict, List, Optional, Tuple

from sqlalchemy import func
from sqlalchemy.orm import Session

from wecode.models.evaluation import (
    EvalAnswer,
    EvalGradingTask,
    EvalQuestion,
    EvalTopic,
    GradingTaskStatus,
)
from wecode.service.evaluation.grading_service import (
    GradingService,
    build_multi_model_config,
    get_grading_team_id,
)

logger = logging.getLogger(__name__)


class AnswerService:
    """Service for managing evaluation answers."""

    def submit(
        self,
        db: Session,
        question_id: int,
        user_id: int,
        content_type: str = "text",
        content_data: Optional[Dict] = None,
        auto_create_grading: bool = True,
    ) -> EvalAnswer:
        """
        Submit an answer to a question.

        Marks any previous answers as not latest.
        If the topic has auto_trigger grading configured, will automatically
        trigger the grading task execution.

        Args:
            db: Database session
            question_id: Question ID
            user_id: Respondent user ID
            content_type: Content type
            content_data: Answer content
            auto_create_grading: Whether to create a grading task

        Returns:
            Created answer
        """
        if content_data is None:
            content_data = {}

        # Get question to determine version
        question = db.query(EvalQuestion).filter(EvalQuestion.id == question_id).first()

        if not question:
            raise ValueError(f"Question {question_id} not found")

        if not question.current_version:
            raise ValueError(f"Question {question_id} has not been published")

        # Get topic to check grading config
        topic = db.query(EvalTopic).filter(EvalTopic.id == question.topic_id).first()

        # Mark previous answers as not latest
        db.query(EvalAnswer).filter(
            EvalAnswer.question_id == question_id,
            EvalAnswer.respondent_id == user_id,
            EvalAnswer.is_latest,
        ).update({"is_latest": False})

        # Create new answer
        answer = EvalAnswer(
            question_id=question_id,
            question_version=question.current_version,
            respondent_id=user_id,
            content_type=content_type,
            content_data=content_data,
            is_latest=True,
        )
        db.add(answer)
        db.flush()

        logger.info(
            f"[Evaluation] Submitted answer {answer.id} for question {question_id} by user {user_id}"
        )

        # Create grading task if requested
        grading_task = None
        if auto_create_grading:
            # Get grading_mode from topic config
            grading_mode = None
            if topic and topic.grading_team_config:
                grading_mode = topic.grading_team_config.get("grading_mode")
                # Backward compatibility: if no grading_mode but has team_id, it's single mode
                if not grading_mode and topic.grading_team_config.get("team_id"):
                    grading_mode = "single"

            report_data = {"grading_mode": grading_mode} if grading_mode else {}
            grading_task = EvalGradingTask(
                answer_id=answer.id,
                question_id=question_id,
                question_version=question.current_version,
                respondent_id=user_id,
                status=GradingTaskStatus.PENDING,
                report_data=report_data,
            )
            db.add(grading_task)
            db.flush()

            logger.info(
                f"[Evaluation] Created grading task {grading_task.id} for answer {answer.id}"
            )

            # Check if auto_trigger is enabled for this topic
            if topic and topic.grading_team_config:
                grading_config = topic.grading_team_config
                auto_trigger = grading_config.get("auto_trigger", False)
                trigger_condition = grading_config.get("trigger_condition", "manual")

                # Get team_id and multi-model config using helper functions
                team_id = get_grading_team_id(grading_config)
                grading_mode = grading_config.get("grading_mode", "single")

                logger.info(
                    f"[Evaluation] Topic {topic.id} grading config: "
                    f"auto_trigger={auto_trigger}, trigger_condition={trigger_condition}, "
                    f"grading_mode={grading_mode}, team_id={team_id}"
                )

                # Auto-trigger grading if configured
                if auto_trigger and trigger_condition == "on_submit" and team_id:
                    logger.info(
                        f"[Evaluation] Auto-triggering grading task {grading_task.id} "
                        f"with team {team_id} for answer {answer.id}"
                    )
                    try:
                        grading_service = GradingService()
                        # Extract model override config from topic grading config
                        # When model_id is specified, default force_override to True
                        # for consistency with multi-model mode behavior
                        model_id = grading_config.get("model_id")
                        force_override = grading_config.get(
                            "force_override_bot_model", True if model_id else False
                        )

                        # Build multi-model config if in multi mode
                        multi_model_config = build_multi_model_config(grading_config)
                        if multi_model_config:
                            logger.info(
                                f"[Evaluation] Using multi-model grading for task "
                                f"{grading_task.id} with {len(multi_model_config.scorer_models)} scorers"
                            )

                        # For auto-triggered tasks, the task belongs to the topic creator
                        # So the grading task appears in the creator's chat task list
                        grading_service.execute(
                            db=db,
                            task=grading_task,
                            team_id=team_id,
                            user_id=topic.creator_id,  # Use topic creator, not respondent
                            model_id=model_id,
                            force_override_bot_model=force_override,
                            multi_model_config=multi_model_config,
                        )
                        logger.info(
                            f"[Evaluation] Successfully triggered grading task {grading_task.id}"
                        )
                    except Exception as e:
                        logger.error(
                            f"[Evaluation] Failed to auto-trigger grading task {grading_task.id}: {e}"
                        )
                        # Don't fail the answer submission if auto-grading fails
                        # The task remains in PENDING status and can be manually triggered
                else:
                    logger.info(
                        f"[Evaluation] Auto-trigger not enabled or conditions not met for task {grading_task.id}"
                    )
            else:
                logger.info(
                    f"[Evaluation] No grading config found for topic {topic.id if topic else 'N/A'}"
                )

        return answer

    def get(self, db: Session, answer_id: int) -> Optional[EvalAnswer]:
        """
        Get an answer by ID.

        Args:
            db: Database session
            answer_id: Answer ID

        Returns:
            Answer if found
        """
        return db.query(EvalAnswer).filter(EvalAnswer.id == answer_id).first()

    def list_answers(
        self,
        db: Session,
        question_id: int,
        respondent_id: Optional[int] = None,
        latest_only: bool = False,
        page: int = 1,
        limit: int = 50,
    ) -> Tuple[List[EvalAnswer], int]:
        """
        List answers for a question.

        Args:
            db: Database session
            question_id: Question ID
            respondent_id: Filter by respondent (optional)
            latest_only: Only include latest answers
            page: Page number (1-indexed)
            limit: Items per page

        Returns:
            Tuple of (answers list, total count)
        """
        query = db.query(EvalAnswer).filter(EvalAnswer.question_id == question_id)

        if respondent_id is not None:
            query = query.filter(EvalAnswer.respondent_id == respondent_id)

        if latest_only:
            query = query.filter(EvalAnswer.is_latest)

        total = query.count()
        answers = (
            query.order_by(EvalAnswer.submitted_at.desc())
            .offset((page - 1) * limit)
            .limit(limit)
            .all()
        )

        return answers, total

    def list_by_topic(
        self,
        db: Session,
        topic_id: int,
        respondent_id: Optional[int] = None,
        latest_only: bool = True,
        page: int = 1,
        limit: int = 50,
    ) -> Tuple[List[EvalAnswer], int]:
        """
        List answers for all questions in a topic.

        Args:
            db: Database session
            topic_id: Topic ID
            respondent_id: Filter by respondent (optional)
            latest_only: Only include latest answers
            page: Page number (1-indexed)
            limit: Items per page

        Returns:
            Tuple of (answers list, total count)
        """
        # Get question IDs for this topic - use scalar_subquery for IN clause
        question_ids = (
            db.query(EvalQuestion.id)
            .filter(
                EvalQuestion.topic_id == topic_id,
                EvalQuestion.is_active,
            )
            .scalar_subquery()
        )

        query = db.query(EvalAnswer).filter(EvalAnswer.question_id.in_(question_ids))

        if respondent_id is not None:
            query = query.filter(EvalAnswer.respondent_id == respondent_id)

        if latest_only:
            query = query.filter(EvalAnswer.is_latest)

        total = query.count()
        answers = (
            query.order_by(EvalAnswer.submitted_at.desc())
            .offset((page - 1) * limit)
            .limit(limit)
            .all()
        )

        return answers, total

    def get_latest_answer(
        self, db: Session, question_id: int, respondent_id: int
    ) -> Optional[EvalAnswer]:
        """
        Get the latest answer for a question by a respondent.

        Args:
            db: Database session
            question_id: Question ID
            respondent_id: Respondent user ID

        Returns:
            Latest answer if exists
        """
        return (
            db.query(EvalAnswer)
            .filter(
                EvalAnswer.question_id == question_id,
                EvalAnswer.respondent_id == respondent_id,
                EvalAnswer.is_latest,
            )
            .first()
        )

    def get_answer_history(
        self, db: Session, question_id: int, respondent_id: int
    ) -> List[EvalAnswer]:
        """
        Get all answers for a question by a respondent.

        Args:
            db: Database session
            question_id: Question ID
            respondent_id: Respondent user ID

        Returns:
            List of answers (newest first)
        """
        return (
            db.query(EvalAnswer)
            .filter(
                EvalAnswer.question_id == question_id,
                EvalAnswer.respondent_id == respondent_id,
            )
            .order_by(EvalAnswer.submitted_at.desc())
            .all()
        )

    def check_version_update(
        self, db: Session, question_id: int, respondent_id: int
    ) -> Optional[str]:
        """
        Check if there's a newer question version since last answer.

        Args:
            db: Database session
            question_id: Question ID
            respondent_id: Respondent user ID

        Returns:
            New version string if available, None otherwise
        """
        # Get latest answer
        answer = self.get_latest_answer(db, question_id, respondent_id)
        if not answer:
            return None

        # Get current question version
        question = db.query(EvalQuestion).filter(EvalQuestion.id == question_id).first()

        if not question or not question.current_version:
            return None

        # Check if version differs
        if answer.question_version != question.current_version:
            return question.current_version

        return None

    def get_respondent_progress(
        self, db: Session, topic_id: int, respondent_id: int
    ) -> Dict:
        """
        Get respondent's progress on a topic.

        Args:
            db: Database session
            topic_id: Topic ID
            respondent_id: Respondent user ID

        Returns:
            Dictionary with progress info
        """
        # Get total published questions
        total_questions = (
            db.query(func.count(EvalQuestion.id))
            .filter(
                EvalQuestion.topic_id == topic_id,
                EvalQuestion.is_active,
                EvalQuestion.status == 1,  # Published
            )
            .scalar()
        )

        # Get question IDs for this topic - use scalar_subquery for IN clause
        question_ids = (
            db.query(EvalQuestion.id)
            .filter(
                EvalQuestion.topic_id == topic_id,
                EvalQuestion.is_active,
            )
            .scalar_subquery()
        )

        # Get answered questions count
        answered_questions = (
            db.query(func.count(func.distinct(EvalAnswer.question_id)))
            .filter(
                EvalAnswer.question_id.in_(question_ids),
                EvalAnswer.respondent_id == respondent_id,
            )
            .scalar()
        )

        # Get published reports count
        published_reports = (
            db.query(func.count(EvalGradingTask.id))
            .filter(
                EvalGradingTask.question_id.in_(question_ids),
                EvalGradingTask.respondent_id == respondent_id,
                EvalGradingTask.status == GradingTaskStatus.PUBLISHED,
            )
            .scalar()
        )

        return {
            "total_questions": total_questions,
            "answered_questions": answered_questions,
            "published_reports": published_reports,
            "completion_rate": (
                answered_questions / total_questions * 100 if total_questions > 0 else 0
            ),
        }

    @staticmethod
    def merge_content_data(existing_content: Dict, new_content: Dict) -> Dict:
        """Merge new content data into existing content data.

        Handles deep merging of:
        - answers (new dynamic slot structure)
        - attachments (legacy structure)
        - inputs (text fields)

        Args:
            existing_content: Existing content data from database
            new_content: New content data from request

        Returns:
            Merged content data
        """
        # Start with existing content as base
        merged = {**existing_content}

        # Deep merge answers (new dynamic slot structure)
        if "answers" in new_content:
            existing_answers = existing_content.get("answers", {})
            new_answers = new_content["answers"]

            # Deep merge each answer slot
            merged_answers = {}
            for key in set(existing_answers.keys()) | set(new_answers.keys()):
                if key in new_answers:
                    # Use new value for completely replaced slots
                    merged_answers[key] = new_answers[key]
                else:
                    # Keep existing value
                    merged_answers[key] = existing_answers[key]

            merged["answers"] = merged_answers

        # Deep merge attachments (legacy structure) if new content has attachments
        if "attachments" in new_content:
            # Start with existing attachments or empty dict
            existing_attachments = existing_content.get("attachments", {})
            new_attachments = new_content["attachments"]

            # Deep merge each attachment slot
            merged_attachments = {}
            for key in set(existing_attachments.keys()) | set(new_attachments.keys()):
                if key in new_attachments:
                    # Use new value for completely replaced arrays
                    merged_attachments[key] = new_attachments[key]
                else:
                    # Keep existing value
                    merged_attachments[key] = existing_attachments[key]

            merged["attachments"] = merged_attachments

        # Deep merge answers (for dynamic slot-based answers)
        if "answers" in new_content:
            merged["answers"] = {
                **existing_content.get("answers", {}),
                **new_content["answers"],
            }

        # Merge other simple fields
        for key in ["participantName", "selectedTopicId"]:
            if key in new_content:
                merged[key] = new_content[key]

        return merged
