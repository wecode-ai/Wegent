# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging
from datetime import datetime
from typing import List, Optional, Tuple

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.schemas.subtask import SubtaskCreate, SubtaskUpdate
from app.services.base import BaseService
from app.stores.tasks import subtask_store, task_access_store
from app.utils.prompt_utils import extract_display_prompt

logger = logging.getLogger(__name__)


class SubtaskService(BaseService[Subtask, SubtaskCreate, SubtaskUpdate]):
    """
    Subtask service class
    """

    def create_subtask(
        self, db: Session, *, obj_in: SubtaskCreate, user_id: int
    ) -> Subtask:
        """
        Create user Subtask
        """
        db_obj = subtask_store.create_subtask(
            db,
            user_id=user_id,
            task_id=obj_in.task_id,
            team_id=obj_in.team_id,
            title=obj_in.title,
            bot_ids=obj_in.bot_ids,
            role=obj_in.role,
            prompt=obj_in.prompt,
            executor_namespace=obj_in.executor_namespace,
            executor_name=obj_in.executor_name,
            message_id=obj_in.message_id,
            parent_id=obj_in.parent_id,
            status=obj_in.status,
            progress=obj_in.progress,
            result=obj_in.result,
            error_message=obj_in.error_message,
        )
        db.commit()
        db.refresh(db_obj)
        return db_obj

    def get_user_subtasks(
        self, db: Session, *, user_id: int, skip: int = 0, limit: int = 100
    ) -> List[Subtask]:
        """
        Get user's Subtask list
        """
        return subtask_store.list_by_user(
            db,
            user_id=user_id,
            skip=skip,
            limit=limit,
        )

    def get_by_task(
        self,
        db: Session,
        *,
        task_id: int,
        user_id: int,
        skip: int = 0,
        limit: int = 100,
        from_latest: bool = False,
        before_message_id: Optional[int] = None,
    ) -> List[Subtask]:
        """
        Get subtasks by task ID, sorted by message_id.
        For group chats, returns all subtasks from all members.
        For regular tasks, returns only user's own subtasks.

        Uses a two-phase query approach to avoid MySQL "Out of sort memory" errors:

        Phase 1: Query only the IDs with sorting (no large columns)
        Phase 2: Load full subtask data for the selected IDs

        This avoids MySQL error 1038 which occurs when sorting result sets
        containing large TEXT/BLOB columns (prompt, result, error_message).

        Args:
            db: Database session
            task_id: Task ID
            user_id: User ID
            skip: Number of records to skip (for pagination)
            limit: Maximum number of records to return
            from_latest: If True, return the latest N messages (default for group chat)
            before_message_id: If provided, return messages before this message_id
                              (for loading older messages when scrolling up)
        """
        return subtask_store.list_by_task(
            db,
            task_id=task_id,
            user_id=user_id,
            access_store=task_access_store,
            skip=skip,
            limit=limit,
            from_latest=from_latest,
            before_message_id=before_message_id,
        )

    def get_subtask_by_id(
        self, db: Session, *, subtask_id: int, user_id: int
    ) -> Optional[Subtask]:
        """
        Get Subtask by ID and user ID.
        For group chat members, allows access to any subtask in the task.
        """
        subtask = subtask_store.get_accessible_by_id(
            db,
            subtask_id=subtask_id,
            user_id=user_id,
            access_store=task_access_store,
        )
        if not subtask:
            raise HTTPException(status_code=404, detail="Subtask not found")

        return subtask

    def update_subtask(
        self, db: Session, *, subtask_id: int, obj_in: SubtaskUpdate, user_id: int
    ) -> Subtask:
        """
        Update user Subtask
        """
        subtask = self.get_subtask_by_id(db, subtask_id=subtask_id, user_id=user_id)
        if not subtask:
            raise HTTPException(status_code=404, detail="Subtask not found")

        update_data = obj_in.model_dump(exclude_unset=True)

        subtask_store.update_fields(db, subtask=subtask, **update_data)
        db.commit()
        db.refresh(subtask)
        return subtask

    def delete_subtask(self, db: Session, *, subtask_id: int, user_id: int) -> None:
        """
        Delete user Subtask
        """
        subtask = self.get_subtask_by_id(db, subtask_id=subtask_id, user_id=user_id)
        if not subtask:
            raise HTTPException(status_code=404, detail="Subtask not found")

        subtask_store.delete(db, subtask=subtask)
        db.commit()

    def get_new_messages_since(
        self,
        db: Session,
        *,
        task_id: int,
        user_id: int,
        last_subtask_id: Optional[int] = None,
        since: Optional[str] = None,
    ) -> List[dict]:
        """
        Get new messages for a task since a given subtask ID or timestamp.
        Used for polling new messages in group chat.

        Args:
            db: Database session
            task_id: Task ID
            user_id: User ID
            last_subtask_id: Last subtask ID received by client
            since: ISO timestamp to filter messages after this time

        Returns:
            List of subtask dictionaries with sender information
        """
        # Check if user is a member of this task
        is_member = task_access_store.is_member(db, task_id=task_id, user_id=user_id)
        if not is_member:
            raise HTTPException(
                status_code=403, detail="Not authorized to access this task"
            )

        since_dt = None
        if since:
            try:
                since_dt = datetime.fromisoformat(since.replace("Z", "+00:00"))
            except ValueError:
                pass  # Ignore invalid timestamp

        subtasks = subtask_store.list_new_messages_since(
            db,
            task_id=task_id,
            last_subtask_id=last_subtask_id,
            since=since_dt,
        )

        # Convert to dict format
        messages = []
        for subtask in subtasks:
            # Serialize contexts using SubtaskContextBrief
            from app.schemas.subtask_context import SubtaskContextBrief as ContextBrief

            sender_username = getattr(subtask, "sender_user_name", None)
            contexts = []
            if hasattr(subtask, "contexts") and subtask.contexts:
                for ctx in subtask.contexts:
                    if hasattr(ctx, "model_dump"):
                        # Already a Pydantic model
                        contexts.append(ctx.model_dump(mode="json"))
                    else:
                        # ORM model, convert using from_model
                        brief = ContextBrief.from_model(ctx)
                        contexts.append(brief.model_dump(mode="json"))

            message_dict = {
                "id": subtask.id,
                "task_id": subtask.task_id,
                "team_id": subtask.team_id,
                "title": subtask.title,
                "bot_ids": subtask.bot_ids if subtask.bot_ids else [],
                "role": subtask.role.value if subtask.role else None,
                "prompt": extract_display_prompt(subtask.prompt),
                "executor_namespace": subtask.executor_namespace,
                "executor_name": subtask.executor_name,
                "message_id": subtask.message_id,
                "parent_id": subtask.parent_id,
                "status": subtask.status.value if subtask.status else None,
                "progress": subtask.progress,
                "result": subtask.result,
                "error_message": subtask.error_message,
                "sender_type": subtask.sender_type,  # Already a string value, not enum
                "sender_user_id": subtask.sender_user_id,
                "sender_username": sender_username,
                "created_at": (
                    subtask.created_at.isoformat() if subtask.created_at else None
                ),
                "updated_at": (
                    subtask.updated_at.isoformat() if subtask.updated_at else None
                ),
                "completed_at": (
                    subtask.completed_at.isoformat() if subtask.completed_at else None
                ),
                "user_id": subtask.user_id,
                "executor_deleted_at": subtask.executor_deleted_at,
                "contexts": contexts,  # Add contexts field
                "attachments": [],  # Deprecated: kept for backward compatibility
                "sender_user_name": sender_username,
                "reply_to_subtask_id": subtask.reply_to_subtask_id,
            }
            messages.append(message_dict)

        return messages

    def delete_subtasks_from(
        self,
        db: Session,
        *,
        task_id: int,
        from_message_id: int,
        user_id: int,
    ) -> int:
        """
        Delete all subtasks from the specified message_id onwards (inclusive, hard delete).

        This is used for message editing - when a user edits a message,
        the edited message and all subsequent messages are deleted,
        then the user can resend.

        Args:
            db: Database session
            task_id: Task ID
            from_message_id: Message ID threshold (messages with message_id >= this are deleted)
            user_id: User ID (for ownership verification)

        Returns:
            Number of deleted subtasks
        """
        deleted_count = subtask_store.delete_from_message_id(
            db,
            task_id=task_id,
            from_message_id=from_message_id,
        )
        db.commit()

        logger.info(
            f"Deleted {deleted_count} subtasks from message_id {from_message_id} for task {task_id}"
        )

        return deleted_count

    def delete_subtasks_after(
        self,
        db: Session,
        *,
        task_id: int,
        after_message_id: int,
        user_id: int,
    ) -> int:
        """
        Delete all subtasks after the specified message_id (hard delete).

        This is used for message editing - when a user edits a message,
        all subsequent messages (both user and AI) are deleted.

        Args:
            db: Database session
            task_id: Task ID
            after_message_id: Message ID threshold (messages with message_id > this are deleted)
            user_id: User ID (for ownership verification)

        Returns:
            Number of deleted subtasks
        """
        deleted_count = subtask_store.delete_after_message_id(
            db,
            task_id=task_id,
            after_message_id=after_message_id,
        )
        db.commit()

        logger.info(
            f"Deleted {deleted_count} subtasks after message_id {after_message_id} for task {task_id}"
        )

        return deleted_count

    def edit_user_message(
        self,
        db: Session,
        *,
        subtask_id: int,
        new_content: str,
        user_id: int,
    ) -> Tuple[int, int, int]:
        """
        Edit a user message by deleting it and all subsequent messages.

        This implements the ChatGPT-style edit functionality. The edited message
        and all messages after it are deleted. The frontend should then send
        a new message with the edited content to trigger AI response.

        Args:
            db: Database session
            subtask_id: The subtask ID of the message to edit
            new_content: New message content (used by frontend to resend)
            user_id: User ID (for ownership verification)

        Returns:
            Tuple of (subtask_id, message_id, deleted_count)

        Raises:
            HTTPException: If validation fails
        """
        # Get the subtask
        subtask = subtask_store.get_by_id(db, subtask_id=subtask_id)

        if not subtask or subtask.user_id != user_id:
            raise HTTPException(status_code=404, detail="Message not found")

        # Verify it's a user message (role == USER)
        if subtask.role != SubtaskRole.USER:
            raise HTTPException(
                status_code=400, detail="Only user messages can be edited"
            )

        # Check if task is a group chat (edit not supported in group chat)
        if task_access_store.is_group_chat(db, task_id=subtask.task_id):
            raise HTTPException(
                status_code=400, detail="Edit not supported in group chat"
            )

        # Check if there's an AI response currently being generated
        if subtask_store.has_running_assistant(db, task_id=subtask.task_id):
            raise HTTPException(
                status_code=400, detail="Cannot edit while AI is generating a response"
            )

        # Store message_id before deletion
        message_id = subtask.message_id
        task_id = subtask.task_id

        # Delete the edited message AND all subsequent messages
        # This allows frontend to send a fresh new message without duplicates
        deleted_count = self.delete_subtasks_from(
            db,
            task_id=task_id,
            from_message_id=message_id,
            user_id=user_id,
        )

        logger.info(
            f"User {user_id} deleted message {subtask_id} for editing, deleted {deleted_count} messages total"
        )

        return subtask_id, message_id, deleted_count


subtask_service = SubtaskService(Subtask)
