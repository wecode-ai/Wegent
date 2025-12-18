# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging
from typing import List, Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session, load_only, subqueryload, undefer

from app.models.subtask import Subtask, SubtaskStatus
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
        """
        from app.services.task_member_service import task_member_service

        # Check if this is a group chat and user is a member
        is_member = task_member_service.is_member(db, task_id, user_id)

        # Phase 1: Get sorted subtask IDs without loading large columns
        # Only select columns needed for filtering and sorting
        if is_member:
            # For group chat members, return all subtasks
            subtask_ids_query = (
                db.query(Subtask.id)
                .filter(Subtask.task_id == task_id)
                .order_by(Subtask.message_id.asc(), Subtask.created_at.asc())
                .offset(skip)
                .limit(limit)
            )
        else:
            # For non-members, only return user's own subtasks
            subtask_ids_query = (
                db.query(Subtask.id)
                .filter(Subtask.task_id == task_id, Subtask.user_id == user_id)
                .order_by(Subtask.message_id.asc(), Subtask.created_at.asc())
                .offset(skip)
                .limit(limit)
            )

        subtask_ids = [row[0] for row in subtask_ids_query.all()]

        if not subtask_ids:
            return []

        # Phase 2: Load full subtask data for the selected IDs
        # Use subqueryload for attachments to avoid JOIN issues
        # Use undefer to explicitly load the deferred columns
        subtasks = (
            db.query(Subtask)
            .options(
                subqueryload(Subtask.attachments),
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
            if subtask.sender_user_id:
                sender_ids.add(subtask.sender_user_id)

        # Batch query users
        user_name_map = {}
        if sender_ids:
            users = db.query(User).filter(User.id.in_(sender_ids)).all()
            user_name_map = {user.id: user.user_name for user in users}

        # Set sender_user_name for each subtask
        for subtask in subtasks:
            if subtask.sender_user_id and subtask.sender_user_id in user_name_map:
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
            .filter(Subtask.id == subtask_id, Subtask.user_id == user_id)
            .first()
        )

        # If not found and user is a group chat member, allow access
        if not subtask:
            # Get the subtask to check its task_id
            subtask_check = db.query(Subtask).filter(Subtask.id == subtask_id).first()

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

        # Build query
        query = (
            db.query(Subtask, User.user_name.label("sender_username"))
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
                "attachments": [],  # Attachments not loaded in this query for performance
                "sender_user_name": sender_username,
                "reply_to_subtask_id": subtask.reply_to_subtask_id,
            }
            messages.append(message_dict)

        return messages


subtask_service = SubtaskService(Subtask)
