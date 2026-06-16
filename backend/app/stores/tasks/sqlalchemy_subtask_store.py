# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from typing import Any, Literal, Optional, Sequence

from sqlalchemy import String, cast, func, or_, select
from sqlalchemy.orm import Session, subqueryload, undefer
from sqlalchemy.orm.attributes import flag_modified

from app.models.subtask import SenderType, Subtask, SubtaskRole, SubtaskStatus
from app.models.subtask_context import SubtaskContext
from app.models.task import TaskResource
from app.models.user import User
from app.stores.tasks.interfaces import TaskAccessStore
from shared.models.db.enums import ContextType


class SqlAlchemySubtaskStore:
    """SQLAlchemy implementation for subtask message access."""

    def _filter_owner_user_id(
        self,
        query,
        *,
        owner_user_id: Optional[int],
    ):
        if owner_user_id is None:
            return query
        return query.filter(
            Subtask.task_id.in_(self._owner_task_id_select(owner_user_id=owner_user_id))
        )

    def _owner_task_id_select(self, *, owner_user_id: int):
        return select(TaskResource.id).where(TaskResource.user_id == owner_user_id)

    def create_user_subtask(
        self,
        db: Session,
        *,
        user_id: int,
        task_id: int,
        team_id: int,
        title: str,
        bot_ids: list[int],
        prompt: str,
        message_id: int,
        parent_id: int,
        sender_user_id: int = 0,
        result: Optional[dict[str, Any]] = None,
        progress: int = 100,
    ) -> Subtask:
        subtask = Subtask(
            user_id=user_id,
            task_id=task_id,
            team_id=team_id,
            title=title,
            bot_ids=bot_ids,
            role=SubtaskRole.USER,
            executor_namespace="",
            executor_name="",
            prompt=prompt,
            status=SubtaskStatus.COMPLETED,
            progress=progress,
            message_id=message_id,
            parent_id=parent_id,
            error_message="",
            completed_at=datetime.now(),
            result=result,
            sender_type=SenderType.USER,
            sender_user_id=sender_user_id,
        )
        db.add(subtask)
        return subtask

    def create_assistant_subtask(
        self,
        db: Session,
        *,
        user_id: int,
        task_id: int,
        team_id: int,
        title: str,
        bot_ids: list[int],
        message_id: int,
        parent_id: int,
    ) -> Subtask:
        executor_namespace = ""
        executor_name = ""
        executor_deleted_at = False
        previous = (
            db.query(
                Subtask.executor_namespace,
                Subtask.executor_name,
                Subtask.executor_deleted_at,
            )
            .filter(
                Subtask.task_id == task_id,
                Subtask.role == SubtaskRole.ASSISTANT,
                Subtask.executor_name != "",
                Subtask.executor_name.isnot(None),
            )
            .order_by(Subtask.id.desc())
            .first()
        )
        if previous:
            executor_namespace = previous.executor_namespace or ""
            executor_name = previous.executor_name or ""
            executor_deleted_at = bool(previous.executor_deleted_at)

        subtask = Subtask(
            user_id=user_id,
            task_id=task_id,
            team_id=team_id,
            title=title,
            bot_ids=bot_ids,
            role=SubtaskRole.ASSISTANT,
            executor_namespace=executor_namespace,
            executor_name=executor_name,
            executor_deleted_at=executor_deleted_at,
            prompt="",
            status=SubtaskStatus.PENDING,
            progress=0,
            message_id=message_id,
            parent_id=parent_id,
            error_message="",
            result=None,
            completed_at=datetime.now(),
            sender_type=SenderType.TEAM,
            sender_user_id=0,
        )
        db.add(subtask)
        return subtask

    def create_subtask(
        self,
        db: Session,
        *,
        user_id: int,
        task_id: int,
        team_id: int,
        title: str,
        bot_ids: list[int],
        role: SubtaskRole,
        prompt: Optional[str],
        executor_namespace: Optional[str],
        executor_name: Optional[str],
        message_id: int,
        parent_id: Optional[int],
        status: SubtaskStatus,
        progress: int,
        result: Optional[dict[str, Any]],
        error_message: Optional[str],
    ) -> Subtask:
        subtask = Subtask(
            user_id=user_id,
            task_id=task_id,
            team_id=team_id,
            title=title,
            bot_ids=bot_ids,
            role=role,
            prompt=prompt,
            executor_namespace=executor_namespace,
            executor_name=executor_name,
            message_id=message_id,
            parent_id=parent_id,
            status=status,
            progress=progress,
            result=result,
            error_message=error_message,
            completed_at=datetime.now(),
        )
        db.add(subtask)
        return subtask

    def get_by_id(
        self, db: Session, *, subtask_id: int, owner_user_id: Optional[int] = None
    ) -> Optional[Subtask]:
        query = (
            db.query(Subtask)
            .options(subqueryload(Subtask.contexts))
            .filter(Subtask.id == subtask_id)
        )
        query = self._filter_owner_user_id(query, owner_user_id=owner_user_id)
        return query.first()

    def get_basic_by_id(
        self, db: Session, *, subtask_id: int, owner_user_id: Optional[int] = None
    ) -> Optional[Subtask]:
        query = db.query(Subtask).filter(Subtask.id == subtask_id)
        query = self._filter_owner_user_id(query, owner_user_id=owner_user_id)
        return query.first()

    def get_by_id_and_role(
        self,
        db: Session,
        *,
        subtask_id: int,
        role: SubtaskRole,
        owner_user_id: Optional[int] = None,
    ) -> Optional[Subtask]:
        query = db.query(Subtask).filter(Subtask.id == subtask_id, Subtask.role == role)
        query = self._filter_owner_user_id(query, owner_user_id=owner_user_id)
        return query.first()

    def get_accessible_by_id(
        self,
        db: Session,
        *,
        subtask_id: int,
        user_id: int,
        access_store: TaskAccessStore,
    ) -> Optional[Subtask]:
        subtask = (
            db.query(Subtask)
            .options(subqueryload(Subtask.contexts))
            .filter(Subtask.id == subtask_id, Subtask.user_id == user_id)
            .first()
        )
        if subtask is not None:
            return subtask

        subtask = self.get_by_id(db, subtask_id=subtask_id)
        if subtask is None:
            return None
        if access_store.is_member(db, task_id=subtask.task_id, user_id=user_id):
            return subtask
        return None

    def list_by_task(
        self,
        db: Session,
        *,
        task_id: int,
        user_id: int,
        access_store: TaskAccessStore,
        skip: int = 0,
        limit: int = 100,
        from_latest: bool = False,
        before_message_id: Optional[int] = None,
    ) -> list[Subtask]:
        base_query = db.query(Subtask.id).filter(Subtask.task_id == task_id)
        if not access_store.is_member(db, task_id=task_id, user_id=user_id):
            base_query = base_query.filter(Subtask.user_id == user_id)
        if before_message_id is not None:
            base_query = base_query.filter(Subtask.message_id < before_message_id)

        if from_latest:
            rows = (
                base_query.order_by(
                    Subtask.message_id.desc(),
                    Subtask.created_at.desc(),
                )
                .offset(skip)
                .limit(limit)
                .all()
            )
            subtask_ids = [row[0] for row in rows][::-1]
        else:
            rows = (
                base_query.order_by(
                    Subtask.message_id.asc(),
                    Subtask.created_at.asc(),
                )
                .offset(skip)
                .limit(limit)
                .all()
            )
            subtask_ids = [row[0] for row in rows]

        subtasks = self._load_ordered(db, subtask_ids)
        self._attach_sender_user_names(db, subtasks)
        return subtasks

    def count_by_task_for_user(
        self,
        db: Session,
        *,
        task_id: int,
        user_id: int,
        access_store: TaskAccessStore,
    ) -> int:
        query = db.query(Subtask).filter(Subtask.task_id == task_id)
        if not access_store.is_member(db, task_id=task_id, user_id=user_id):
            query = query.filter(Subtask.user_id == user_id)
        return query.count()

    def list_by_user(
        self, db: Session, *, user_id: int, skip: int = 0, limit: int = 100
    ) -> list[Subtask]:
        return (
            db.query(Subtask)
            .filter(Subtask.user_id == user_id)
            .order_by(Subtask.id.desc())
            .offset(skip)
            .limit(limit)
            .all()
        )

    def list_latest_by_task(
        self, db: Session, *, task_id: int, user_id: int, limit: int = 100
    ) -> list[Subtask]:
        rows = (
            db.query(Subtask.id)
            .filter(Subtask.task_id == task_id, Subtask.user_id == user_id)
            .order_by(Subtask.message_id.desc(), Subtask.created_at.desc())
            .limit(limit)
            .all()
        )
        return self._load_ordered(db, [row[0] for row in rows][::-1])

    def list_new_messages_since(
        self,
        db: Session,
        *,
        task_id: int,
        owner_user_id: Optional[int] = None,
        last_subtask_id: Optional[int] = None,
        since: Optional[datetime] = None,
    ) -> list[Subtask]:
        query = (
            db.query(Subtask)
            .options(subqueryload(Subtask.contexts))
            .filter(Subtask.task_id == task_id)
        )
        query = self._filter_owner_user_id(query, owner_user_id=owner_user_id)
        if last_subtask_id:
            query = query.filter(Subtask.id > last_subtask_id)
        if since:
            query = query.filter(Subtask.created_at > since)

        subtasks = query.order_by(
            Subtask.message_id.asc(), Subtask.created_at.asc()
        ).all()
        self._attach_sender_user_names(db, subtasks)
        return subtasks

    def get_latest_for_user(
        self, db: Session, *, task_id: int, user_id: int
    ) -> Optional[Subtask]:
        return (
            db.query(Subtask)
            .filter(Subtask.task_id == task_id, Subtask.user_id == user_id)
            .order_by(Subtask.message_id.desc(), Subtask.created_at.desc())
            .first()
        )

    def get_first_by_task(
        self, db: Session, *, task_id: int, owner_user_id: Optional[int] = None
    ) -> Optional[Subtask]:
        query = db.query(Subtask).filter(Subtask.task_id == task_id)
        query = self._filter_owner_user_id(query, owner_user_id=owner_user_id)
        return query.order_by(Subtask.id.asc()).first()

    def get_next_message_id(
        self, db: Session, *, task_id: int, owner_user_id: Optional[int] = None
    ) -> int:
        query = db.query(func.max(Subtask.message_id)).filter(
            Subtask.task_id == task_id
        )
        query = self._filter_owner_user_id(query, owner_user_id=owner_user_id)
        max_message_id = query.scalar()
        return int(max_message_id or 0) + 1

    def get_running_assistant_for_user(
        self, db: Session, *, task_id: int, user_id: int
    ) -> Optional[Subtask]:
        return (
            db.query(Subtask)
            .filter(
                Subtask.task_id == task_id,
                Subtask.user_id == user_id,
                Subtask.role == SubtaskRole.ASSISTANT,
                Subtask.status == SubtaskStatus.RUNNING,
            )
            .first()
        )

    def get_latest_assistant_for_user_by_statuses(
        self,
        db: Session,
        *,
        task_id: int,
        user_id: int,
        statuses: Sequence[SubtaskStatus],
    ) -> Optional[Subtask]:
        if not statuses:
            return None
        return (
            db.query(Subtask)
            .filter(
                Subtask.task_id == task_id,
                Subtask.user_id == user_id,
                Subtask.role == SubtaskRole.ASSISTANT,
                Subtask.status.in_(statuses),
            )
            .order_by(Subtask.id.desc())
            .first()
        )

    def get_latest_assistant_by_statuses(
        self,
        db: Session,
        *,
        task_id: int,
        statuses: Sequence[SubtaskStatus],
        owner_user_id: Optional[int] = None,
    ) -> Optional[Subtask]:
        if not statuses:
            return None
        query = db.query(Subtask).filter(
            Subtask.task_id == task_id,
            Subtask.role == SubtaskRole.ASSISTANT,
            Subtask.status.in_(statuses),
        )
        query = self._filter_owner_user_id(query, owner_user_id=owner_user_id)
        return query.order_by(Subtask.message_id.desc(), Subtask.id.desc()).first()

    def get_latest_running_assistant_by_task(
        self, db: Session, *, task_id: int, owner_user_id: Optional[int] = None
    ) -> Optional[Subtask]:
        query = db.query(Subtask).filter(
            Subtask.task_id == task_id,
            Subtask.role == SubtaskRole.ASSISTANT,
            Subtask.status == SubtaskStatus.RUNNING,
        )
        query = self._filter_owner_user_id(query, owner_user_id=owner_user_id)
        return query.order_by(Subtask.id.desc()).first()

    def list_by_task_unfiltered(
        self, db: Session, *, task_id: int, owner_user_id: Optional[int] = None
    ) -> list[Subtask]:
        query = db.query(Subtask).filter(Subtask.task_id == task_id)
        query = self._filter_owner_user_id(query, owner_user_id=owner_user_id)
        return query.all()

    def list_by_task_desc(
        self, db: Session, *, task_id: int, owner_user_id: Optional[int] = None
    ) -> list[Subtask]:
        query = db.query(Subtask).filter(Subtask.task_id == task_id)
        query = self._filter_owner_user_id(query, owner_user_id=owner_user_id)
        return query.order_by(Subtask.message_id.desc(), Subtask.id.desc()).all()

    def list_completed_before_message_id(
        self,
        db: Session,
        *,
        task_id: int,
        before_message_id: int,
        owner_user_id: Optional[int] = None,
    ) -> list[Subtask]:
        query = db.query(Subtask).filter(
            Subtask.task_id == task_id,
            Subtask.message_id < before_message_id,
            Subtask.status == SubtaskStatus.COMPLETED,
        )
        query = self._filter_owner_user_id(query, owner_user_id=owner_user_id)
        return query.order_by(Subtask.message_id.asc()).all()

    def get_retry_assistant(
        self,
        db: Session,
        *,
        task_id: int,
        subtask_id: int,
        owner_user_id: Optional[int] = None,
    ) -> Optional[Subtask]:
        query = db.query(Subtask).filter(
            Subtask.id == subtask_id,
            Subtask.task_id == task_id,
            Subtask.role == SubtaskRole.ASSISTANT,
        )
        query = self._filter_owner_user_id(query, owner_user_id=owner_user_id)
        return query.first()

    def get_user_by_task_message_id(
        self,
        db: Session,
        *,
        task_id: int,
        message_id: int,
        owner_user_id: Optional[int] = None,
    ) -> Optional[Subtask]:
        query = (
            db.query(Subtask)
            .options(subqueryload(Subtask.contexts))
            .filter(
                Subtask.task_id == task_id,
                Subtask.message_id == message_id,
                Subtask.role == SubtaskRole.USER,
            )
        )
        query = self._filter_owner_user_id(query, owner_user_id=owner_user_id)
        return query.first()

    def get_first_user_before_message_id(
        self,
        db: Session,
        *,
        task_id: int,
        before_message_id: int,
        owner_user_id: Optional[int] = None,
    ) -> Optional[Subtask]:
        query = db.query(Subtask).filter(
            Subtask.task_id == task_id,
            Subtask.role == SubtaskRole.USER,
            Subtask.message_id < before_message_id,
        )
        query = self._filter_owner_user_id(query, owner_user_id=owner_user_id)
        return query.order_by(Subtask.message_id.asc(), Subtask.id.asc()).first()

    def get_by_task_message_id_and_role(
        self,
        db: Session,
        *,
        task_id: int,
        message_id: int,
        role: SubtaskRole,
        owner_user_id: Optional[int] = None,
    ) -> Optional[Subtask]:
        query = db.query(Subtask).filter(
            Subtask.task_id == task_id,
            Subtask.message_id == message_id,
            Subtask.role == role,
        )
        query = self._filter_owner_user_id(query, owner_user_id=owner_user_id)
        return query.first()

    def get_by_task_parent_id_and_role(
        self,
        db: Session,
        *,
        task_id: int,
        parent_id: int,
        role: SubtaskRole,
        owner_user_id: Optional[int] = None,
    ) -> Optional[Subtask]:
        query = db.query(Subtask).filter(
            Subtask.task_id == task_id,
            Subtask.parent_id == parent_id,
            Subtask.role == role,
        )
        query = self._filter_owner_user_id(query, owner_user_id=owner_user_id)
        return query.first()

    def list_assistant_by_task(
        self, db: Session, *, task_id: int, owner_user_id: Optional[int] = None
    ) -> list[Subtask]:
        query = db.query(Subtask).filter(
            Subtask.task_id == task_id,
            Subtask.role == SubtaskRole.ASSISTANT,
        )
        query = self._filter_owner_user_id(query, owner_user_id=owner_user_id)
        return query.order_by(Subtask.message_id.asc()).all()

    def list_after_message_id(
        self,
        db: Session,
        *,
        task_id: int,
        after_message_id: int,
        owner_user_id: Optional[int] = None,
    ) -> list[Subtask]:
        query = db.query(Subtask).filter(
            Subtask.task_id == task_id,
            Subtask.message_id > after_message_id,
        )
        query = self._filter_owner_user_id(query, owner_user_id=owner_user_id)
        subtasks = query.order_by(Subtask.message_id.asc()).all()
        self._attach_sender_user_names(db, subtasks)
        return subtasks

    def get_latest_by_task(
        self, db: Session, *, task_id: int, owner_user_id: Optional[int] = None
    ) -> Optional[Subtask]:
        query = db.query(Subtask).filter(Subtask.task_id == task_id)
        query = self._filter_owner_user_id(query, owner_user_id=owner_user_id)
        return query.order_by(
            Subtask.message_id.desc(), Subtask.created_at.desc()
        ).first()

    def list_by_task_ordered(
        self,
        db: Session,
        *,
        task_id: int,
        message_ids: Optional[Sequence[int]] = None,
        exclude_subtask_ids: Optional[Sequence[int]] = None,
        exclude_deleted: bool = False,
        order_by: Literal["id", "message_id", "created_at"] = "message_id",
        owner_user_id: Optional[int] = None,
    ) -> list[Subtask]:
        query = db.query(Subtask).filter(Subtask.task_id == task_id)
        query = self._filter_owner_user_id(query, owner_user_id=owner_user_id)
        if message_ids is not None:
            if not message_ids:
                return []
            query = query.filter(Subtask.message_id.in_(message_ids))
        if exclude_subtask_ids:
            query = query.filter(Subtask.id.notin_(exclude_subtask_ids))
        if exclude_deleted:
            query = query.filter(Subtask.status != SubtaskStatus.DELETE)
        if order_by == "id":
            return query.order_by(Subtask.id.asc()).all()
        if order_by == "created_at":
            return query.order_by(Subtask.created_at.asc(), Subtask.id.asc()).all()
        return query.order_by(Subtask.message_id.asc(), Subtask.created_at.asc()).all()

    def list_recent_by_task_ids(
        self,
        db: Session,
        *,
        task_ids: Sequence[int],
        limit: int,
        owner_user_id: Optional[int] = None,
    ) -> list[Subtask]:
        if not task_ids:
            return []
        query = db.query(Subtask).filter(Subtask.task_id.in_(task_ids))
        query = self._filter_owner_user_id(query, owner_user_id=owner_user_id)
        return query.order_by(Subtask.updated_at.desc()).limit(limit).all()

    def search_task_ids_by_content(
        self,
        db: Session,
        *,
        task_ids: Sequence[int],
        keyword: str,
        owner_user_id: Optional[int] = None,
    ) -> set[int]:
        if not task_ids:
            return set()
        like_pattern = f"%{keyword}%"
        query = (
            db.query(Subtask.task_id)
            .filter(Subtask.task_id.in_(task_ids))
            .filter(
                or_(
                    Subtask.prompt.ilike(like_pattern),
                    Subtask.error_message.ilike(like_pattern),
                    cast(Subtask.result, String).ilike(like_pattern),
                )
            )
        )
        query = self._filter_owner_user_id(query, owner_user_id=owner_user_id)
        rows = query.distinct().all()
        return {int(row[0]) for row in rows}

    def list_by_task_for_user_ordered(
        self,
        db: Session,
        *,
        task_id: int,
        user_id: int,
    ) -> list[Subtask]:
        return (
            db.query(Subtask)
            .filter(Subtask.task_id == task_id, Subtask.user_id == user_id)
            .order_by(Subtask.message_id.asc())
            .all()
        )

    def list_by_task_status(
        self,
        db: Session,
        *,
        task_id: int,
        status: SubtaskStatus,
        owner_user_id: Optional[int] = None,
    ) -> list[Subtask]:
        query = db.query(Subtask).filter(
            Subtask.task_id == task_id,
            Subtask.status == status,
        )
        query = self._filter_owner_user_id(query, owner_user_id=owner_user_id)
        return query.all()

    def list_by_task_statuses(
        self,
        db: Session,
        *,
        task_id: int,
        statuses: Sequence[SubtaskStatus],
        owner_user_id: Optional[int] = None,
    ) -> list[Subtask]:
        if not statuses:
            return []
        query = db.query(Subtask).filter(
            Subtask.task_id == task_id,
            Subtask.status.in_(statuses),
        )
        query = self._filter_owner_user_id(query, owner_user_id=owner_user_id)
        return query.all()

    def list_not_executor_deleted_by_task(
        self, db: Session, *, task_id: int, owner_user_id: Optional[int] = None
    ) -> list[Subtask]:
        query = db.query(Subtask).filter(
            Subtask.task_id == task_id,
            Subtask.executor_deleted_at == False,
        )
        query = self._filter_owner_user_id(query, owner_user_id=owner_user_id)
        return query.all()

    def list_history_by_task_statuses(
        self,
        db: Session,
        *,
        task_id: int,
        statuses: Sequence[SubtaskStatus],
        before_message_id: Optional[int] = None,
        limit: Optional[int] = None,
        owner_user_id: Optional[int] = None,
    ) -> list[Subtask]:
        if not statuses:
            return []
        query = db.query(Subtask).filter(
            Subtask.task_id == task_id,
            Subtask.status.in_(statuses),
        )
        query = self._filter_owner_user_id(query, owner_user_id=owner_user_id)
        if before_message_id:
            query = query.filter(Subtask.message_id < before_message_id)
        if limit:
            subtasks = query.order_by(Subtask.message_id.desc()).limit(limit).all()
            return list(reversed(subtasks))
        return query.order_by(Subtask.message_id.asc()).all()

    def get_latest_device_executor_for_task(
        self, db: Session, *, task_id: int, owner_user_id: Optional[int] = None
    ) -> Optional[Subtask]:
        query = db.query(Subtask).filter(
            Subtask.task_id == task_id,
            Subtask.executor_name.like("device-%"),
        )
        query = self._filter_owner_user_id(query, owner_user_id=owner_user_id)
        return query.order_by(Subtask.id.desc()).first()

    def get_latest_active_executor_for_task(
        self, db: Session, *, task_id: int, owner_user_id: Optional[int] = None
    ) -> Optional[Subtask]:
        query = db.query(Subtask).filter(
            Subtask.task_id == task_id,
            Subtask.executor_name.isnot(None),
            Subtask.executor_name != "",
            Subtask.executor_deleted_at == False,
        )
        query = self._filter_owner_user_id(query, owner_user_id=owner_user_id)
        return query.order_by(Subtask.id.desc()).first()

    def list_running_device_subtasks(self, db: Session) -> list[Subtask]:
        return (
            db.query(Subtask)
            .filter(
                Subtask.status == SubtaskStatus.RUNNING,
                Subtask.executor_name.like("device-%"),
            )
            .all()
        )

    def list_running_by_executor_name(
        self, db: Session, *, executor_name: str
    ) -> list[Subtask]:
        return (
            db.query(Subtask)
            .filter(
                Subtask.executor_name == executor_name,
                Subtask.status == SubtaskStatus.RUNNING,
            )
            .all()
        )

    def list_by_executor_ref(
        self, db: Session, *, executor_namespace: str, executor_name: str
    ) -> list[Subtask]:
        return (
            db.query(Subtask)
            .filter(
                Subtask.executor_namespace == executor_namespace,
                Subtask.executor_name == executor_name,
            )
            .all()
        )

    def list_running(self, db: Session) -> list[Subtask]:
        return db.query(Subtask).filter(Subtask.status == SubtaskStatus.RUNNING).all()

    def list_session_task_ids(self, db: Session, *, skip: int, limit: int) -> list[int]:
        rows = (
            db.query(Subtask.task_id)
            .filter(Subtask.status != SubtaskStatus.DELETE)
            .group_by(Subtask.task_id)
            .order_by(func.max(Subtask.id).desc())
            .offset(skip)
            .limit(limit)
            .all()
        )
        return [row[0] for row in rows]

    def update_status(
        self,
        db: Session,
        *,
        subtask: Subtask,
        status: SubtaskStatus,
        completed_at: Optional[datetime] = None,
    ) -> Subtask:
        subtask.status = status
        subtask.updated_at = datetime.now()
        if completed_at is not None:
            subtask.completed_at = completed_at
        return subtask

    def update_result(self, db: Session, *, subtask: Subtask, result: Any) -> Subtask:
        subtask.result = result
        subtask.updated_at = datetime.now()
        flag_modified(subtask, "result")
        return subtask

    def update_error(
        self, db: Session, *, subtask: Subtask, error_message: str
    ) -> Subtask:
        subtask.error_message = error_message
        subtask.updated_at = datetime.now()
        return subtask

    def update_executor_info(
        self,
        db: Session,
        *,
        subtask: Subtask,
        executor_namespace: str,
        executor_name: str,
    ) -> Subtask:
        subtask.executor_namespace = executor_namespace
        subtask.executor_name = executor_name
        subtask.updated_at = datetime.now()
        return subtask

    def update_progress(
        self, db: Session, *, subtask: Subtask, progress: int
    ) -> Subtask:
        subtask.progress = progress
        subtask.updated_at = datetime.now()
        return subtask

    def update_fields(self, db: Session, *, subtask: Subtask, **fields: Any) -> Subtask:
        for field, value in fields.items():
            setattr(subtask, field, value)
        subtask.updated_at = datetime.now()
        if "result" in fields:
            flag_modified(subtask, "result")
        return subtask

    def has_running_assistant(
        self, db: Session, *, task_id: int, owner_user_id: Optional[int] = None
    ) -> bool:
        query = db.query(Subtask.id).filter(
            Subtask.task_id == task_id,
            Subtask.role == SubtaskRole.ASSISTANT,
            Subtask.status.in_([SubtaskStatus.PENDING, SubtaskStatus.RUNNING]),
        )
        query = self._filter_owner_user_id(query, owner_user_id=owner_user_id)
        return query.first() is not None

    def mark_executor_deleted(
        self, db: Session, *, executor_namespace: str, executor_name: str
    ) -> int:
        return (
            db.query(Subtask)
            .filter(
                Subtask.executor_namespace == executor_namespace,
                Subtask.executor_name == executor_name,
            )
            .update(
                {
                    Subtask.executor_deleted_at: True,
                    Subtask.updated_at: datetime.now(),
                },
                synchronize_session=False,
            )
        )

    def mark_task_subtasks_deleted(
        self, db: Session, *, task_id: int, owner_user_id: Optional[int] = None
    ) -> int:
        query = db.query(Subtask).filter(Subtask.task_id == task_id)
        query = self._filter_owner_user_id(query, owner_user_id=owner_user_id)
        return query.update(
            {
                Subtask.executor_deleted_at: True,
                Subtask.status: SubtaskStatus.DELETE,
                Subtask.updated_at: datetime.now(),
            },
            synchronize_session="fetch",
        )

    def mark_task_messages_status(
        self,
        db: Session,
        *,
        task_id: int,
        status: SubtaskStatus,
        owner_user_id: Optional[int] = None,
    ) -> int:
        query = db.query(Subtask).filter(Subtask.task_id == task_id)
        query = self._filter_owner_user_id(query, owner_user_id=owner_user_id)
        return query.update(
            {
                Subtask.status: status,
                Subtask.updated_at: datetime.now(),
            },
            synchronize_session=False,
        )

    def mark_task_subtasks_by_statuses(
        self,
        db: Session,
        *,
        task_id: int,
        from_statuses: Sequence[SubtaskStatus],
        to_status: SubtaskStatus,
        progress: Optional[int] = None,
        completed_at: Optional[datetime] = None,
        owner_user_id: Optional[int] = None,
    ) -> int:
        if not from_statuses:
            return 0
        values: dict[Any, Any] = {
            Subtask.status: to_status,
            Subtask.updated_at: datetime.now(),
        }
        if progress is not None:
            values[Subtask.progress] = progress
        if completed_at is not None:
            values[Subtask.completed_at] = completed_at
        query = db.query(Subtask).filter(
            Subtask.task_id == task_id,
            Subtask.status.in_(from_statuses),
        )
        query = self._filter_owner_user_id(query, owner_user_id=owner_user_id)
        return query.update(values, synchronize_session="fetch")

    def delete(self, db: Session, *, subtask: Subtask) -> None:
        self._cleanup_contexts(db, subtask_ids=[subtask.id])
        db.delete(subtask)

    def delete_from_message_id(
        self,
        db: Session,
        *,
        task_id: int,
        from_message_id: int,
        owner_user_id: Optional[int] = None,
    ) -> int:
        query = db.query(Subtask).filter(
            Subtask.task_id == task_id,
            Subtask.message_id >= from_message_id,
        )
        query = self._filter_owner_user_id(query, owner_user_id=owner_user_id)
        subtasks = query.all()
        return self._delete_subtasks(db, subtasks)

    def delete_after_message_id(
        self,
        db: Session,
        *,
        task_id: int,
        after_message_id: int,
        owner_user_id: Optional[int] = None,
    ) -> int:
        query = db.query(Subtask).filter(
            Subtask.task_id == task_id,
            Subtask.message_id > after_message_id,
        )
        query = self._filter_owner_user_id(query, owner_user_id=owner_user_id)
        subtasks = query.all()
        return self._delete_subtasks(db, subtasks)

    def _load_ordered(self, db: Session, subtask_ids: list[int]) -> list[Subtask]:
        if not subtask_ids:
            return []
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
        id_to_subtask = {subtask.id: subtask for subtask in subtasks}
        return [
            id_to_subtask[subtask_id]
            for subtask_id in subtask_ids
            if subtask_id in id_to_subtask
        ]

    def _delete_subtasks(self, db: Session, subtasks: list[Subtask]) -> int:
        if not subtasks:
            return 0
        subtask_ids = [subtask.id for subtask in subtasks]
        self._cleanup_contexts(db, subtask_ids=subtask_ids)
        for subtask in subtasks:
            db.delete(subtask)
        return len(subtasks)

    def _attach_sender_user_names(self, db: Session, subtasks: list[Subtask]) -> None:
        sender_ids = {
            subtask.sender_user_id
            for subtask in subtasks
            if subtask.sender_user_id and subtask.sender_user_id > 0
        }
        if not sender_ids:
            return

        users = db.query(User).filter(User.id.in_(sender_ids)).all()
        user_name_map = {user.id: user.user_name for user in users}
        for subtask in subtasks:
            if subtask.sender_user_id in user_name_map:
                subtask.sender_user_name = user_name_map[subtask.sender_user_id]

    def _cleanup_contexts(self, db: Session, *, subtask_ids: list[int]) -> None:
        db.query(SubtaskContext).filter(
            SubtaskContext.subtask_id.in_(subtask_ids),
            SubtaskContext.context_type == ContextType.ATTACHMENT.value,
        ).update({"subtask_id": 0}, synchronize_session=False)

        db.query(SubtaskContext).filter(
            SubtaskContext.subtask_id.in_(subtask_ids),
            SubtaskContext.context_type != ContextType.ATTACHMENT.value,
        ).delete(synchronize_session="fetch")
