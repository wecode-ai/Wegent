# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Grading service for evaluation module.

Handles AI-powered grading tasks and Wegent Task integration.
"""

import logging
from datetime import datetime
from typing import Dict, List, Optional, Tuple

from sqlalchemy import func
from sqlalchemy.orm import Session

from wecode.models.evaluation import (
    EvalAnswer,
    EvalGradingTask,
    EvalQuestion,
    EvalQuestionVersion,
    EvalTopic,
    GradingTaskStatus,
)

logger = logging.getLogger(__name__)


# Grading prompt template
GRADING_PROMPT_TEMPLATE = """You are a professional grading assistant. Please evaluate the following submission:

## Question

{question_content}

{question_attachments}

## Grading Criteria

{criteria_content}

{criteria_attachments}

## Student Submission

{answer_content}

{answer_attachments}

## Output Requirements

Please generate a Markdown-formatted grading report including:

1. **Overall Score** - Total score and grade summary
2. **Detailed Analysis** - Evaluation based on each criterion
3. **Strengths** - What the student did well
4. **Areas for Improvement** - What needs work
5. **Suggestions** - Actionable recommendations for improvement

Use the following format for scoring:
- Clearly state points earned vs possible points
- Provide specific examples from the submission to support your evaluation
"""


class GradingService:
    """Service for managing grading tasks."""

    def create_task(
        self,
        db: Session,
        answer: EvalAnswer,
        grader_id: int = 0,
    ) -> EvalGradingTask:
        """
        Create a grading task for an answer.

        Args:
            db: Database session
            answer: Answer to grade
            grader_id: Grader user ID (0 for AI grading)

        Returns:
            Created grading task
        """
        task = EvalGradingTask(
            answer_id=answer.id,
            question_id=answer.question_id,
            question_version=answer.question_version,
            respondent_id=answer.respondent_id,
            grader_id=grader_id,
            status=GradingTaskStatus.PENDING,
            report_data={},
        )
        db.add(task)
        db.flush()

        logger.info(f"Created grading task {task.id} for answer {answer.id}")
        return task

    def get(self, db: Session, task_id: int) -> Optional[EvalGradingTask]:
        """
        Get a grading task by ID.

        Args:
            db: Database session
            task_id: Grading task ID

        Returns:
            Grading task if found
        """
        return db.query(EvalGradingTask).filter(EvalGradingTask.id == task_id).first()

    def get_by_answer(self, db: Session, answer_id: int) -> Optional[EvalGradingTask]:
        """
        Get the latest grading task for an answer.

        Args:
            db: Database session
            answer_id: Answer ID

        Returns:
            Latest grading task if exists
        """
        return (
            db.query(EvalGradingTask)
            .filter(EvalGradingTask.answer_id == answer_id)
            .order_by(EvalGradingTask.created_at.desc())
            .first()
        )

    def list_tasks(
        self,
        db: Session,
        topic_id: int,
        status: Optional[int] = None,
        respondent_id: Optional[int] = None,
        page: int = 1,
        limit: int = 50,
    ) -> Tuple[List[EvalGradingTask], int]:
        """
        List grading tasks for a topic.

        Args:
            db: Database session
            topic_id: Topic ID
            status: Filter by status
            respondent_id: Filter by respondent
            page: Page number (1-indexed)
            limit: Items per page

        Returns:
            Tuple of (tasks list, total count)
        """
        # Get question IDs for this topic
        question_ids = (
            db.query(EvalQuestion.id)
            .filter(
                EvalQuestion.topic_id == topic_id,
                EvalQuestion.is_active == True,
            )
            .subquery()
        )

        query = db.query(EvalGradingTask).filter(
            EvalGradingTask.question_id.in_(question_ids)
        )

        if status is not None:
            query = query.filter(EvalGradingTask.status == status)

        if respondent_id is not None:
            query = query.filter(EvalGradingTask.respondent_id == respondent_id)

        total = query.count()
        tasks = (
            query.order_by(EvalGradingTask.created_at.desc())
            .offset((page - 1) * limit)
            .limit(limit)
            .all()
        )

        return tasks, total

    def list_by_respondent(
        self,
        db: Session,
        respondent_id: int,
        topic_id: Optional[int] = None,
        status: Optional[int] = None,
        page: int = 1,
        limit: int = 50,
    ) -> Tuple[List[EvalGradingTask], int]:
        """
        List grading tasks for a respondent.

        Args:
            db: Database session
            respondent_id: Respondent user ID
            topic_id: Filter by topic (optional)
            status: Filter by status
            page: Page number (1-indexed)
            limit: Items per page

        Returns:
            Tuple of (tasks list, total count)
        """
        query = db.query(EvalGradingTask).filter(
            EvalGradingTask.respondent_id == respondent_id
        )

        if topic_id:
            question_ids = (
                db.query(EvalQuestion.id)
                .filter(
                    EvalQuestion.topic_id == topic_id,
                    EvalQuestion.is_active == True,
                )
                .subquery()
            )
            query = query.filter(EvalGradingTask.question_id.in_(question_ids))

        if status is not None:
            query = query.filter(EvalGradingTask.status == status)

        total = query.count()
        tasks = (
            query.order_by(EvalGradingTask.created_at.desc())
            .offset((page - 1) * limit)
            .limit(limit)
            .all()
        )

        return tasks, total

    def build_grading_prompt(
        self,
        db: Session,
        task: EvalGradingTask,
        storage_service: Optional["EvalStorageService"] = None,
    ) -> str:
        """
        Build the grading prompt for a task.

        Args:
            db: Database session
            task: Grading task
            storage_service: Storage service for presigned URLs

        Returns:
            Formatted prompt string
        """
        # Get question version
        question_version = (
            db.query(EvalQuestionVersion)
            .filter(
                EvalQuestionVersion.question_id == task.question_id,
                EvalQuestionVersion.version == task.question_version,
            )
            .first()
        )

        if not question_version:
            raise ValueError(f"Question version {task.question_version} not found")

        # Get answer
        answer = db.query(EvalAnswer).filter(EvalAnswer.id == task.answer_id).first()

        if not answer:
            raise ValueError(f"Answer {task.answer_id} not found")

        # Format question content
        question_content = question_version.content_data.get("text", "")
        question_attachments = self._format_attachments(
            question_version.content_data.get("attachments", []),
            storage_service,
        )

        # Format criteria content
        criteria_content = question_version.criteria_data.get("text", "")
        criteria_attachments = self._format_attachments(
            question_version.criteria_data.get("attachments", []),
            storage_service,
        )

        # Format answer content
        answer_content = answer.content_data.get("text", "")
        answer_attachments = self._format_attachments(
            answer.content_data.get("attachments", []),
            storage_service,
        )

        return GRADING_PROMPT_TEMPLATE.format(
            question_content=question_content,
            question_attachments=question_attachments,
            criteria_content=criteria_content,
            criteria_attachments=criteria_attachments,
            answer_content=answer_content,
            answer_attachments=answer_attachments,
        )

    def _format_attachments(
        self,
        attachments: List[Dict],
        storage_service: Optional["EvalStorageService"] = None,
    ) -> str:
        """
        Format attachments for prompt.

        Args:
            attachments: List of attachment dictionaries
            storage_service: Storage service for presigned URLs

        Returns:
            Formatted attachment string
        """
        if not attachments:
            return ""

        lines = ["**Attachments:**"]
        for att in attachments:
            filename = att.get("filename", "Unknown")
            if storage_service and att.get("key"):
                url = storage_service.get_presigned_url(att["key"])
                lines.append(f"- [{filename}]({url})")
            else:
                lines.append(f"- {filename}")

        return "\n".join(lines)

    def execute(
        self,
        db: Session,
        task: EvalGradingTask,
        team_id: int,
        user_id: int,
    ) -> EvalGradingTask:
        """
        Execute a grading task using Wegent Team.

        This creates a Wegent Task to run the AI grading.

        Args:
            db: Database session
            task: Grading task to execute
            team_id: Team ID for grading
            user_id: User ID initiating the grading

        Returns:
            Updated grading task
        """
        # Update task status
        task.status = GradingTaskStatus.RUNNING
        task.team_id = team_id
        task.grader_id = user_id
        task.started_at = datetime.now()
        db.flush()

        logger.info(f"Started grading task {task.id} with team {team_id}")

        # Note: Actual Wegent Task creation would be done here
        # For now, we just update the status. The integration with
        # Wegent's TaskService would be:
        #
        # from app.services.task_dispatcher import TaskDispatcher
        # prompt = self.build_grading_prompt(db, task, storage_service)
        # wegent_task = TaskDispatcher.create_task(
        #     team_id=team_id,
        #     user_id=user_id,
        #     prompt=prompt,
        #     callback_url=f"/api/v1/wecode/evaluation/grading-tasks/{task.id}/callback"
        # )
        # task.task_id = wegent_task.id

        return task

    def complete(
        self,
        db: Session,
        task: EvalGradingTask,
        report_content: str,
        report_s3_path: str = "",
    ) -> EvalGradingTask:
        """
        Complete a grading task with results.

        Args:
            db: Database session
            task: Grading task
            report_content: Markdown report content
            report_s3_path: S3 path for report file

        Returns:
            Updated grading task
        """
        task.status = GradingTaskStatus.COMPLETED
        task.report_data = {"content": report_content}
        task.report_s3_path = report_s3_path
        task.completed_at = datetime.now()
        db.flush()

        logger.info(f"Completed grading task {task.id}")
        return task

    def fail(
        self,
        db: Session,
        task: EvalGradingTask,
        error_message: str,
    ) -> EvalGradingTask:
        """
        Mark a grading task as failed.

        Args:
            db: Database session
            task: Grading task
            error_message: Error message

        Returns:
            Updated grading task
        """
        task.status = GradingTaskStatus.FAILED
        task.error_message = error_message[:2000]  # Truncate to field limit
        task.report_data = {"error": error_message}
        task.completed_at = datetime.now()
        task.attempt_count = task.attempt_count + 1
        db.flush()

        logger.info(f"Failed grading task {task.id}: {error_message}")
        return task

    def publish(
        self,
        db: Session,
        task: EvalGradingTask,
        report_content: Optional[str] = None,
    ) -> EvalGradingTask:
        """
        Publish a grading report to the respondent.

        Args:
            db: Database session
            task: Grading task
            report_content: Optional updated report content

        Returns:
            Updated grading task
        """
        if report_content:
            task.report_data = {"content": report_content}

        task.status = GradingTaskStatus.PUBLISHED
        task.published_at = datetime.now()
        db.flush()

        logger.info(f"Published grading task {task.id}")
        return task

    def update_report(
        self,
        db: Session,
        task: EvalGradingTask,
        report_content: str,
    ) -> EvalGradingTask:
        """
        Update the report content before publishing.

        Args:
            db: Database session
            task: Grading task
            report_content: New report content

        Returns:
            Updated grading task
        """
        task.report_data = {"content": report_content}
        db.flush()

        logger.info(f"Updated report for grading task {task.id}")
        return task

    def batch_execute(
        self,
        db: Session,
        task_ids: List[int],
        team_id: int,
        user_id: int,
    ) -> List[EvalGradingTask]:
        """
        Execute multiple grading tasks.

        Args:
            db: Database session
            task_ids: List of task IDs
            team_id: Team ID for grading
            user_id: User ID initiating

        Returns:
            List of updated tasks
        """
        tasks = []
        for task_id in task_ids:
            task = self.get(db, task_id)
            if task and task.status == GradingTaskStatus.PENDING:
                updated = self.execute(db, task, team_id, user_id)
                tasks.append(updated)

        return tasks

    def batch_publish(self, db: Session, task_ids: List[int]) -> List[EvalGradingTask]:
        """
        Publish multiple grading reports.

        Args:
            db: Database session
            task_ids: List of task IDs

        Returns:
            List of updated tasks
        """
        tasks = []
        for task_id in task_ids:
            task = self.get(db, task_id)
            if task and task.status == GradingTaskStatus.COMPLETED:
                updated = self.publish(db, task)
                tasks.append(updated)

        return tasks
