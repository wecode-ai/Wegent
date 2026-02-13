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
GRADING_PROMPT_TEMPLATE = """You are a professional grading assistant. Please evaluate the following submission.

## Important Instructions

1. **For URL content**: Please visit the URLs provided and read the content before grading.
2. **For attachments**: Click the provided download links to download and review any attached files.
3. **Be thorough**: Read all provided materials carefully before making your evaluation.
4. **Be fair**: Evaluate based solely on the grading criteria provided.

---

## Question

{question_content}

{question_url}

{question_attachments}

---

## Grading Criteria

{criteria_content}

{criteria_url}

{criteria_attachments}

---

## Student Submission

{answer_content}

{answer_url}

{answer_attachments}

---

## Output Requirements

Please generate a comprehensive Markdown-formatted grading report including:

1. **Overall Score** - Total score and grade summary (e.g., 85/100 - B+)
2. **Detailed Analysis** - Evaluation based on each criterion from the grading criteria
3. **Strengths** - What the student did well (with specific examples)
4. **Areas for Improvement** - What needs work (with specific examples)
5. **Suggestions** - Actionable recommendations for improvement

**Formatting Guidelines:**
- Clearly state points earned vs possible points
- Provide specific examples from the submission to support your evaluation
- Use bullet points for clarity
- Be constructive in your feedback
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
        question_content = question_version.content_data.get("text", "") or ""
        question_url = self._format_url(question_version.content_data.get("url"))
        question_attachments = self._format_attachments(
            question_version.content_data.get("attachments", []),
            storage_service,
        )

        # Format criteria content
        criteria_content = question_version.criteria_data.get("text", "") or ""
        criteria_url = self._format_url(question_version.criteria_data.get("url"))
        criteria_attachments = self._format_attachments(
            question_version.criteria_data.get("attachments", []),
            storage_service,
        )

        # Format answer content
        answer_content = answer.content_data.get("text", "") or ""
        answer_url = self._format_url(answer.content_data.get("url"))
        answer_attachments = self._format_attachments(
            answer.content_data.get("attachments", []),
            storage_service,
        )

        return GRADING_PROMPT_TEMPLATE.format(
            question_content=question_content,
            question_url=question_url,
            question_attachments=question_attachments,
            criteria_content=criteria_content,
            criteria_url=criteria_url,
            criteria_attachments=criteria_attachments,
            answer_content=answer_content,
            answer_url=answer_url,
            answer_attachments=answer_attachments,
        )

    def _format_url(self, url: Optional[str]) -> str:
        """
        Format URL content for prompt.

        Args:
            url: URL string or None

        Returns:
            Formatted URL string or empty string
        """
        if not url:
            return ""
        return f"**Reference URL:** [{url}]({url})"

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
        from wecode.service.evaluation.storage_service import EvalStorageService

        # Update task status
        task.status = GradingTaskStatus.RUNNING
        task.team_id = team_id
        task.grader_id = user_id
        task.started_at = datetime.now()
        task.attempt_count = task.attempt_count + 1
        db.flush()

        logger.info(f"Started grading task {task.id} with team {team_id}")

        # Build the grading prompt with presigned URLs
        try:
            storage_service = EvalStorageService()
            prompt = self.build_grading_prompt(db, task, storage_service)
            logger.info(
                f"Built grading prompt for task {task.id} "
                f"(length: {len(prompt)} chars)"
            )
        except Exception as e:
            logger.error(f"Failed to build grading prompt for task {task.id}: {e}")
            task.status = GradingTaskStatus.FAILED
            task.error_message = f"Failed to build grading prompt: {str(e)[:200]}"
            task.completed_at = datetime.now()
            db.flush()
            return task

        # Create Wegent Task via task_kinds_service
        try:
            from app.models.kind import Kind
            from app.models.user import User
            from app.schemas.task import TaskCreate
            from app.services.adapters.task_kinds import task_kinds_service

            # Get the team and user for task creation
            team = db.query(Kind).filter(Kind.id == team_id).first()
            user = db.query(User).filter(User.id == user_id).first()

            if not team:
                raise ValueError(f"Team {team_id} not found")
            if not user:
                raise ValueError(f"User {user_id} not found")

            # Create task with prompt
            task_create = TaskCreate(
                title=f"Grading Task #{task.id}",
                team_id=team.id,
                team_name=team.name,
                team_namespace=team.namespace,
                git_url="",
                git_repo="",
                git_repo_id=0,
                git_domain="",
                branch_name="",
                prompt=prompt,
                type="online",
                task_type="chat",
                auto_delete_executor="true",
                source="evaluation",
            )

            # Create the task
            task_dict = task_kinds_service.create_task_or_append(
                db=db,
                obj_in=task_create,
                user=user,
                task_id=None,
            )

            wegent_task_id = task_dict.get("id")
            task.task_id = wegent_task_id

            logger.info(
                f"Created Wegent Task {wegent_task_id} for grading task {task.id}"
            )

            # Note: The grading task completion will be handled by:
            # 1. Manual polling: Grader checks task status periodically
            # 2. Callback mechanism: When Wegent Task completes, it can call
            #    the grading callback endpoint to update status
            # For now, we rely on manual status updates via the grader UI

        except Exception as e:
            logger.error(
                f"Failed to create Wegent Task for grading task {task.id}: {e}"
            )
            task.status = GradingTaskStatus.FAILED
            task.error_message = f"Failed to create execution task: {str(e)[:200]}"
            task.completed_at = datetime.now()

        db.flush()
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
