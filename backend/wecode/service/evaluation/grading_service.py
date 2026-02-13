# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Grading service for evaluation module.

Handles AI-powered grading tasks and Wegent Task integration.

Report Data Structure:
The report_data JSON field stores versioned report content:
{
    "ai_report": {
        "content": "...",        # AI-generated Markdown content
        "s3_path": "...",        # S3 path for AI report
        "created_at": "..."      # Timestamp
    },
    "human_report": {
        "content": "...",        # Human-reviewed Markdown content
        "s3_path": "...",        # S3 path for human-reviewed report
        "updated_at": "...",     # Timestamp
        "reviewer_id": ...       # User ID of reviewer
    },
    "final_report": {
        "content": "...",        # Final published content (can be text or attachment)
        "s3_path": "...",        # S3 path for final report
        "attachment": {...},     # Optional: uploaded attachment info
        "published_at": "..."    # Timestamp
    },
    "content": "..."             # Convenience field for quick access
}
"""

import logging
from datetime import datetime
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

from wecode.models.evaluation import (
    EvalAnswer,
    EvalGradingTask,
    EvalQuestion,
    EvalQuestionVersion,
    GradingTaskStatus,
)

if TYPE_CHECKING:
    from wecode.service.evaluation.storage_service import EvalStorageService

logger = logging.getLogger(__name__)


# Minimal grading prompt template - only provides the essential content
# The AI bot's system prompt (Ghost.systemPrompt) should define:
# - How to evaluate submissions
# - Output format requirements
# - Language preferences
GRADING_PROMPT_TEMPLATE = """请根据以下信息进行评分：

## 答题人信息

**答题人：** {respondent_name}

## 题目

{question_content}

{question_url}

{question_attachments}

## 评分标准

{criteria_content}

{criteria_url}

{criteria_attachments}

## 学生作答

{answer_content}

{answer_url}

{answer_attachments}

---

请根据评分标准对学生作答进行评分，并生成 Markdown 格式的评分报告。报告中请注明答题人姓名。
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
                EvalQuestion.is_active,
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
                    EvalQuestion.is_active,
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

        The prompt includes:
        - Respondent info (name)
        - Question content (text, URL, attachments)
        - Grading criteria (text, URL, attachments)
        - Student answer (text, URL, attachments)

        Args:
            db: Database session
            task: Grading task
            storage_service: Storage service for presigned URLs

        Returns:
            Formatted prompt string
        """
        from app.models.user import User

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

        # Get respondent user info
        respondent = db.query(User).filter(User.id == task.respondent_id).first()
        respondent_name = (
            respondent.username if respondent else f"User #{task.respondent_id}"
        )

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
            respondent_name=respondent_name,
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
        Complete a grading task with AI results.

        Saves the AI-generated report to S3 and updates the task.

        Args:
            db: Database session
            task: Grading task
            report_content: Markdown report content from AI
            report_s3_path: Optional pre-existing S3 path

        Returns:
            Updated grading task
        """
        from wecode.service.evaluation.storage_service import EvalStorageService

        now = datetime.now()

        # Save AI report to S3 if not already provided
        ai_s3_path = report_s3_path
        if not ai_s3_path and report_content:
            try:
                # Get topic_id from question
                question = (
                    db.query(EvalQuestion)
                    .filter(EvalQuestion.id == task.question_id)
                    .first()
                )
                topic_id = question.topic_id if question else 0

                storage_service = EvalStorageService()
                ai_s3_path = storage_service.save_grading_report(
                    respondent_id=task.respondent_id,
                    topic_id=topic_id,
                    question_id=task.question_id,
                    content=report_content,
                    is_draft=True,  # AI report is draft
                )
                logger.info(f"Saved AI report to S3: {ai_s3_path}")
            except Exception as e:
                logger.warning(f"Failed to save AI report to S3: {e}")

        # Build report_data with versioned structure
        report_data: Dict[str, Any] = {
            "ai_report": {
                "content": report_content,
                "s3_path": ai_s3_path or "",
                "created_at": now.isoformat(),
            },
            # Convenience field for quick access
            "content": report_content,
        }

        task.status = GradingTaskStatus.COMPLETED
        task.report_data = report_data
        task.report_s3_path = ai_s3_path or ""
        task.completed_at = now
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
        attachment: Optional[Dict[str, Any]] = None,
    ) -> EvalGradingTask:
        """
        Publish a grading report to the respondent.

        The final published report can be:
        1. The latest content (human-reviewed or AI)
        2. A newly provided report_content
        3. An uploaded attachment

        Args:
            db: Database session
            task: Grading task
            report_content: Optional final report content
            attachment: Optional uploaded attachment info
                        {key, filename, size, content_type}

        Returns:
            Updated grading task
        """
        now = datetime.now()

        report_data = task.report_data or {}

        # Determine final content
        final_content = report_content
        if not final_content:
            # Use human-reviewed if available, otherwise AI
            if report_data.get("human_report", {}).get("content"):
                final_content = report_data["human_report"]["content"]
            elif report_data.get("ai_report", {}).get("content"):
                final_content = report_data["ai_report"]["content"]
            else:
                final_content = report_data.get("content", "")

        # Determine final S3 path
        final_s3_path = task.report_s3_path
        if attachment and attachment.get("key"):
            final_s3_path = attachment["key"]
        elif report_data.get("human_report", {}).get("s3_path"):
            final_s3_path = report_data["human_report"]["s3_path"]
        elif report_data.get("ai_report", {}).get("s3_path"):
            final_s3_path = report_data["ai_report"]["s3_path"]

        # Build final_report
        report_data["final_report"] = {
            "content": final_content,
            "s3_path": final_s3_path,
            "attachment": attachment,
            "published_at": now.isoformat(),
        }
        # Update convenience field
        report_data["content"] = final_content

        task.report_data = report_data
        task.report_s3_path = final_s3_path or ""
        task.status = GradingTaskStatus.PUBLISHED
        task.published_at = now
        db.flush()

        logger.info(f"Published grading task {task.id}")
        return task

    def update_report(
        self,
        db: Session,
        task: EvalGradingTask,
        report_content: str,
        reviewer_id: Optional[int] = None,
    ) -> EvalGradingTask:
        """
        Update the report content with human review before publishing.

        Saves the human-reviewed version as a separate version while
        preserving the original AI report.

        Args:
            db: Database session
            task: Grading task
            report_content: New report content (human reviewed)
            reviewer_id: ID of the reviewer making changes

        Returns:
            Updated grading task
        """
        from wecode.service.evaluation.storage_service import EvalStorageService

        now = datetime.now()

        # Save human-reviewed report to S3
        human_s3_path = ""
        try:
            question = (
                db.query(EvalQuestion)
                .filter(EvalQuestion.id == task.question_id)
                .first()
            )
            topic_id = question.topic_id if question else 0

            storage_service = EvalStorageService()
            human_s3_path = storage_service.save_grading_report(
                respondent_id=task.respondent_id,
                topic_id=topic_id,
                question_id=task.question_id,
                content=report_content,
                is_draft=False,  # Human-reviewed is not draft
            )
            logger.info(f"Saved human-reviewed report to S3: {human_s3_path}")
        except Exception as e:
            logger.warning(f"Failed to save human-reviewed report to S3: {e}")

        # Update report_data while preserving AI report
        report_data = task.report_data or {}
        report_data["human_report"] = {
            "content": report_content,
            "s3_path": human_s3_path,
            "updated_at": now.isoformat(),
            "reviewer_id": reviewer_id,
        }
        # Update convenience content field to human-reviewed version
        report_data["content"] = report_content

        task.report_data = report_data
        # Update main s3_path to human-reviewed version
        if human_s3_path:
            task.report_s3_path = human_s3_path
        db.flush()

        logger.info(
            f"Updated report for grading task {task.id} (reviewer: {reviewer_id})"
        )
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
