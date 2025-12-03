# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging
from typing import List, Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session, joinedload

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
        Eagerly loads attachments relationship.
        """
        return (
            db.query(Subtask)
            .options(joinedload(Subtask.attachments))
            .filter(Subtask.task_id == task_id, Subtask.user_id == user_id)
            .order_by(Subtask.message_id.asc(), Subtask.created_at.asc())
            .offset(skip)
            .limit(limit)
            .all()
        )

    def get_subtask_by_id(
        self, db: Session, *, subtask_id: int, user_id: int
    ) -> Optional[Subtask]:
        """
        Get Subtask by ID and user ID
        """
        subtask = (
            db.query(Subtask)
            .filter(Subtask.id == subtask_id, Subtask.user_id == user_id)
            .first()
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


subtask_service = SubtaskService(Subtask)
