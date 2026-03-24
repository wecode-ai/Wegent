# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Base classes and shared utilities for evaluation grading service.

Architecture:
- GradingStrategy: Abstract base for grading execution strategies
- GradingService (in grading_service.py): Manages task lifecycle and orchestrates strategies

Key design principles:
1. Strategies only execute grading logic and return GradingResult
2. Strategies do NOT import or call GradingService (no circular dependency)
3. GradingService runs strategies in background threads and handles results
"""

import asyncio
import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.subtask import Subtask, SubtaskStatus
from app.models.subtask_context import ContextStatus, ContextType, SubtaskContext
from app.models.user import User
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


@dataclass
class GradingResult:
    """Result from grading strategy execution.

    Strategies return this to communicate outcome to GradingService.
    The service then handles state updates based on this result.
    """

    success: bool
    content: Optional[str] = None  # Report content if successful
    error_message: Optional[str] = None  # Error message if failed
    scorer_results: Optional[List[Dict]] = None  # For multi-model mode


class GradingStrategy(ABC):
    """Abstract base class for grading strategies.

    Strategies handle execution flow only and return GradingResult.
    State changes (complete, fail) are handled by GradingService based on the result.

    IMPORTANT: Strategies must NOT import or call GradingService methods.
    """

    def __init__(self):
        self._storage_service = EvalStorageService()

    @abstractmethod
    async def execute(self, ctx: GradingContext) -> GradingResult:
        """Execute the grading strategy and return result.

        Args:
            ctx: Grading context with task info and configuration

        Returns:
            GradingResult indicating success/failure and content
        """
        pass

    # ========== Shared utility methods for strategies ==========

    async def _copy_attachments_to_context(
        self,
        db: Session,
        subtask_id: int,
        user_id: int,
        attachments: List[AttachmentInfo],
    ) -> None:
        """Copy evaluation attachments to SubtaskContext records."""
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
        """Wait for a subtask to complete and return its result.

        Returns:
            Tuple of (content, error_message). On success, content is set.
            On failure, error_message is set.
        """
        elapsed = 0
        logger.info(
            f"[GradingStrategy] Waiting for subtask {assistant_subtask_id}, "
            f"timeout={timeout}s"
        )

        # Commit pending changes before polling to ensure visibility
        db.commit()

        while elapsed < timeout:
            # Expire all objects to get fresh data from database
            db.expire_all()

            assistant_subtask = (
                db.query(Subtask).filter(Subtask.id == assistant_subtask_id).first()
            )

            if not assistant_subtask:
                logger.error(
                    f"[GradingStrategy] Subtask {assistant_subtask_id} not found"
                )
                return None, "Assistant subtask not found"

            status = assistant_subtask.status
            if elapsed % 30 == 0:  # Log every 30 seconds
                logger.info(
                    f"[GradingStrategy] Subtask {assistant_subtask_id} "
                    f"status: {status}, elapsed: {elapsed}s"
                )

            if status == SubtaskStatus.COMPLETED:
                logger.info(
                    f"[GradingStrategy] Subtask {assistant_subtask_id} "
                    f"COMPLETED after {elapsed}s"
                )
                if assistant_subtask.result and isinstance(
                    assistant_subtask.result, dict
                ):
                    return assistant_subtask.result.get("value", ""), None
                return "", None

            elif status == SubtaskStatus.FAILED:
                logger.error(
                    f"[GradingStrategy] Subtask {assistant_subtask_id} "
                    f"FAILED after {elapsed}s"
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
            f"[GradingStrategy] Subtask {assistant_subtask_id} "
            f"TIMEOUT after {timeout}s"
        )
        return None, f"Timeout after {timeout} seconds"

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

    def _save_content_to_s3(
        self,
        respondent_id: int,
        topic_id: int,
        question_id: int,
        content: str,
        suffix: str = "",
    ) -> Optional[str]:
        """Save content to S3 and return the path.

        This is a utility method for strategies to save intermediate results
        (like scorer reports) without needing to access GradingService.

        Args:
            respondent_id: User ID of the respondent
            topic_id: Topic ID
            question_id: Question ID
            content: Content to save
            suffix: Optional suffix for the filename (e.g., "_scorer_1")

        Returns:
            S3 path if successful, None otherwise
        """
        return self._storage_service.save_grading_report(
            respondent_id=respondent_id,
            topic_id=topic_id,
            question_id=question_id,
            content=content,
            is_draft=True,
            suffix=suffix,
        )
