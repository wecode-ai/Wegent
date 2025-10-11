# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import List, Optional, Set
from datetime import datetime, timedelta
import asyncio
import logging

from fastapi import HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import and_

from app.models.subtask import Subtask, SubtaskStatus
from app.models.task import Task, TaskStatus
from app.schemas.subtask import SubtaskCreate, SubtaskUpdate
from app.services.base import BaseService
from app.services.executor import executor_service
from app.core.config import settings

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
            status=SubtaskStatus.PENDING
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
        return db.query(Subtask).filter(
            Subtask.user_id == user_id
        ).order_by(Subtask.created_at.desc()).offset(skip).limit(limit).all()

    def get_by_task(
        self, db: Session, *, task_id: int, user_id: int, skip: int = 0, limit: int = 100
    ) -> List[Subtask]:
        """
        Get subtasks by task ID, sorted by message_id
        """
        return db.query(Subtask).filter(
            Subtask.task_id == task_id,
            Subtask.user_id == user_id
        ).order_by(Subtask.message_id.asc(), Subtask.created_at.asc()).offset(skip).limit(limit).all()

    def get_subtask_by_id(
        self, db: Session, *, subtask_id: int, user_id: int
    ) -> Optional[Subtask]:
        """
        Get Subtask by ID and user ID
        """
        subtask = db.query(Subtask).filter(
            Subtask.id == subtask_id,
            Subtask.user_id == user_id
        ).first()
        if not subtask:
            raise HTTPException(
                status_code=404,
                detail="Subtask not found"
            )
        return subtask

    def update_subtask(
        self, db: Session, *, subtask_id: int, obj_in: SubtaskUpdate, user_id: int
    ) -> Subtask:
        """
        Update user Subtask
        """
        subtask = self.get_subtask_by_id(db, subtask_id=subtask_id, user_id=user_id)
        if not subtask:
            raise HTTPException(
                status_code=404,
                detail="Subtask not found"
            )
        
        update_data = obj_in.model_dump(exclude_unset=True)
        
        for field, value in update_data.items():
            setattr(subtask, field, value)
        
        db.add(subtask)
        db.commit()
        db.refresh(subtask)
        return subtask

    def delete_subtask(
        self, db: Session, *, subtask_id: int, user_id: int
    ) -> None:
        """
        Delete user Subtask
        """
        subtask = self.get_subtask_by_id(db, subtask_id=subtask_id, user_id=user_id)
        if not subtask:
            raise HTTPException(
                status_code=404,
                detail="Subtask not found"
            )
        
        db.delete(subtask)
        db.commit()

    def cleanup_stale_executors(self, db: Session) -> None:
        """
        Scan subtasks and delete executor tasks if:
        - subtask.status in (COMPLETED, FAILED, CANCELLED)
        - corresponding task.status in (COMPLETED, FAILED, CANCELLED)
        - executor_name and executor_namespace are both non-empty
        - updated_at older than SUBTASK_EXECUTOR_DELETE_AFTER_HOURS
        Deduplicate by (executor_namespace, executor_name).
        After successful deletion, set executor_deleted_at.
        """
        try:
            cutoff = datetime.utcnow() - timedelta(hours=settings.SUBTASK_EXECUTOR_DELETE_AFTER_HOURS)
            logging.info("Start cleaning up expired executor,cutoff:{}".format(cutoff))
            # Query candidates (exclude already marked deleted-at)
            # Also check that the corresponding task status is COMPLETED, FAILED, or CANCELLED
            candidates: List[Subtask] = db.query(Subtask).join(Task, Subtask.task_id == Task.id).filter(
                and_(
                    Subtask.status.in_([SubtaskStatus.COMPLETED, SubtaskStatus.FAILED, SubtaskStatus.CANCELLED]),
                    Subtask.updated_at <= cutoff,
                    Task.status.in_([TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED]),
                    Subtask.executor_name.isnot(None),
                    Subtask.executor_name != "",
                    Subtask.executor_namespace.isnot(None),
                    Subtask.executor_namespace != "",
                    Subtask.updated_at <= cutoff,
                    Subtask.executor_deleted_at.is_(None)
                )
            ).all()

            if not candidates:
                logger.info("No executor to clean up")
                return

            # Deduplicate by (namespace, name)
            unique_executor_keys: Set[tuple[str, str]] = set()
            for s in candidates:
                if s.executor_namespace and s.executor_name:
                    unique_executor_keys.add((s.executor_namespace, s.executor_name))

            if not unique_executor_keys:
                return

            # Create and run a temporary event loop to call async deletion similar to TaskService.delete_task
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                async def delete_all():
                    results = []
                    for ns, name in unique_executor_keys:
                        ok = False
                        try:
                            logger.info(f"Deleting executor task ns={ns} name={name}")
                            res = await executor_service.delete_executor_task(name, ns)
                            ok = True
                            results.append(((ns, name), True, res))
                        except Exception as e:
                            # Log but continue
                            logger.warning(f"Failed to delete executor task ns={ns} name={name}: {e}")
                            results.append(((ns, name), False, str(e)))
                        # Mark all subtasks with this (namespace, name) accordingly
                        now = datetime.utcnow()
                        if ok:
                            db.query(Subtask).filter(
                                Subtask.executor_namespace == ns,
                                Subtask.executor_name == name,
                                Subtask.executor_deleted_at.is_(None)
                            ).update({
                                Subtask.executor_deleted_at: now,
                            })
                            db.commit()
                    return results

                loop.run_until_complete(delete_all())
            finally:
                loop.close()
        except Exception as e:
            logger.error(f"cleanup_stale_executors error: {e}")


subtask_service = SubtaskService(Subtask)