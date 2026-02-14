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
# - Grading criteria interpretation
GRADING_PROMPT_TEMPLATE = """## Evaluation Task

**Respondent:** {respondent_name}

### Question Content
{question_content}
{question_url}
{question_attachments}

### Grading Criteria
{criteria_content}
{criteria_url}
{criteria_attachments}

### Student's Answer
{answer_content}
{answer_url}
{answer_attachments}

---
Please evaluate the above submission according to the grading criteria.
"""


class GradingService:
    """
    Service for managing AI grading tasks.

    This service:
    - Creates grading tasks for answers
    - Creates Wegent Tasks for AI processing
    - Manages grading task lifecycle (status, results, publishing)
    - Copies evaluation attachments to Wegent Task contexts
    """

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

    def create(
        self,
        db: Session,
        topic_id: int,
        question_id: int,
        question_version: str,
        answer_id: int,
        respondent_id: int,
    ) -> EvalGradingTask:
        """
        Create a new grading task.

        Args:
            db: Database session
            topic_id: Topic ID
            question_id: Question ID
            question_version: Question version string
            answer_id: Answer ID
            respondent_id: Respondent user ID

        Returns:
            Created grading task
        """
        task = EvalGradingTask(
            topic_id=topic_id,
            question_id=question_id,
            question_version=question_version,
            answer_id=answer_id,
            respondent_id=respondent_id,
            status=GradingTaskStatus.PENDING,
        )
        db.add(task)
        db.flush()

        logger.info(
            f"[Evaluation] Created grading task {task.id} for "
            f"topic={topic_id}, question={question_id}, answer={answer_id}"
        )

        return task

    def list_by_topic(
        self,
        db: Session,
        topic_id: int,
        status: Optional[GradingTaskStatus] = None,
        respondent_id: Optional[int] = None,
    ) -> List[EvalGradingTask]:
        """
        List grading tasks for a topic.

        Args:
            db: Database session
            topic_id: Topic ID
            status: Optional status filter
            respondent_id: Optional respondent filter

        Returns:
            List of grading tasks
        """
        query = db.query(EvalGradingTask).filter(EvalGradingTask.topic_id == topic_id)

        if status:
            query = query.filter(EvalGradingTask.status == status)

        if respondent_id:
            query = query.filter(EvalGradingTask.respondent_id == respondent_id)

        return query.order_by(EvalGradingTask.created_at.desc()).all()

    def list_by_question(
        self,
        db: Session,
        question_id: int,
        status: Optional[GradingTaskStatus] = None,
    ) -> List[EvalGradingTask]:
        """
        List grading tasks for a question.

        Args:
            db: Database session
            question_id: Question ID
            status: Optional status filter

        Returns:
            List of grading tasks
        """
        query = db.query(EvalGradingTask).filter(
            EvalGradingTask.question_id == question_id
        )

        if status:
            query = query.filter(EvalGradingTask.status == status)

        return query.order_by(EvalGradingTask.created_at.desc()).all()

    def list_by_answer(
        self,
        db: Session,
        answer_id: int,
    ) -> List[EvalGradingTask]:
        """
        List grading tasks for an answer.

        Args:
            db: Database session
            answer_id: Answer ID

        Returns:
            List of grading tasks
        """
        return (
            db.query(EvalGradingTask)
            .filter(EvalGradingTask.answer_id == answer_id)
            .order_by(EvalGradingTask.created_at.desc())
            .all()
        )

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
        Execute a grading task by creating a Wegent Task and calling chat_shell.

        This method creates a proper Task/Subtask record and copies attachments
        to SubtaskContext, allowing chat_shell to access them through the standard
        history loading mechanism.

        Task ownership rules:
        - Auto-triggered tasks: belong to topic creator (team owner)
        - Manual/retry tasks: belong to grader (user_id)

        Args:
            db: Database session
            task: Grading task to execute
            team_id: Team ID for grading
            user_id: User ID initiating the grading (grader)

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

        # Get user (grader)
        user = db.query(User).filter(User.id == user_id).first()
        if not user:
            task.status = GradingTaskStatus.FAILED
            task.error_message = f"User {user_id} not found"
            task.completed_at = datetime.now()
            db.flush()
            return task

        # Extract info for background task
        grading_task_id = task.id
        team_user_id = team.user_id
        user_name = user.user_name

        # Start background thread to run async chat_shell execution
        def run_grading_in_thread():
            """Run the async grading task in a new event loop."""
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                loop.run_until_complete(
                    self._execute_grading_with_task_and_chat_shell(
                        grading_task_id=grading_task_id,
                        team_id=team_id,
                        team_user_id=team_user_id,
                        user_id=user_id,
                        user_name=user_name,
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
                f"[Evaluation] Started background grading execution for task {grading_task_id}"
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

    async def _execute_grading_with_task_and_chat_shell(
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
        Execute grading by creating a Wegent Task and calling chat_shell.

        This method:
        1. Creates a Task record for the grading
        2. Creates USER and ASSISTANT subtasks
        3. Copies evaluation attachments to SubtaskContext
        4. Calls chat_shell via HTTP
        5. Updates the grading task with the result

        Args:
            grading_task_id: ID of the evaluation grading task
            team_id: Team ID for grading
            team_user_id: User ID of the team owner
            user_id: User ID of the grader (task owner)
            user_name: Name of the grader
            prompt: The grading prompt
            attachments: List of attachment info dicts
        """
        from app.core.config import settings
        from app.db.session import SessionLocal
        from app.models.kind import Kind
        from app.models.subtask import SenderType, Subtask, SubtaskRole, SubtaskStatus
        from app.models.subtask_context import (
            ContextStatus,
            ContextType,
            SubtaskContext,
        )
        from app.models.task import TaskResource
        from app.services.chat.adapters.http import HTTPAdapter
        from app.services.chat.adapters.interface import ChatEventType, ChatRequest
        from app.services.chat.config.chat_config import ChatConfigBuilder
        from app.services.chat.storage.task_manager import get_bot_ids_from_team

        logger.info(
            f"[Evaluation] Starting grading execution for task {grading_task_id}"
        )

        db = SessionLocal()

        try:
            # Reload grading task from DB
            grading_task = (
                db.query(EvalGradingTask)
                .filter(EvalGradingTask.id == grading_task_id)
                .first()
            )
            if not grading_task:
                logger.error(f"[Evaluation] Grading task {grading_task_id} not found")
                return

            # Get Team
            team = (
                db.query(Kind)
                .filter(Kind.id == team_id, Kind.is_active == True)
                .first()
            )
            if not team:
                grading_task.status = GradingTaskStatus.FAILED
                grading_task.error_message = f"Team {team_id} not found"
                grading_task.completed_at = datetime.now()
                db.commit()
                return

            # Validate group Team
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

            # Verify grader has access to the team's namespace (group)
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

            # Build chat configuration
            config_builder = ChatConfigBuilder(
                db=db,
                team=team,
                user_id=team_user_id,  # Use team owner's user_id for resource resolution
                user_name=user_name,
            )

            try:
                chat_config = config_builder.build(
                    enable_deep_thinking=False,
                    enable_clarification=False,
                )
            except Exception as e:
                logger.error(
                    f"[Evaluation] Failed to build chat config for task {grading_task_id}: {e}"
                )
                grading_task.status = GradingTaskStatus.FAILED
                grading_task.error_message = f"Failed to configure AI: {str(e)[:200]}"
                grading_task.completed_at = datetime.now()
                db.commit()
                return

            # Validate API key
            api_key = chat_config.model_config.get("api_key", "")
            if not api_key:
                logger.error(
                    f"[Evaluation] API key not configured for task {grading_task_id}"
                )
                grading_task.status = GradingTaskStatus.FAILED
                grading_task.error_message = (
                    "AI model API key is not configured. "
                    "Please check the model configuration for the grading team."
                )
                grading_task.completed_at = datetime.now()
                db.commit()
                return

            # =====================================
            # Create Task and Subtasks
            # =====================================

            # Get question title for task title
            question = (
                db.query(EvalQuestion)
                .filter(EvalQuestion.id == grading_task.question_id)
                .first()
            )
            question_title = (
                question.title if question else f"Question #{grading_task.question_id}"
            )

            # Create Task first (without ID - let database auto-generate)
            # We'll update the metadata.name after getting the generated ID
            task_title = f"[Grading] {question_title}"
            task_json = {
                "kind": "Task",
                "spec": {
                    "title": task_title,
                    "prompt": prompt,
                    "teamRef": {
                        "name": team.name,
                        "namespace": team.namespace,
                        "user_id": team.user_id,
                    },
                    "workspaceRef": {"name": "temp-workspace", "namespace": "default"},
                    "is_group_chat": False,
                    # Mark as grading task for filtering
                    "grading_task_id": grading_task_id,
                },
                "status": {
                    "state": "Available",
                    "status": "RUNNING",
                    "progress": 0,
                    "result": None,
                    "errorMessage": "",
                    "createdAt": datetime.now().isoformat(),
                    "updatedAt": datetime.now().isoformat(),
                    "completedAt": None,
                },
                "metadata": {
                    "name": "temp-task",
                    "namespace": "default",
                    "labels": {
                        "type": "online",
                        "taskType": "grading",
                        "autoDeleteExecutor": "false",
                        "source": "evaluation",
                    },
                },
                "apiVersion": "agent.wecode.io/v1",
            }
            wegent_task = TaskResource(
                # Don't specify id - let database auto-generate to avoid conflicts
                user_id=user_id,
                kind="Task",
                name="temp-task",
                namespace="default",
                json=task_json,
                is_active=True,
            )
            db.add(wegent_task)
            db.flush()  # Get auto-generated task ID

            # Now we have the real task ID
            new_task_id = wegent_task.id

            # Update task metadata with real task ID
            task_json["metadata"]["name"] = f"task-{new_task_id}"
            task_json["spec"]["workspaceRef"]["name"] = f"workspace-{new_task_id}"
            wegent_task.name = f"task-{new_task_id}"
            wegent_task.json = task_json

            # Create Workspace with the real task ID
            workspace_name = f"workspace-{new_task_id}"
            workspace_json = {
                "kind": "Workspace",
                "spec": {"repository": {}},
                "status": {"state": "Available"},
                "metadata": {"name": workspace_name, "namespace": "default"},
                "apiVersion": "agent.wecode.io/v1",
            }
            workspace = TaskResource(
                user_id=user_id,
                kind="Workspace",
                name=workspace_name,
                namespace="default",
                json=workspace_json,
                is_active=True,
            )
            db.add(workspace)
            db.flush()

            # Update grading task with wegent_task_id
            grading_task.wegent_task_id = new_task_id

            # Get bot IDs from team
            bot_ids = get_bot_ids_from_team(db, team)

            # Create USER subtask (user message with prompt)
            user_subtask = Subtask(
                user_id=user_id,
                task_id=new_task_id,
                team_id=team_id,
                title="Grading request",
                bot_ids=bot_ids,
                role=SubtaskRole.USER,
                executor_namespace="",
                executor_name="",
                prompt=prompt,
                status=SubtaskStatus.COMPLETED,
                progress=100,
                message_id=1,
                parent_id=0,
                completed_at=datetime.now(),
                result=None,
                sender_type=SenderType.USER,
                sender_user_id=user_id,
            )
            db.add(user_subtask)
            db.flush()

            # Create ASSISTANT subtask (AI response placeholder)
            assistant_subtask = Subtask(
                user_id=user_id,
                task_id=new_task_id,
                team_id=team_id,
                title="Grading response",
                bot_ids=bot_ids,
                role=SubtaskRole.ASSISTANT,
                executor_namespace="",
                executor_name="",
                prompt="",
                status=SubtaskStatus.RUNNING,
                progress=0,
                message_id=2,
                parent_id=1,
                result=None,
                sender_type=SenderType.TEAM,
                sender_user_id=0,
            )
            db.add(assistant_subtask)
            db.flush()

            # =====================================
            # Copy Attachments to SubtaskContext
            # =====================================
            if attachments:
                from wecode.service.evaluation.storage_service import EvalStorageService

                storage_service = EvalStorageService()

                for att in attachments:
                    s3_key = att.get("key", "")
                    filename = att.get("filename", "unknown")
                    content_type = att.get("content_type", "application/octet-stream")

                    # Determine if it's an image
                    is_image = content_type.startswith("image/")

                    # Create SubtaskContext for attachment
                    context = SubtaskContext(
                        subtask_id=user_subtask.id,
                        user_id=user_id,
                        context_type=ContextType.ATTACHMENT.value,
                        name=filename,
                        status=ContextStatus.READY.value,
                        type_data={
                            "original_filename": filename,
                            "file_extension": (
                                filename.rsplit(".", 1)[-1] if "." in filename else ""
                            ),
                            "mime_type": content_type,
                            "storage_backend": "s3",
                            "storage_key": s3_key,
                            "is_encrypted": False,
                        },
                    )

                    # For images, try to load base64 for vision model
                    if is_image and storage_service.client:
                        try:
                            import base64
                            from io import BytesIO

                            response = storage_service.client.get_object(
                                storage_service._bucket, s3_key
                            )
                            image_data = response.read()
                            response.close()
                            response.release_conn()

                            context.image_base64 = base64.b64encode(image_data).decode(
                                "utf-8"
                            )
                            context.type_data["file_size"] = len(image_data)
                            logger.info(
                                f"[Evaluation] Loaded image attachment: {filename} ({len(image_data)} bytes)"
                            )
                        except Exception as e:
                            logger.warning(
                                f"[Evaluation] Failed to load image {filename}: {e}"
                            )

                    db.add(context)

                logger.info(
                    f"[Evaluation] Created {len(attachments)} SubtaskContext records for task {new_task_id}"
                )

            db.commit()

            logger.info(
                f"[Evaluation] Created Wegent Task {new_task_id} with subtasks "
                f"user={user_subtask.id}, assistant={assistant_subtask.id}"
            )

            # =====================================
            # Call chat_shell
            # =====================================
            chat_request = ChatRequest(
                task_id=new_task_id,
                subtask_id=assistant_subtask.id,
                user_subtask_id=user_subtask.id,  # For history loading
                message=prompt,
                user_id=user_id,
                user_name=user_name,
                team_id=team_id,
                team_name=team.name,
                request_id=f"eval-grading-{grading_task_id}",
                message_id=assistant_subtask.message_id,
                user_message_id=user_subtask.message_id,
                model_config=chat_config.model_config,
                system_prompt=chat_config.system_prompt,
                enable_tools=False,
                enable_web_search=False,
                enable_clarification=False,
                enable_deep_thinking=False,
                bot_name=chat_config.bot_name,
                bot_namespace=chat_config.bot_namespace,
            )

            # Create HTTP adapter
            chat_shell_url = getattr(
                settings, "CHAT_SHELL_URL", "http://localhost:8001"
            )
            chat_shell_token = getattr(settings, "INTERNAL_SERVICE_TOKEN", "")

            adapter = HTTPAdapter(
                base_url=chat_shell_url,
                token=chat_shell_token,
                timeout=600.0,
            )

            logger.info(
                f"[Evaluation] Calling chat_shell for task {new_task_id} "
                f"(grading_task={grading_task_id}, url={chat_shell_url})"
            )

            # Stream response
            full_response = ""
            error_message = ""

            try:
                async for event in adapter.chat(chat_request):
                    if event.type == ChatEventType.CHUNK:
                        chunk_text = event.data.get("content", "")
                        if chunk_text:
                            full_response += chunk_text

                    elif event.type == ChatEventType.DONE:
                        result = event.data.get("result", {})
                        if result.get("content"):
                            final_content = result.get("content", "")
                            if final_content and len(final_content) > len(
                                full_response
                            ):
                                full_response = final_content
                        logger.info(
                            f"[Evaluation] Chat completed for task {new_task_id}"
                        )
                        break

                    elif event.type == ChatEventType.ERROR:
                        error_message = event.data.get("error", "Unknown error")
                        logger.error(
                            f"[Evaluation] Chat error for task {new_task_id}: {error_message}"
                        )
                        break

                    elif event.type == ChatEventType.CANCELLED:
                        error_message = "Chat was cancelled"
                        logger.warning(
                            f"[Evaluation] Chat cancelled for task {new_task_id}"
                        )
                        break

            except Exception as e:
                error_message = f"Chat shell communication error: {str(e)}"
                logger.exception(
                    f"[Evaluation] Exception during chat for task {new_task_id}"
                )

            # =====================================
            # Update results
            # =====================================
            db.refresh(grading_task)
            db.refresh(assistant_subtask)
            db.refresh(wegent_task)

            if full_response and not error_message:
                # Success - update assistant subtask
                assistant_subtask.status = SubtaskStatus.COMPLETED
                assistant_subtask.progress = 100
                assistant_subtask.result = {"value": full_response}
                assistant_subtask.completed_at = datetime.now()

                # Update task status
                task_json = wegent_task.json
                task_json["status"]["status"] = "COMPLETED"
                task_json["status"]["progress"] = 100
                task_json["status"]["completedAt"] = datetime.now().isoformat()
                wegent_task.json = task_json

                # Complete grading task
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
                # Failed - update assistant subtask
                assistant_subtask.status = SubtaskStatus.FAILED
                assistant_subtask.result = {"error": error_message}
                assistant_subtask.completed_at = datetime.now()

                # Update task status
                task_json = wegent_task.json
                task_json["status"]["status"] = "FAILED"
                task_json["status"]["errorMessage"] = error_message
                task_json["status"]["completedAt"] = datetime.now().isoformat()
                wegent_task.json = task_json

                # Fail grading task
                self.fail(
                    db=db,
                    task=grading_task,
                    error_message=error_message or "No response from AI",
                )

            db.commit()

        except Exception as e:
            logger.exception(
                f"[Evaluation] Unexpected error in grading task {grading_task_id}"
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
                logger.exception(
                    f"[Evaluation] Failed to update grading task status after error"
                )
        finally:
            db.close()

    def complete(
        self,
        db: Session,
        task: EvalGradingTask,
        report_content: str,
    ) -> EvalGradingTask:
        """
        Mark a grading task as completed with AI report.

        Args:
            db: Database session
            task: Grading task
            report_content: AI-generated report content (Markdown)

        Returns:
            Updated grading task
        """
        from wecode.service.evaluation.storage_service import EvalStorageService

        storage_service = EvalStorageService()

        # Save AI report to S3
        s3_path = storage_service.save_grading_report(
            respondent_id=task.respondent_id,
            topic_id=task.topic_id,
            question_id=task.question_id,
            content=report_content,
            is_draft=True,
        )

        if s3_path:
            logger.info(f"[Evaluation] Uploaded AI report to S3: {s3_path}")
        else:
            logger.warning(
                f"[Evaluation] Failed to upload AI report to S3, storing in DB only"
            )

        # Update task
        task.status = GradingTaskStatus.COMPLETED
        task.completed_at = datetime.now()
        task.report_data = {
            "ai_report": {
                "content": report_content,
                "s3_path": s3_path,
                "created_at": datetime.now().isoformat(),
            },
            "content": report_content,  # Convenience field
        }
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
        task.error_message = error_message[:500] if error_message else "Unknown error"
        task.completed_at = datetime.now()
        db.flush()

        logger.info(f"[Evaluation] Failed grading task {task.id}: {error_message}")

        return task

    def update_report(
        self,
        db: Session,
        task: EvalGradingTask,
        report_content: str,
        reviewer_id: int,
    ) -> EvalGradingTask:
        """
        Update grading task with human-reviewed report.

        Args:
            db: Database session
            task: Grading task
            report_content: Human-reviewed report content
            reviewer_id: Reviewer user ID

        Returns:
            Updated grading task
        """
        from wecode.service.evaluation.storage_service import EvalStorageService

        storage_service = EvalStorageService()

        # Save human-reviewed report to S3 (using same pattern as AI report)
        s3_path = storage_service.save_grading_report(
            respondent_id=task.respondent_id,
            topic_id=task.topic_id,
            question_id=task.question_id,
            content=report_content,
            is_draft=True,  # Still a draft until published
        )

        if s3_path:
            logger.info(f"[Evaluation] Uploaded reviewed report to S3: {s3_path}")

        # Update task
        report_data = task.report_data or {}
        report_data["human_report"] = {
            "content": report_content,
            "s3_path": s3_path,
            "updated_at": datetime.now().isoformat(),
            "reviewer_id": reviewer_id,
        }
        report_data["content"] = report_content  # Update convenience field
        task.report_data = report_data
        db.flush()

        logger.info(f"[Evaluation] Updated report for grading task {task.id}")

        return task

    def publish(
        self,
        db: Session,
        task: EvalGradingTask,
        final_content: Optional[str] = None,
        attachment: Optional[Dict] = None,
    ) -> EvalGradingTask:
        """
        Publish grading report (make visible to respondent).

        Args:
            db: Database session
            task: Grading task
            final_content: Optional final content (if different from current)
            attachment: Optional attachment info for uploaded report

        Returns:
            Updated grading task
        """
        from wecode.service.evaluation.storage_service import EvalStorageService

        storage_service = EvalStorageService()

        # Determine final content
        report_data = task.report_data or {}
        if final_content:
            content = final_content
        elif attachment:
            # Use attachment as final report
            content = None  # Content is in attachment
        elif "human_report" in report_data:
            content = report_data["human_report"].get("content", "")
        elif "ai_report" in report_data:
            content = report_data["ai_report"].get("content", "")
        else:
            content = report_data.get("content", "")

        # Save final report to S3
        s3_path = None
        if content:
            s3_path = storage_service.save_grading_report(
                respondent_id=task.respondent_id,
                topic_id=task.topic_id,
                question_id=task.question_id,
                content=content,
                is_draft=False,  # Final report
            )
            if s3_path:
                logger.info(f"[Evaluation] Uploaded final report to S3: {s3_path}")

        # Update task
        report_data["final_report"] = {
            "content": content,
            "s3_path": s3_path,
            "attachment": attachment,
            "published_at": datetime.now().isoformat(),
        }
        if content:
            report_data["content"] = content

        task.report_data = report_data
        task.status = GradingTaskStatus.PUBLISHED
        task.published_at = datetime.now()
        db.flush()

        logger.info(f"[Evaluation] Published grading task {task.id}")

        return task

    def batch_execute(
        self,
        db: Session,
        task_ids: List[int],
        team_id: int,
        user_id: int,
    ) -> List[EvalGradingTask]:
        """
        Batch execute multiple grading tasks.

        Args:
            db: Database session
            task_ids: List of grading task IDs
            team_id: Team ID for grading
            user_id: User ID initiating the grading

        Returns:
            List of updated grading tasks
        """
        tasks = []
        for task_id in task_ids:
            task = self.get(db, task_id)
            if task and task.status in (
                GradingTaskStatus.PENDING,
                GradingTaskStatus.FAILED,
            ):
                updated = self.execute(db, task, team_id, user_id)
                tasks.append(updated)

        return tasks

    def batch_publish(
        self,
        db: Session,
        task_ids: List[int],
    ) -> List[EvalGradingTask]:
        """
        Batch publish multiple grading tasks.

        Args:
            db: Database session
            task_ids: List of grading task IDs

        Returns:
            List of updated grading tasks
        """
        tasks = []
        for task_id in task_ids:
            task = self.get(db, task_id)
            if task and task.status == GradingTaskStatus.COMPLETED:
                updated = self.publish(db, task)
                tasks.append(updated)

        return tasks


# Module-level instance for convenience
grading_service = GradingService()
