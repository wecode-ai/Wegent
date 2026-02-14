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

import asyncio
import logging
import threading
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
    from app.models.kind import Kind
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

        logger.info(
            f"[Evaluation] Created grading task {task.id} for answer {answer.id}"
        )
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
        # Get question IDs for this topic - use scalar_subquery for IN clause
        question_ids = (
            db.query(EvalQuestion.id)
            .filter(
                EvalQuestion.topic_id == topic_id,
                EvalQuestion.is_active,
            )
            .scalar_subquery()
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
                .scalar_subquery()
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
            storage_service: Not used (kept for compatibility)

        Returns:
            Formatted prompt string
        """
        prompt, _ = self._build_grading_prompt_and_attachments(db, task)
        return prompt

    def _build_grading_prompt_and_attachments(
        self,
        db: Session,
        task: EvalGradingTask,
    ) -> Tuple[str, List[Dict]]:
        """
        Build the grading prompt and collect attachments for a task.

        The prompt includes:
        - Respondent info (name)
        - Question content (text, URL, attachments)
        - Grading criteria (text, URL, attachments)
        - Student answer (text, URL, attachments)

        Args:
            db: Database session
            task: Grading task

        Returns:
            Tuple of (formatted prompt string, list of attachment info dicts)
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
            respondent.user_name if respondent else f"User #{task.respondent_id}"
        )

        # Collect all attachment keys for later copying to SubtaskContext
        all_attachments = []

        # Format question content
        question_content = question_version.content_data.get("text", "") or ""
        question_url = self._format_url(question_version.content_data.get("url"))
        q_attachments = question_version.content_data.get("attachments", [])
        question_attachments = self._format_attachments(q_attachments)
        all_attachments.extend(self._collect_attachment_keys(q_attachments))

        # Format criteria content
        criteria_content = question_version.criteria_data.get("text", "") or ""
        criteria_url = self._format_url(question_version.criteria_data.get("url"))
        c_attachments = question_version.criteria_data.get("attachments", [])
        criteria_attachments = self._format_attachments(c_attachments)
        all_attachments.extend(self._collect_attachment_keys(c_attachments))

        # Format answer content
        answer_content = answer.content_data.get("text", "") or ""
        answer_url = self._format_url(answer.content_data.get("url"))
        a_attachments = answer.content_data.get("attachments", [])
        answer_attachments = self._format_attachments(a_attachments)
        all_attachments.extend(self._collect_attachment_keys(a_attachments))

        prompt = GRADING_PROMPT_TEMPLATE.format(
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

        return prompt, all_attachments

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
        Format attachments for prompt display with presigned URLs.

        Generates presigned URLs for each attachment so the AI can access the content.
        For images, the AI can view them directly. For documents, the AI can
        reference them via the URL.

        Args:
            attachments: List of attachment dictionaries with 'key', 'filename', etc.
            storage_service: Storage service for generating presigned URLs

        Returns:
            Formatted attachment string with filenames and URLs
        """
        if not attachments:
            return ""

        # Initialize storage service if not provided
        if storage_service is None:
            from wecode.service.evaluation.storage_service import EvalStorageService

            storage_service = EvalStorageService()

        lines = ["**Attachments:**"]
        for att in attachments:
            filename = att.get("filename", "Unknown")
            key = att.get("key", "")

            if key and storage_service:
                # Generate presigned URL for the attachment (valid for 1 hour)
                url = storage_service.get_presigned_url(key, expires=3600)
                if url:
                    lines.append(f"- [{filename}]({url})")
                else:
                    lines.append(f"- {filename} (URL unavailable)")
            else:
                lines.append(f"- {filename}")

        return "\n".join(lines)

    def _collect_attachment_keys(
        self,
        attachments: List[Dict],
    ) -> List[Dict]:
        """
        Collect attachment information for copying to SubtaskContext.

        Args:
            attachments: List of attachment dictionaries from EvalQuestion/EvalAnswer

        Returns:
            List of attachment info dicts with key, filename, and content_type
        """
        result = []
        for att in attachments:
            if att.get("key"):
                result.append(
                    {
                        "key": att["key"],
                        "filename": att.get("filename", "unknown"),
                        "content_type": att.get(
                            "content_type", "application/octet-stream"
                        ),
                    }
                )
        return result

    def execute(
        self,
        db: Session,
        task: EvalGradingTask,
        team_id: int,
        user_id: int,
    ) -> EvalGradingTask:
        """
        Execute a grading task using chat_shell service directly.

        This method calls chat_shell via HTTP to perform AI grading, without
        creating Wegent Tasks or using the executor. This is because Chat shell
        type is not supported by the executor.

        The actual AI call runs in the background, so this method returns
        immediately after starting the grading task.

        Note: This method bypasses normal Team permission checks because:
        1. The grader has already been verified to have grading permission for the topic
        2. The team_id comes from the topic's grading_team_config, configured by the creator
        3. The creator has implicitly authorized graders to use this team for grading

        Args:
            db: Database session
            task: Grading task to execute
            team_id: Team ID for grading
            user_id: User ID initiating the grading

        Returns:
            Updated grading task
        """
        from app.models.kind import Kind
        from app.models.user import User

        # Update task status
        task.status = GradingTaskStatus.RUNNING
        task.team_id = team_id
        task.grader_id = user_id
        task.started_at = datetime.now()
        task.attempt_count = task.attempt_count + 1
        db.flush()

        logger.info(f"[Evaluation] Started grading task {task.id} with team {team_id}")

        # Build the grading prompt and collect attachments
        try:
            prompt, attachments = self._build_grading_prompt_and_attachments(db, task)
            logger.info(
                f"[Evaluation] Built grading prompt for task {task.id} "
                f"(length: {len(prompt)} chars, attachments: {len(attachments)})"
            )
        except Exception as e:
            logger.error(
                f"[Evaluation] Failed to build grading prompt for task {task.id}: {e}"
            )
            task.status = GradingTaskStatus.FAILED
            task.error_message = f"Failed to build grading prompt: {str(e)[:200]}"
            task.completed_at = datetime.now()
            db.flush()
            return task

        # Get Team for configuration
        team = db.query(Kind).filter(Kind.id == team_id, Kind.is_active == True).first()
        if not team:
            task.status = GradingTaskStatus.FAILED
            task.error_message = f"Team {team_id} not found"
            task.completed_at = datetime.now()
            db.flush()
            return task

        # Get user
        user = db.query(User).filter(User.id == user_id).first()
        if not user:
            task.status = GradingTaskStatus.FAILED
            task.error_message = f"User {user_id} not found"
            task.completed_at = datetime.now()
            db.flush()
            return task

        # Extract task ID for logging (use grading task ID as reference)
        grading_task_id = task.id
        team_user_id = team.user_id
        user_name_for_task = user.user_name

        # Start background thread to run async chat_shell execution
        # We use threading because this is called from a sync context (FastAPI sync endpoint)
        def run_grading_in_thread():
            """Run the async grading task in a new event loop."""
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                loop.run_until_complete(
                    self._execute_grading_with_chat_shell(
                        grading_task_id=grading_task_id,
                        team_id=team_id,
                        team_user_id=team_user_id,
                        user_id=user_id,
                        user_name=user_name_for_task,
                        prompt=prompt,
                        attachments=attachments,
                    )
                )
            finally:
                loop.close()

        try:
            # Start background thread
            thread = threading.Thread(target=run_grading_in_thread, daemon=True)
            thread.start()

            logger.info(
                f"[Evaluation] Started background chat_shell execution for grading task {grading_task_id}"
            )

        except Exception as e:
            logger.error(
                f"[Evaluation] Failed to start background task for grading task {grading_task_id}: {e}"
            )
            task.status = GradingTaskStatus.FAILED
            task.error_message = f"Failed to start AI grading: {str(e)[:200]}"
            task.completed_at = datetime.now()
            db.flush()

        return task

    async def _execute_grading_with_chat_shell(
        self,
        grading_task_id: int,
        team_id: int,
        team_user_id: int,
        user_id: int,
        user_name: str,
        prompt: str,
        attachments: List[Dict],
    ) -> None:
        """
        Execute grading by calling chat_shell service directly.

        This async method is run in the background to avoid blocking the API.
        It builds a ChatRequest, calls chat_shell via HTTP, collects the response,
        and updates the grading task with the result.

        Args:
            grading_task_id: ID of the evaluation grading task
            team_id: Team ID for grading
            team_user_id: User ID of the team owner
            user_id: User ID of the grader
            user_name: Name of the grader
            prompt: The grading prompt
            attachments: List of attachment info dicts
        """
        from app.core.config import settings
        from app.services.chat.adapters.http import HTTPAdapter
        from app.services.chat.adapters.interface import ChatEventType, ChatRequest
        from app.services.chat.config.chat_config import ChatConfigBuilder

        logger.info(
            f"[Evaluation] Starting chat_shell execution for grading task {grading_task_id}"
        )

        # Create a new database session for async operation
        from app.db.session import SessionLocal

        db = SessionLocal()

        try:
            # Reload grading task from DB
            grading_task = (
                db.query(EvalGradingTask)
                .filter(EvalGradingTask.id == grading_task_id)
                .first()
            )
            if not grading_task:
                logger.error(
                    f"[Evaluation] Grading task {grading_task_id} not found in background task"
                )
                return

            # Get Team for configuration
            from app.models.kind import Kind

            team = (
                db.query(Kind).filter(Kind.id == team_id, Kind.is_active == True).first()
            )
            if not team:
                grading_task.status = GradingTaskStatus.FAILED
                grading_task.error_message = f"Team {team_id} not found"
                grading_task.completed_at = datetime.now()
                db.commit()
                return

            # Validate that the Team is a group Team (namespace != 'default' and != 'system')
            # This ensures proper resource sharing between creator and grader
            if team.namespace in ("default", "system"):
                logger.error(
                    f"[Evaluation] Team {team_id} is not a group Team (namespace: {team.namespace})"
                )
                grading_task.status = GradingTaskStatus.FAILED
                grading_task.error_message = (
                    "The grading team must be a group team, not a private team. "
                    "Please ask the topic creator to configure a group team for grading."
                )
                grading_task.completed_at = datetime.now()
                db.commit()
                return

            # Verify that grader has access to the team's namespace (group)
            from app.services.group_permission import get_user_groups

            user_groups = get_user_groups(db, user_id)
            if team.namespace not in user_groups:
                logger.error(
                    f"[Evaluation] User {user_id} does not have access to group {team.namespace}"
                )
                grading_task.status = GradingTaskStatus.FAILED
                grading_task.error_message = (
                    f"You do not have access to the grading team's group '{team.namespace}'. "
                    "Please contact the group administrator to grant you access."
                )
                grading_task.completed_at = datetime.now()
                db.commit()
                return

            # Build chat configuration using ChatConfigBuilder
            # This resolves Bot, Model, Ghost and builds system prompt
            config_builder = ChatConfigBuilder(
                db=db,
                team=team,
                user_id=team_user_id,  # Use team owner's user_id for resource resolution
                user_name=user_name,
            )

            try:
                chat_config = config_builder.build(
                    enable_deep_thinking=False,  # Grading doesn't need deep thinking
                    enable_clarification=False,
                )
            except Exception as e:
                logger.error(
                    f"[Evaluation] Failed to build chat config for grading task {grading_task_id}: {e}"
                )
                grading_task.status = GradingTaskStatus.FAILED
                grading_task.error_message = f"Failed to configure AI: {str(e)[:200]}"
                grading_task.completed_at = datetime.now()
                db.commit()
                return

            # Validate that API key is configured
            api_key = chat_config.model_config.get("api_key", "")
            if not api_key:
                logger.error(
                    f"[Evaluation] API key not configured for grading task {grading_task_id}"
                )
                grading_task.status = GradingTaskStatus.FAILED
                grading_task.error_message = (
                    "AI model API key is not configured. "
                    "Please check the model configuration for the grading team."
                )
                grading_task.completed_at = datetime.now()
                db.commit()
                return

            # Create ChatRequest
            # Use grading_task_id as a pseudo task/subtask ID for tracking
            chat_request = ChatRequest(
                task_id=grading_task_id,
                subtask_id=grading_task_id,
                message=prompt,
                user_id=user_id,
                user_name=user_name,
                team_id=team_id,
                team_name=team.name,
                request_id=f"eval-grading-{grading_task_id}",
                model_config=chat_config.model_config,
                system_prompt=chat_config.system_prompt,
                enable_tools=False,  # Grading doesn't need tools
                enable_web_search=False,
                enable_clarification=False,
                enable_deep_thinking=False,
                bot_name=chat_config.bot_name,
                bot_namespace=chat_config.bot_namespace,
            )

            # Create HTTP adapter to call chat_shell
            chat_shell_url = getattr(settings, "CHAT_SHELL_URL", "http://localhost:8001")
            chat_shell_token = getattr(settings, "INTERNAL_SERVICE_TOKEN", "")

            adapter = HTTPAdapter(
                base_url=chat_shell_url,
                token=chat_shell_token,
                timeout=600.0,  # 10 minutes timeout for grading
            )

            logger.info(
                f"[Evaluation] Calling chat_shell for grading task {grading_task_id} "
                f"(url={chat_shell_url})"
            )

            # Stream response and collect content
            full_response = ""
            error_message = ""

            try:
                async for event in adapter.chat(chat_request):
                    if event.type == ChatEventType.CHUNK:
                        chunk_text = event.data.get("content", "")
                        if chunk_text:
                            full_response += chunk_text

                    elif event.type == ChatEventType.DONE:
                        # Done event may contain final result
                        result = event.data.get("result", {})
                        if result.get("content"):
                            # Use final content if different from accumulated
                            final_content = result.get("content", "")
                            if final_content and len(final_content) > len(full_response):
                                full_response = final_content
                        logger.info(
                            f"[Evaluation] Chat completed for grading task {grading_task_id}"
                        )
                        break

                    elif event.type == ChatEventType.ERROR:
                        error_message = event.data.get("error", "Unknown error")
                        logger.error(
                            f"[Evaluation] Chat error for grading task {grading_task_id}: {error_message}"
                        )
                        break

                    elif event.type == ChatEventType.CANCELLED:
                        error_message = "Chat was cancelled"
                        logger.warning(
                            f"[Evaluation] Chat cancelled for grading task {grading_task_id}"
                        )
                        break

            except Exception as e:
                error_message = f"Chat shell communication error: {str(e)}"
                logger.exception(
                    f"[Evaluation] Exception during chat for grading task {grading_task_id}"
                )

            # Reload grading task to get fresh state (in case it was modified)
            db.refresh(grading_task)

            # Update grading task with result
            if full_response and not error_message:
                # Success - complete the task
                self.complete(
                    db=db,
                    task=grading_task,
                    report_content=full_response,
                )
                logger.info(
                    f"[Evaluation] Successfully completed grading task {grading_task_id} "
                    f"(response length: {len(full_response)})"
                )
            else:
                # Failed
                self.fail(
                    db=db,
                    task=grading_task,
                    error_message=error_message or "No response from AI",
                )

            db.commit()

        except Exception as e:
            logger.exception(
                f"[Evaluation] Unexpected error in background grading task {grading_task_id}"
            )
            try:
                grading_task = (
                    db.query(EvalGradingTask)
                    .filter(EvalGradingTask.id == grading_task_id)
                    .first()
                )
                if grading_task:
                    grading_task.status = GradingTaskStatus.FAILED
                    grading_task.error_message = f"Unexpected error: {str(e)[:200]}"
                    grading_task.completed_at = datetime.now()
                    db.commit()
            except Exception:
                pass
        finally:
            db.close()

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
                logger.info(f"[Evaluation] Saved AI report to S3: {ai_s3_path}")
            except Exception as e:
                logger.warning(f"[Evaluation] Failed to save AI report to S3: {e}")

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

        logger.info(f"[Evaluation] Completed grading task {task.id}")
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

        logger.info(f"[Evaluation] Failed grading task {task.id}: {error_message}")
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

        The final report is ALWAYS saved to S3 with a new path to maintain
        a permanent record of the published content.

        Args:
            db: Database session
            task: Grading task
            report_content: Optional final report content
            attachment: Optional uploaded attachment info
                        {key, filename, size, content_type}

        Returns:
            Updated grading task
        """
        from wecode.service.evaluation.storage_service import EvalStorageService

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
        final_s3_path = ""

        # If attachment is provided, use its key
        if attachment and attachment.get("key"):
            final_s3_path = attachment["key"]
        elif final_content:
            # Always save final report content to S3 as a new final version
            # This ensures we have a permanent record of what was published
            try:
                question = (
                    db.query(EvalQuestion)
                    .filter(EvalQuestion.id == task.question_id)
                    .first()
                )
                topic_id = question.topic_id if question else 0

                storage_service = EvalStorageService()
                final_s3_path = storage_service.save_grading_report(
                    respondent_id=task.respondent_id,
                    topic_id=topic_id,
                    question_id=task.question_id,
                    content=final_content,
                    is_draft=False,  # Final published version
                )
                logger.info(f"[Evaluation] Saved final report to S3: {final_s3_path}")
            except Exception as e:
                logger.warning(f"[Evaluation] Failed to save final report to S3: {e}")
                # Fallback to existing S3 path
                if report_data.get("human_report", {}).get("s3_path"):
                    final_s3_path = report_data["human_report"]["s3_path"]
                elif report_data.get("ai_report", {}).get("s3_path"):
                    final_s3_path = report_data["ai_report"]["s3_path"]
                else:
                    final_s3_path = task.report_s3_path or ""

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

        logger.info(f"[Evaluation] Published grading task {task.id}")
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
            logger.info(
                f"[Evaluation] Saved human-reviewed report to S3: {human_s3_path}"
            )
        except Exception as e:
            logger.warning(
                f"[Evaluation] Failed to save human-reviewed report to S3: {e}"
            )

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
            f"[Evaluation] Updated report for grading task {task.id} (reviewer: {reviewer_id})"
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
