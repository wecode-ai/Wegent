# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging
from datetime import datetime
from typing import List, Optional, Tuple

from fastapi import HTTPException
from shared.models.db.subtask_context import SubtaskContext
from sqlalchemy.orm import Session, load_only, subqueryload, undefer

from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.schemas.subtask import SubtaskCreate, SubtaskUpdate
from app.services.base import BaseService

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
        db_obj = Subtask(
            user_id=user_id,
            task_id=obj_in.task_id,
            team_id=obj_in.team_id,
            title=obj_in.title,
            bot_id=obj_in.bot_id,
            executor_namespace=obj_in.executor_namespace,
            executor_name=obj_in.executor_name,
            message_id=obj_in.message_id,
            status=SubtaskStatus.PENDING,
        )
        db.add(db_obj)
        db.commit()
        db.refresh(db_obj)
        return db_obj

    def get_user_subtasks(
        self, db: Session, *, user_id: int, skip: int = 0, limit: int = 100
    ) -> List[Subtask]:
        """
        Get user's Subtask list
        """
        return (
            db.query(Subtask)
            .filter(Subtask.user_id == user_id)
            .order_by(Subtask.created_at.desc())
            .offset(skip)
            .limit(limit)
            .all()
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
        from app.services.task_member_service import task_member_service

        # Check if this is a group chat and user is a member
        is_member = task_member_service.is_member(db, task_id, user_id)

        # Phase 1: Get sorted subtask IDs without loading large columns
        # Only select columns needed for filtering and sorting
        if is_member:
            # For group chat members, return all subtasks
            base_query = db.query(Subtask.id).filter(Subtask.task_id == task_id)
        else:
            # For non-members, only return user's own subtasks
            base_query = db.query(Subtask.id).filter(
                Subtask.task_id == task_id, Subtask.user_id == user_id
            )

        # Apply before_message_id filter for loading older messages
        if before_message_id is not None:
            base_query = base_query.filter(Subtask.message_id < before_message_id)

        if from_latest:
            # Get the latest N messages by ordering DESC first, then reverse
            subtask_ids_query = (
                base_query.order_by(
                    Subtask.message_id.desc(), Subtask.created_at.desc()
                )
                .offset(skip)
                .limit(limit)
            )
            # Reverse to get ascending order for display
            subtask_ids = [row[0] for row in subtask_ids_query.all()][::-1]
        else:
            # Traditional pagination from the beginning
            subtask_ids_query = (
                base_query.order_by(Subtask.message_id.asc(), Subtask.created_at.asc())
                .offset(skip)
                .limit(limit)
            )
            subtask_ids = [row[0] for row in subtask_ids_query.all()]

        if not subtask_ids:
            return []

        # Phase 2: Load full subtask data for the selected IDs
        # Use subqueryload for contexts to avoid JOIN issues
        # Use undefer to explicitly load the deferred columns
        subtasks = (
            db.query(Subtask)
            .options(
                subqueryload(Subtask.contexts),
                undefer(Subtask.prompt),
                undefer(Subtask.result),
                undefer(Subtask.error_message),
            )
            .filter(Subtask.id.in_(subtask_ids))
            .all()
        )

        # Add sender_user_name for group chat messages
        # Query all unique sender_user_ids from subtasks
        from app.models.user import User

        sender_ids = set()
        for subtask in subtasks:
            if (
                subtask.sender_user_id and subtask.sender_user_id > 0
            ):  # Check > 0 instead of truthy
                sender_ids.add(subtask.sender_user_id)

        # Batch query users
        user_name_map = {}
        if sender_ids:
            users = db.query(User).filter(User.id.in_(sender_ids)).all()
            user_name_map = {user.id: user.user_name for user in users}

        # Set sender_user_name for each subtask
        for subtask in subtasks:
            if (
                subtask.sender_user_id
                and subtask.sender_user_id > 0
                and subtask.sender_user_id in user_name_map
            ):  # Check > 0
                subtask.sender_user_name = user_name_map[subtask.sender_user_id]

        # Restore the original order (IN clause doesn't preserve order)
        id_to_subtask = {s.id: s for s in subtasks}
        return [id_to_subtask[sid] for sid in subtask_ids if sid in id_to_subtask]

    def get_subtask_by_id(
        self, db: Session, *, subtask_id: int, user_id: int
    ) -> Optional[Subtask]:
        """
        Get Subtask by ID and user ID.
        For group chat members, allows access to any subtask in the task.
        """
        from app.services.task_member_service import task_member_service

        # First try to find subtask owned by user
        subtask = (
            db.query(Subtask)
            .options(subqueryload(Subtask.contexts))
            .filter(Subtask.id == subtask_id, Subtask.user_id == user_id)
            .first()
        )

        # If not found and user is a group chat member, allow access
        if not subtask:
            # Get the subtask to check its task_id
            subtask_check = (
                db.query(Subtask)
                .options(subqueryload(Subtask.contexts))
                .filter(Subtask.id == subtask_id)
                .first()
            )

            if subtask_check:
                # Check if user is a member of this task's group chat
                is_member = task_member_service.is_member(
                    db, subtask_check.task_id, user_id
                )
                if is_member:
                    subtask = subtask_check

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

        for field, value in update_data.items():
            setattr(subtask, field, value)

        db.add(subtask)
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

        db.delete(subtask)
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
        from app.models.user import User
        from app.services.task_member_service import task_member_service

        # Check if user is a member of this task
        is_member = task_member_service.is_member(db, task_id, user_id)
        if not is_member:
            raise HTTPException(
                status_code=403, detail="Not authorized to access this task"
            )

        # Build query with contexts
        from sqlalchemy.orm import subqueryload

        query = (
            db.query(Subtask, User.user_name.label("sender_username"))
            .options(subqueryload(Subtask.contexts))
            .outerjoin(User, Subtask.sender_user_id == User.id)
            .filter(Subtask.task_id == task_id)
        )

        # Apply filters
        if last_subtask_id:
            query = query.filter(Subtask.id > last_subtask_id)

        if since:
            from datetime import datetime

            try:
                since_dt = datetime.fromisoformat(since.replace("Z", "+00:00"))
                query = query.filter(Subtask.created_at > since_dt)
            except ValueError:
                pass  # Ignore invalid timestamp

        # Order by message_id and created_at
        query = query.order_by(Subtask.message_id.asc(), Subtask.created_at.asc())

        # Execute query
        results = query.all()

        # Convert to dict format
        messages = []
        for subtask, sender_username in results:
            # Serialize contexts using SubtaskContextBrief
            from app.schemas.subtask_context import SubtaskContextBrief as ContextBrief

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
                "prompt": subtask.prompt,
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
        # Get all subtasks to delete (message_id >= from_message_id)
        subtasks_to_delete = (
            db.query(Subtask)
            .filter(
                Subtask.task_id == task_id,
                Subtask.message_id >= from_message_id,
            )
            .all()
        )

        if not subtasks_to_delete:
            return 0

        deleted_count = len(subtasks_to_delete)
        subtask_ids_to_delete = [s.id for s in subtasks_to_delete]

        # Delete associated SubtaskContexts first
        db.query(SubtaskContext).filter(
            SubtaskContext.subtask_id.in_(subtask_ids_to_delete)
        ).delete(synchronize_session="fetch")

        # Delete the subtasks
        for subtask in subtasks_to_delete:
            db.delete(subtask)

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
        # Get all subtasks to delete (message_id > after_message_id)
        subtasks_to_delete = (
            db.query(Subtask)
            .filter(
                Subtask.task_id == task_id,
                Subtask.message_id > after_message_id,
            )
            .all()
        )

        if not subtasks_to_delete:
            return 0

        deleted_count = len(subtasks_to_delete)
        subtask_ids_to_delete = [s.id for s in subtasks_to_delete]

        # Delete associated SubtaskContexts first
        db.query(SubtaskContext).filter(
            SubtaskContext.subtask_id.in_(subtask_ids_to_delete)
        ).delete(synchronize_session="fetch")

        # Delete the subtasks
        for subtask in subtasks_to_delete:
            db.delete(subtask)

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
        from app.models.task import TaskResource as Task
        from app.services.task_member_service import task_member_service

        # Get the subtask
        subtask = (
            db.query(Subtask)
            .filter(Subtask.id == subtask_id, Subtask.user_id == user_id)
            .first()
        )

        if not subtask:
            raise HTTPException(status_code=404, detail="Message not found")

        # Verify it's a user message (role == USER)
        if subtask.role != SubtaskRole.USER:
            raise HTTPException(
                status_code=400, detail="Only user messages can be edited"
            )

        # Check if task is a group chat (edit not supported in group chat)
        task = db.query(Task).filter(Task.id == subtask.task_id).first()
        if task and task.json:
            task_spec = task.json.get("spec", {})
            if task_spec.get("is_group_chat", False):
                raise HTTPException(
                    status_code=400, detail="Edit not supported in group chat"
                )

        # Check if there's an AI response currently being generated
        running_assistant = (
            db.query(Subtask)
            .filter(
                Subtask.task_id == subtask.task_id,
                Subtask.role == SubtaskRole.ASSISTANT,
                Subtask.status.in_([SubtaskStatus.PENDING, SubtaskStatus.RUNNING]),
            )
            .first()
        )
        if running_assistant:
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
