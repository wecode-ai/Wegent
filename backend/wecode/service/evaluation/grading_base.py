# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Base classes and shared utilities for evaluation grading service."""

import asyncio
import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime

# Import for type hints only - avoid circular imports at runtime
from typing import TYPE_CHECKING, List, Optional, Tuple

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.subtask import Subtask, SubtaskStatus
from app.models.subtask_context import ContextStatus, ContextType, SubtaskContext
from app.models.user import User
from wecode.models.evaluation import EvalGradingTask, GradingTaskStatus
from wecode.service.evaluation.storage_service import EvalStorageService

if TYPE_CHECKING:
    from app.models.task import TaskResource

logger = logging.getLogger(__name__)


@dataclass
class AttachmentInfo:
    """Information about an attachment."""

    key: str
    filename: str
    content_type: str


@dataclass
class GradingContext:
    """Context object holding shared state for grading operations.

    IMPORTANT: This context is passed to background threads. To avoid SQLAlchemy
    session/threading issues, ONLY primitive types (int, str, etc.) should be used.
    DO NOT include SQLAlchemy ORM objects (EvalGradingTask, User, Kind, etc.)
    as they are bound to the creating thread's session.
    """

    task_id: int  # Grading task ID (primary key)
    user_id: int  # User ID who owns the grading
    team_id: int  # Team ID for AI grading
    prompt: str  # Grading prompt
    attachments: List[AttachmentInfo] = field(default_factory=list)
    grading_timeout: int = 3600
    model_id: Optional[str] = None
    force_override_bot_model: bool = False


class GradingStrategy(ABC):
    """Abstract base class for grading strategies."""

    def __init__(self):
        self._storage_service = EvalStorageService()

    @abstractmethod
    async def execute(self, ctx: GradingContext) -> None:
        """Execute the grading strategy."""
        pass

    async def _copy_attachments_to_context(
        self,
        db: Session,
        subtask_id: int,
        user_id: int,
        attachments: List[AttachmentInfo],
    ) -> None:
        """Copy evaluation attachments to SubtaskContext records."""
        from app.services.attachment.parser import DocumentParseError, DocumentParser

        for att in attachments:
            context = self._create_attachment_context(db, subtask_id, user_id, att)
            if context:
                db.add(context)

    def _create_attachment_context(
        self,
        _db: Session,
        subtask_id: int,
        user_id: int,
        att: AttachmentInfo,
    ) -> Optional[SubtaskContext]:
        """Create a SubtaskContext for an attachment."""
        from app.services.attachment.parser import DocumentParseError, DocumentParser

        file_extension = (
            "." + att.filename.rsplit(".", 1)[-1].lower() if "." in att.filename else ""
        )
        is_image = att.content_type.startswith("image/")

        context = SubtaskContext(
            subtask_id=subtask_id,
            user_id=user_id,
            context_type=ContextType.ATTACHMENT.value,
            name=att.filename,
            status=ContextStatus.READY.value,
            type_data={
                "original_filename": att.filename,
                "file_extension": file_extension.lstrip("."),
                "mime_type": att.content_type,
                "storage_backend": "s3",
                "storage_key": att.key,
                "is_encrypted": False,
            },
        )

        if not self._storage_service.client:
            return context

        try:
            response = self._storage_service.client.get_object(
                self._storage_service._bucket, att.key
            )
            file_data = response.read()
            response.close()
            response.release_conn()

            context.type_data["file_size"] = len(file_data)

            if is_image:
                context.binary_data = file_data
            else:
                try:
                    doc_parser = DocumentParser()
                    parse_result = doc_parser.parse(file_data, file_extension)
                    context.extracted_text = parse_result.text
                    context.text_length = parse_result.text_length
                except DocumentParseError:
                    context.binary_data = file_data

        except Exception as e:
            logger.warning(
                f"[GradingStrategy] Failed to load attachment {att.filename}: {e}"
            )

        return context

    async def _wait_for_subtask_completion(
        self,
        db: Session,
        assistant_subtask_id: int,
        timeout: int = 1800,
        poll_interval: int = 5,
    ) -> Tuple[Optional[str], Optional[str]]:
        """Wait for a subtask to complete and return its result."""
        elapsed = 0
        logger.info(
            f"[_wait_for_subtask_completion] Starting to wait for subtask {assistant_subtask_id}, timeout={timeout}s"
        )

        # Commit any pending changes before starting polling
        # This ensures we can see updates from other sessions
        db.commit()

        while elapsed < timeout:
            # Expire all objects to get fresh data from database
            db.expire_all()

            assistant_subtask = (
                db.query(Subtask).filter(Subtask.id == assistant_subtask_id).first()
            )

            if not assistant_subtask:
                logger.error(
                    f"[_wait_for_subtask_completion] Subtask {assistant_subtask_id} not found"
                )
                return None, "Assistant subtask not found"

            status = assistant_subtask.status
            if elapsed % 30 == 0:  # Log every 30 seconds
                logger.info(
                    f"[_wait_for_subtask_completion] Subtask {assistant_subtask_id} status: {status}, elapsed: {elapsed}s"
                )

            if status == SubtaskStatus.COMPLETED:
                logger.info(
                    f"[_wait_for_subtask_completion] Subtask {assistant_subtask_id} COMPLETED after {elapsed}s"
                )
                if assistant_subtask.result and isinstance(
                    assistant_subtask.result, dict
                ):
                    return assistant_subtask.result.get("value", ""), None
                return "", None

            elif status == SubtaskStatus.FAILED:
                logger.error(
                    f"[_wait_for_subtask_completion] Subtask {assistant_subtask_id} FAILED after {elapsed}s"
                )
                error = "AI task failed"
                if assistant_subtask.result and isinstance(
                    assistant_subtask.result, dict
                ):
                    error = assistant_subtask.result.get("error", error)
                return None, error

            await asyncio.sleep(poll_interval)
            elapsed += poll_interval

        logger.error(
            f"[_wait_for_subtask_completion] Subtask {assistant_subtask_id} TIMEOUT after {timeout}s"
        )
        return None, f"Timeout after {timeout} seconds"

    async def _update_task_failed(
        self, db: Session, grading_task_id: int, error_message: str
    ) -> None:
        """Update grading task status to failed."""
        try:
            task = (
                db.query(EvalGradingTask)
                .filter(EvalGradingTask.id == grading_task_id)
                .first()
            )
            if task:
                task.status = GradingTaskStatus.FAILED
                task.error_message = error_message[:500]
                task.completed_at = datetime.now()
                db.commit()
        except Exception as e:
            logger.exception(
                f"[GradingStrategy] Failed to update grading task status: {e}"
            )

    def _update_task_running(
        self, db: Session, task: EvalGradingTask, grading_mode: str = "single"
    ) -> None:
        """Update task status to running."""
        task.status = GradingTaskStatus.RUNNING
        task.grading_mode = grading_mode
        task.started_at = datetime.now()
        task.attempt_count = task.attempt_count + 1
        db.commit()

    def _save_report_to_s3(
        self, db: Session, task: EvalGradingTask, content: str, is_draft: bool = True
    ) -> Optional[str]:
        """Save a report to S3."""
        from wecode.service.evaluation.question_service import QuestionService

        question_service = QuestionService()
        question = question_service.get(db, task.question_id)
        topic_id = question.topic_id if question else 0

        return self._storage_service.save_grading_report(
            respondent_id=task.respondent_id,
            topic_id=topic_id,
            question_id=task.question_id,
            content=content,
            is_draft=is_draft,
        )

    def _complete_task(
        self, db: Session, task: EvalGradingTask, report_content: str
    ) -> None:
        """Mark grading task as completed with AI report."""
        from sqlalchemy.orm.attributes import flag_modified

        s3_path = self._save_report_to_s3(db, task, report_content, is_draft=True)

        task.status = GradingTaskStatus.COMPLETED
        task.completed_at = datetime.now()

        report_data = dict(task.report_data) if task.report_data else {}
        report_data["ai_report"] = {
            "content": (
                report_content[:1000] + "..."
                if len(report_content) > 1000
                else report_content
            ),
            "s3_path": s3_path,
            "generated_at": datetime.now().isoformat(),
        }
        task.report_data = report_data
        flag_modified(task, "report_data")
        task.version = task.version + 1

        db.flush()
        db.commit()

        logger.info(f"[GradingStrategy] Completed grading task {task.id}")

    async def _trigger_ai_response(
        self,
        db: Session,
        wegent_task: "TaskResource",
        user_subtask: Subtask,
        assistant_subtask: Subtask,
        team: Kind,
        user: User,
        prompt: str,
    ) -> None:
        """Trigger AI response for a task.

        This method refreshes ORM objects, makes them transient (detached from session),
        and calls trigger_ai_response_unified to start AI processing.
        """
        from sqlalchemy.orm import make_transient

        from app.services.chat.trigger import trigger_ai_response_unified

        db.refresh(wegent_task)
        db.refresh(team)
        db.refresh(assistant_subtask)
        db.refresh(user)

        task_room = f"task:{wegent_task.id}"

        make_transient(wegent_task)
        make_transient(team)
        make_transient(assistant_subtask)
        make_transient(user)

        await trigger_ai_response_unified(
            task=wegent_task,
            assistant_subtask=assistant_subtask,
            team=team,
            user=user,
            message=prompt,
            payload=None,
            task_room=task_room,
            device_id=None,
            namespace=None,
            user_subtask_id=user_subtask.id,
            auth_token="",
        )
