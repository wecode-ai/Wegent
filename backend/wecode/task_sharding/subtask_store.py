from __future__ import annotations

from collections import defaultdict
from datetime import datetime
from typing import Any, Callable, Literal, Sequence

from sqlalchemy import String, cast, func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, undefer

from app.models.subtask import SenderType, Subtask, SubtaskRole, SubtaskStatus
from app.models.subtask_context import SubtaskContext
from app.models.task import TaskResource
from app.models.user import User
from app.stores.tasks.interfaces import ExecutorReference, FailedSubtaskDetail
from app.stores.tasks.sqlalchemy_subtask_store import SqlAlchemySubtaskStore
from wecode.task_sharding.global_id_allocator import (
    GlobalIdAllocator,
    allocate_subtask_id,
)
from wecode.task_sharding.shard import (
    SHARD_COUNT,
    group_task_ids_by_shard,
    subtask_model_for_owner,
    subtask_model_for_subtask_id,
    subtask_model_for_task_id,
    task_model_for_task_id,
    task_model_for_user,
)
from wecode.task_sharding.task_id import (
    is_new_task_id,
)
from wecode.task_sharding.task_run_metric_hooks import (
    queue_bulk_sharded_subtask_status_metrics,
)
from wecode.task_sharding.task_store import MAX_TASK_ID_INSERT_ATTEMPTS
from wecode.task_sharding.uuid_factory.user_scoped_id_factory import uid_from_id


class ShardedSubtaskStore(SqlAlchemySubtaskStore):
    """Internal subtask store that writes new task messages to subtask shards."""

    def __init__(
        self,
        *,
        global_id_allocator: GlobalIdAllocator | None = None,
    ) -> None:
        self.global_id_allocator = global_id_allocator

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
        result: dict[str, Any] | None = None,
        progress: int = 100,
    ) -> Subtask:
        if not self._task_uses_subtask_shard(db, task_id):
            return super().create_user_subtask(
                db,
                user_id=user_id,
                task_id=task_id,
                team_id=team_id,
                title=title,
                bot_ids=bot_ids,
                prompt=prompt,
                message_id=message_id,
                parent_id=parent_id,
                sender_user_id=sender_user_id,
                result=result,
                progress=progress,
            )

        return self._insert_with_allocated_id(
            db,
            task_id=task_id,
            user_id=user_id,
            factory=lambda model, subtask_id: model(
                id=subtask_id,
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
            ),
        )

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
        if not self._task_uses_subtask_shard(db, task_id):
            return super().create_assistant_subtask(
                db,
                user_id=user_id,
                task_id=task_id,
                team_id=team_id,
                title=title,
                bot_ids=bot_ids,
                message_id=message_id,
                parent_id=parent_id,
            )

        executor_namespace, executor_name, executor_deleted_at = (
            self._latest_assistant_executor(db, task_id=task_id)
        )
        return self._insert_with_allocated_id(
            db,
            task_id=task_id,
            user_id=user_id,
            factory=lambda model, subtask_id: model(
                id=subtask_id,
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
            ),
        )

    def create_user_and_assistant_subtasks(
        self,
        db: Session,
        *,
        user_id: int,
        task_id: int,
        team_id: int,
        title: str,
        assistant_title: str,
        bot_ids: list[int],
        prompt: str,
        user_message_id: int,
        user_parent_id: int,
        assistant_message_id: int,
        assistant_parent_id: int,
        sender_user_id: int = 0,
        result: dict[str, Any] | None = None,
        progress: int = 100,
    ) -> tuple[Subtask, Subtask]:
        if not self._task_uses_subtask_shard(db, task_id):
            return super().create_user_and_assistant_subtasks(
                db,
                user_id=user_id,
                task_id=task_id,
                team_id=team_id,
                title=title,
                assistant_title=assistant_title,
                bot_ids=bot_ids,
                prompt=prompt,
                user_message_id=user_message_id,
                user_parent_id=user_parent_id,
                assistant_message_id=assistant_message_id,
                assistant_parent_id=assistant_parent_id,
                sender_user_id=sender_user_id,
                result=result,
                progress=progress,
            )

        model = self._subtask_model_for_task_lookup(
            db, task_id=task_id, owner_user_id=None
        )
        executor_namespace, executor_name, executor_deleted_at = (
            self._latest_assistant_executor(db, task_id=task_id)
        )
        last_integrity_error: IntegrityError | None = None
        routing_user_id = self._subtask_id_routing_user_id(db, task_id)
        for _ in range(MAX_TASK_ID_INSERT_ATTEMPTS):
            user_subtask_id = self._allocate_subtask_id(routing_user_id)
            assistant_subtask_id = self._allocate_subtask_id(routing_user_id)
            user_subtask = model(
                id=user_subtask_id,
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
                message_id=user_message_id,
                parent_id=user_parent_id,
                error_message="",
                completed_at=datetime.now(),
                result=result,
                sender_type=SenderType.USER,
                sender_user_id=sender_user_id,
            )
            assistant_subtask = model(
                id=assistant_subtask_id,
                user_id=user_id,
                task_id=task_id,
                team_id=team_id,
                title=assistant_title,
                bot_ids=bot_ids,
                role=SubtaskRole.ASSISTANT,
                executor_namespace=executor_namespace,
                executor_name=executor_name,
                executor_deleted_at=executor_deleted_at,
                prompt="",
                status=SubtaskStatus.PENDING,
                progress=0,
                message_id=assistant_message_id,
                parent_id=assistant_parent_id,
                error_message="",
                result=None,
                completed_at=datetime.now(),
                sender_type=SenderType.TEAM,
                sender_user_id=0,
            )
            try:
                with db.begin_nested():
                    db.add_all([user_subtask, assistant_subtask])
                    db.flush()
                return user_subtask, assistant_subtask
            except IntegrityError as exc:
                last_integrity_error = exc

        if last_integrity_error is not None:
            raise last_integrity_error
        raise RuntimeError("Failed to insert paired subtasks")

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
        prompt: str | None,
        executor_namespace: str | None,
        executor_name: str | None,
        message_id: int,
        parent_id: int | None,
        status: SubtaskStatus,
        progress: int,
        result: dict[str, Any] | None,
        error_message: str | None,
    ) -> Subtask:
        if not self._task_uses_subtask_shard(db, task_id):
            return super().create_subtask(
                db,
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
            )

        return self._insert_with_allocated_id(
            db,
            task_id=task_id,
            user_id=user_id,
            factory=lambda model, subtask_id: model(
                id=subtask_id,
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
            ),
        )

    def get_by_id(
        self, db: Session, *, subtask_id: int, owner_user_id: int | None = None
    ) -> Subtask | None:
        if not is_new_task_id(subtask_id):
            migrated = self._get_migrated_legacy_subtask_by_id(
                db, subtask_id=subtask_id, owner_user_id=owner_user_id
            )
            if migrated is not None:
                self._attach_contexts(db, [migrated])
                return migrated
            return super().get_by_id(
                db,
                subtask_id=subtask_id,
                owner_user_id=owner_user_id,
            )
        if not self._owner_matches_subtask_id(db, subtask_id, owner_user_id):
            return None

        subtask = self._get_shard_subtask_by_id(db, subtask_id)
        if subtask is not None:
            self._attach_contexts(db, [subtask])
        return subtask

    def get_basic_by_id(
        self, db: Session, *, subtask_id: int, owner_user_id: int | None = None
    ) -> Subtask | None:
        if not is_new_task_id(subtask_id):
            migrated = self._get_migrated_legacy_subtask_by_id(
                db, subtask_id=subtask_id, owner_user_id=owner_user_id
            )
            if migrated is not None:
                return migrated
            return super().get_basic_by_id(
                db,
                subtask_id=subtask_id,
                owner_user_id=owner_user_id,
            )
        if not self._owner_matches_subtask_id(db, subtask_id, owner_user_id):
            return None

        return self._get_shard_subtask_by_id(db, subtask_id)

    def get_by_id_and_role(
        self,
        db: Session,
        *,
        subtask_id: int,
        role: SubtaskRole,
        owner_user_id: int | None = None,
    ) -> Subtask | None:
        if not is_new_task_id(subtask_id):
            return super().get_by_id_and_role(
                db,
                subtask_id=subtask_id,
                role=role,
                owner_user_id=owner_user_id,
            )
        if not self._owner_matches_subtask_id(db, subtask_id, owner_user_id):
            return None

        model = subtask_model_for_subtask_id(subtask_id)
        return (
            db.query(model)
            .filter(
                model.id == subtask_id,
                model.role == role,
            )
            .first()
        )

    def list_by_ids_and_role(
        self,
        db: Session,
        *,
        subtask_ids: Sequence[int],
        role: SubtaskRole,
    ) -> list[Subtask]:
        if not subtask_ids:
            return []

        unique_ids = list(dict.fromkeys(subtask_ids))
        legacy_ids: list[int] = []
        shard_ids_by_model: dict[type, list[int]] = defaultdict(list)
        for subtask_id in unique_ids:
            if is_new_task_id(subtask_id):
                shard_ids_by_model[subtask_model_for_subtask_id(subtask_id)].append(
                    subtask_id
                )
            else:
                legacy_ids.append(subtask_id)

        subtasks = super().list_by_ids_and_role(
            db,
            subtask_ids=legacy_ids,
            role=role,
        )
        for model, shard_ids in shard_ids_by_model.items():
            subtasks.extend(
                db.query(model)
                .filter(
                    model.id.in_(shard_ids),
                    model.role == role,
                )
                .all()
            )
        return subtasks

    def list_failed_details_by_ids(
        self,
        db: Session,
        *,
        subtask_ids: Sequence[int],
        limit: int,
    ) -> list[FailedSubtaskDetail]:
        if not subtask_ids or limit <= 0:
            return []

        unique_ids = list(dict.fromkeys(subtask_ids))
        legacy_ids: list[int] = []
        shard_ids_by_model: dict[type, list[int]] = defaultdict(list)
        for subtask_id in unique_ids:
            if is_new_task_id(subtask_id):
                model = subtask_model_for_subtask_id(subtask_id)
                shard_ids_by_model[model].append(subtask_id)
            else:
                legacy_ids.append(subtask_id)

        details = super().list_failed_details_by_ids(
            db,
            subtask_ids=legacy_ids,
            limit=len(unique_ids),
        )
        for model, shard_ids in shard_ids_by_model.items():
            details.extend(self._list_shard_failed_details(db, model, shard_ids))

        order = {subtask_id: index for index, subtask_id in enumerate(unique_ids)}
        details.sort(key=lambda detail: order[detail.subtask.id])
        return details[:limit]

    @staticmethod
    def _list_shard_failed_details(
        db: Session,
        subtask_model: type,
        subtask_ids: Sequence[int],
    ) -> list[FailedSubtaskDetail]:
        task_model = task_model_for_task_id(subtask_ids[0])
        rows = (
            db.query(subtask_model, task_model, User.user_name)
            .join(task_model, task_model.id == subtask_model.task_id)
            .outerjoin(User, User.id == subtask_model.user_id)
            .filter(
                subtask_model.id.in_(subtask_ids),
                subtask_model.status == SubtaskStatus.FAILED,
                task_model.kind == "Task",
            )
            .all()
        )
        return [
            FailedSubtaskDetail(
                subtask=subtask,
                task=task,
                user_name=user_name,
            )
            for subtask, task, user_name in rows
        ]

    def get_accessible_by_id(
        self,
        db: Session,
        *,
        subtask_id: int,
        user_id: int,
        access_store,
    ) -> Subtask | None:
        if not is_new_task_id(subtask_id):
            return super().get_accessible_by_id(
                db,
                subtask_id=subtask_id,
                user_id=user_id,
                access_store=access_store,
            )

        model = subtask_model_for_subtask_id(subtask_id)
        subtask = (
            db.query(model)
            .filter(
                model.id == subtask_id,
                model.user_id == user_id,
            )
            .first()
        )
        if subtask is not None:
            self._attach_contexts(db, [subtask])
            return subtask

        subtask = self.get_by_id(db, subtask_id=subtask_id)
        if subtask is None:
            return None
        if access_store.is_member(db, task_id=subtask.task_id, user_id=user_id):
            return subtask
        return None

    def _latest_assistant_executor(
        self, db: Session, *, task_id: int
    ) -> tuple[str, str, bool]:
        reference = self._take_task_executor_reference(db, task_id=task_id)
        if reference.name:
            return reference.namespace, reference.name, reference.deleted_at

        model = self._subtask_model_for_task_lookup(
            db, task_id=task_id, owner_user_id=None
        )
        previous = (
            db.query(
                model.executor_namespace,
                model.executor_name,
                model.executor_deleted_at,
            )
            .filter(
                model.task_id == task_id,
                model.role == SubtaskRole.ASSISTANT,
                model.executor_name != "",
                model.executor_name.isnot(None),
            )
            .order_by(model.id.desc())
            .first()
        )
        if previous is None:
            return "", "", False
        return (
            previous.executor_namespace or "",
            previous.executor_name or "",
            bool(previous.executor_deleted_at),
        )

    def _take_task_executor_reference(
        self,
        db: Session,
        *,
        task_id: int,
    ) -> ExecutorReference:
        """Consume the task-level executor reference used to reuse a sandbox."""
        if not is_new_task_id(task_id):
            return super()._take_task_executor_reference(db, task_id=task_id)
        task_model = task_model_for_task_id(task_id)
        task = (
            db.query(task_model)
            .filter(task_model.id == task_id)
            .with_for_update()
            .first()
        )
        if task is None or not isinstance(task.json, dict):
            return ExecutorReference("", "", False)
        return self._consume_task_executor_reference(task)

    def get_latest_assistant_executor_from(
        self,
        db: Session,
        *,
        task_id: int,
        from_message_id: int,
        owner_user_id: int | None = None,
    ) -> ExecutorReference | None:
        """Return the newest assistant executor inside a deletion range."""
        if not is_new_task_id(task_id):
            return super().get_latest_assistant_executor_from(
                db,
                task_id=task_id,
                from_message_id=from_message_id,
                owner_user_id=owner_user_id,
            )
        if owner_user_id is not None and not self._owner_matches_task_id(
            db, task_id, owner_user_id
        ):
            return None
        model = subtask_model_for_task_id(task_id)
        row = (
            db.query(
                model.executor_namespace,
                model.executor_name,
                model.executor_deleted_at,
            )
            .filter(
                model.task_id == task_id,
                model.role == SubtaskRole.ASSISTANT,
                model.message_id >= from_message_id,
                model.executor_name != "",
                model.executor_name.isnot(None),
            )
            .order_by(model.id.desc())
            .first()
        )
        if row is None:
            return None
        return ExecutorReference(
            namespace=row.executor_namespace or "",
            name=row.executor_name or "",
            deleted_at=bool(row.executor_deleted_at),
        )

    def _allocate_subtask_id(self, user_id: int) -> int:
        if self.global_id_allocator is None:
            raise RuntimeError("No global_id_allocator configured")
        subtask_id = allocate_subtask_id(self.global_id_allocator, user_id)
        if not is_new_task_id(subtask_id):
            raise RuntimeError(
                f"Allocated subtask id is not a user-scoped sharding id: {subtask_id}"
            )
        return subtask_id

    def _insert_with_allocated_id(
        self,
        db: Session,
        *,
        task_id: int,
        user_id: int,
        factory: Callable[[type, int], Subtask],
    ) -> Subtask:
        model = self._subtask_model_for_task_lookup(
            db, task_id=task_id, owner_user_id=None
        )
        last_integrity_error: IntegrityError | None = None
        routing_user_id = self._subtask_id_routing_user_id(db, task_id)
        for _ in range(MAX_TASK_ID_INSERT_ATTEMPTS):
            subtask_id = self._allocate_subtask_id(routing_user_id)
            subtask = factory(model, subtask_id)
            try:
                with db.begin_nested():
                    db.add(subtask)
                    db.flush()
                return subtask
            except IntegrityError as exc:
                last_integrity_error = exc

        if last_integrity_error is not None:
            raise last_integrity_error
        raise RuntimeError("Failed to insert subtask")

    def _subtask_id_routing_user_id(self, db: Session, task_id: int) -> int:
        if is_new_task_id(task_id):
            return uid_from_id(task_id)

        owner_id = self._legacy_task_owner_user_id(
            db,
            task_id=task_id,
            owner_user_id=None,
        )
        if owner_id is None:
            raise RuntimeError(f"No legacy task owner index for task_id={task_id}")
        return owner_id

    def list_by_task(
        self,
        db: Session,
        *,
        task_id: int,
        user_id: int,
        access_store,
        skip: int = 0,
        limit: int = 100,
        from_latest: bool = False,
        before_message_id: int | None = None,
    ) -> list[Subtask]:
        model = self._subtask_model_for_task_lookup(
            db, task_id=task_id, owner_user_id=None
        )
        if model is Subtask:
            return super().list_by_task(
                db,
                task_id=task_id,
                user_id=user_id,
                access_store=access_store,
                skip=skip,
                limit=limit,
                from_latest=from_latest,
                before_message_id=before_message_id,
            )

        base_query = db.query(model.id).filter(model.task_id == task_id)
        if not access_store.is_member(db, task_id=task_id, user_id=user_id):
            base_query = base_query.filter(model.user_id == user_id)
        if before_message_id is not None:
            base_query = base_query.filter(model.message_id < before_message_id)

        if from_latest:
            rows = (
                base_query.order_by(model.message_id.desc(), model.created_at.desc())
                .offset(skip)
                .limit(limit)
                .all()
            )
            subtask_ids = [row[0] for row in rows][::-1]
        else:
            rows = (
                base_query.order_by(model.message_id.asc(), model.created_at.asc())
                .offset(skip)
                .limit(limit)
                .all()
            )
            subtask_ids = [row[0] for row in rows]

        subtasks = self._load_ordered_from_model(db, model, subtask_ids)
        self._attach_sender_user_names(db, subtasks)
        return subtasks

    def list_by_task_desc(
        self, db: Session, *, task_id: int, owner_user_id: int | None = None
    ) -> list[Subtask]:
        if not is_new_task_id(task_id):
            return super().list_by_task_desc(
                db,
                task_id=task_id,
                owner_user_id=owner_user_id,
            )
        if not self._owner_matches_task_id(db, task_id, owner_user_id):
            return []

        model = subtask_model_for_task_id(task_id)
        return (
            db.query(model)
            .filter(model.task_id == task_id)
            .order_by(model.message_id.desc(), model.id.desc())
            .all()
        )

    def list_history_by_task_statuses(
        self,
        db: Session,
        *,
        task_id: int,
        statuses: Sequence[SubtaskStatus],
        before_message_id: int | None = None,
        limit: int | None = None,
        owner_user_id: int | None = None,
    ) -> list[Subtask]:
        if not is_new_task_id(task_id):
            return super().list_history_by_task_statuses(
                db,
                task_id=task_id,
                statuses=statuses,
                before_message_id=before_message_id,
                limit=limit,
                owner_user_id=owner_user_id,
            )
        if not statuses or not self._owner_matches_task_id(db, task_id, owner_user_id):
            return []

        model = subtask_model_for_task_id(task_id)
        query = db.query(model.id).filter(
            model.task_id == task_id,
            model.status.in_(statuses),
        )
        if before_message_id:
            query = query.filter(model.message_id < before_message_id)

        if limit:
            rows = query.order_by(model.message_id.desc()).limit(limit).all()
            subtask_ids = [row[0] for row in rows][::-1]
        else:
            rows = query.order_by(model.message_id.asc()).all()
            subtask_ids = [row[0] for row in rows]

        return self._load_ordered_from_model(db, model, subtask_ids)

    def count_by_task_for_user(
        self,
        db: Session,
        *,
        task_id: int,
        user_id: int,
        access_store,
    ) -> int:
        if not is_new_task_id(task_id):
            return super().count_by_task_for_user(
                db,
                task_id=task_id,
                user_id=user_id,
                access_store=access_store,
            )

        model = subtask_model_for_task_id(task_id)
        query = db.query(model).filter(model.task_id == task_id)
        if not access_store.is_member(db, task_id=task_id, user_id=user_id):
            query = query.filter(model.user_id == user_id)
        return query.count()

    def list_by_user(
        self, db: Session, *, user_id: int, skip: int = 0, limit: int = 100
    ) -> list[Subtask]:
        if limit <= 0:
            return []

        fetch_limit = skip + limit
        subtasks = super().list_by_user(
            db,
            user_id=user_id,
            skip=0,
            limit=fetch_limit,
        )
        model = subtask_model_for_owner(user_id)
        subtasks.extend(
            db.query(model)
            .filter(model.user_id == user_id)
            .order_by(model.id.desc())
            .limit(fetch_limit)
            .all()
        )
        unique_by_id = {subtask.id: subtask for subtask in subtasks}
        return sorted(
            unique_by_id.values(),
            key=lambda subtask: subtask.id,
            reverse=True,
        )[skip : skip + limit]

    def list_latest_by_task(
        self, db: Session, *, task_id: int, user_id: int, limit: int = 100
    ) -> list[Subtask]:
        model = self._subtask_model_for_task_lookup(
            db,
            task_id=task_id,
            owner_user_id=user_id,
        )
        if model is Subtask:
            return super().list_latest_by_task(
                db,
                task_id=task_id,
                user_id=user_id,
                limit=limit,
            )

        rows = (
            db.query(model.id)
            .filter(model.task_id == task_id, model.user_id == user_id)
            .order_by(model.message_id.desc(), model.created_at.desc())
            .limit(limit)
            .all()
        )
        return self._load_ordered_from_model(db, model, [row[0] for row in rows][::-1])

    def list_new_messages_since(
        self,
        db: Session,
        *,
        task_id: int,
        owner_user_id: int | None = None,
        last_subtask_id: int | None = None,
        since: datetime | None = None,
    ) -> list[Subtask]:
        if not is_new_task_id(task_id):
            return super().list_new_messages_since(
                db,
                task_id=task_id,
                owner_user_id=owner_user_id,
                last_subtask_id=last_subtask_id,
                since=since,
            )
        if not self._owner_matches_task_id(db, task_id, owner_user_id):
            return []

        model = subtask_model_for_task_id(task_id)
        query = (
            db.query(model)
            .options(
                undefer(model.prompt),
                undefer(model.result),
                undefer(model.error_message),
            )
            .filter(model.task_id == task_id)
        )
        if last_subtask_id:
            query = query.filter(model.id > last_subtask_id)
        if since:
            query = query.filter(model.created_at > since)

        subtasks = query.order_by(model.message_id.asc(), model.created_at.asc()).all()
        self._attach_contexts(db, subtasks)
        self._attach_sender_user_names(db, subtasks)
        return subtasks

    def get_first_by_task(
        self, db: Session, *, task_id: int, owner_user_id: int | None = None
    ) -> Subtask | None:
        if not is_new_task_id(task_id):
            return super().get_first_by_task(
                db,
                task_id=task_id,
                owner_user_id=owner_user_id,
            )
        if not self._owner_matches_task_id(db, task_id, owner_user_id):
            return None

        model = subtask_model_for_task_id(task_id)
        return (
            db.query(model)
            .filter(model.task_id == task_id)
            .order_by(model.id.asc())
            .first()
        )

    def get_next_message_id(
        self, db: Session, *, task_id: int, owner_user_id: int | None = None
    ) -> int:
        if is_new_task_id(task_id) and not self._owner_matches_task_id(
            db, task_id, owner_user_id
        ):
            return 1
        model = self._subtask_model_for_task_lookup(
            db,
            task_id=task_id,
            owner_user_id=owner_user_id,
        )
        if model is Subtask:
            return super().get_next_message_id(
                db,
                task_id=task_id,
                owner_user_id=owner_user_id,
            )

        max_message_id = (
            db.query(func.max(model.message_id))
            .filter(model.task_id == task_id)
            .scalar()
        )
        return int(max_message_id or 0) + 1

    def get_latest_for_user(
        self, db: Session, *, task_id: int, user_id: int
    ) -> Subtask | None:
        if not is_new_task_id(task_id):
            return super().get_latest_for_user(
                db,
                task_id=task_id,
                user_id=user_id,
            )

        model = subtask_model_for_task_id(task_id)
        return (
            db.query(model)
            .filter(model.task_id == task_id, model.user_id == user_id)
            .order_by(model.message_id.desc(), model.created_at.desc())
            .first()
        )

    def get_running_assistant_for_user(
        self, db: Session, *, task_id: int, user_id: int
    ) -> Subtask | None:
        if not is_new_task_id(task_id):
            return super().get_running_assistant_for_user(
                db,
                task_id=task_id,
                user_id=user_id,
            )

        model = subtask_model_for_task_id(task_id)
        return (
            db.query(model)
            .filter(
                model.task_id == task_id,
                model.user_id == user_id,
                model.role == SubtaskRole.ASSISTANT,
                model.status == SubtaskStatus.RUNNING,
            )
            .first()
        )

    def get_latest_assistant_by_statuses(
        self,
        db: Session,
        *,
        task_id: int,
        statuses: Sequence[SubtaskStatus],
        owner_user_id: int | None = None,
    ) -> Subtask | None:
        if not is_new_task_id(task_id):
            return super().get_latest_assistant_by_statuses(
                db,
                task_id=task_id,
                statuses=statuses,
                owner_user_id=owner_user_id,
            )
        if not statuses or not self._owner_matches_task_id(db, task_id, owner_user_id):
            return None

        model = subtask_model_for_task_id(task_id)
        return (
            db.query(model)
            .filter(
                model.task_id == task_id,
                model.role == SubtaskRole.ASSISTANT,
                model.status.in_(statuses),
            )
            .order_by(model.message_id.desc(), model.id.desc())
            .first()
        )

    def get_by_task_message_id_and_role(
        self,
        db: Session,
        *,
        task_id: int,
        message_id: int,
        role: SubtaskRole,
        owner_user_id: int | None = None,
    ) -> Subtask | None:
        if not is_new_task_id(task_id):
            return super().get_by_task_message_id_and_role(
                db,
                task_id=task_id,
                message_id=message_id,
                role=role,
                owner_user_id=owner_user_id,
            )
        if not self._owner_matches_task_id(db, task_id, owner_user_id):
            return None

        model = subtask_model_for_task_id(task_id)
        return (
            db.query(model)
            .filter(
                model.task_id == task_id,
                model.message_id == message_id,
                model.role == role,
            )
            .first()
        )

    def get_user_by_task_message_id(
        self,
        db: Session,
        *,
        task_id: int,
        message_id: int,
        owner_user_id: int | None = None,
    ) -> Subtask | None:
        subtask = self.get_by_task_message_id_and_role(
            db,
            task_id=task_id,
            message_id=message_id,
            role=SubtaskRole.USER,
            owner_user_id=owner_user_id,
        )
        if subtask is not None and is_new_task_id(task_id):
            self._attach_contexts(db, [subtask])
        return subtask

    def get_by_task_parent_id_and_role(
        self,
        db: Session,
        *,
        task_id: int,
        parent_id: int,
        role: SubtaskRole,
        owner_user_id: int | None = None,
    ) -> Subtask | None:
        if not is_new_task_id(task_id):
            return super().get_by_task_parent_id_and_role(
                db,
                task_id=task_id,
                parent_id=parent_id,
                role=role,
                owner_user_id=owner_user_id,
            )
        if not self._owner_matches_task_id(db, task_id, owner_user_id):
            return None

        model = subtask_model_for_task_id(task_id)
        return (
            db.query(model)
            .filter(
                model.task_id == task_id,
                model.parent_id == parent_id,
                model.role == role,
            )
            .first()
        )

    def get_first_user_before_message_id(
        self,
        db: Session,
        *,
        task_id: int,
        before_message_id: int,
        owner_user_id: int | None = None,
    ) -> Subtask | None:
        if not is_new_task_id(task_id):
            return super().get_first_user_before_message_id(
                db,
                task_id=task_id,
                before_message_id=before_message_id,
                owner_user_id=owner_user_id,
            )
        if not self._owner_matches_task_id(db, task_id, owner_user_id):
            return None

        model = subtask_model_for_task_id(task_id)
        return (
            db.query(model)
            .filter(
                model.task_id == task_id,
                model.role == SubtaskRole.USER,
                model.message_id < before_message_id,
            )
            .order_by(model.message_id.desc(), model.id.desc())
            .first()
        )

    def get_latest_assistant_for_user_by_statuses(
        self,
        db: Session,
        *,
        task_id: int,
        user_id: int,
        statuses: Sequence[SubtaskStatus],
    ) -> Subtask | None:
        if not is_new_task_id(task_id):
            return super().get_latest_assistant_for_user_by_statuses(
                db,
                task_id=task_id,
                user_id=user_id,
                statuses=statuses,
            )
        if not statuses:
            return None

        model = subtask_model_for_task_id(task_id)
        return (
            db.query(model)
            .filter(
                model.task_id == task_id,
                model.user_id == user_id,
                model.role == SubtaskRole.ASSISTANT,
                model.status.in_(statuses),
            )
            .order_by(model.id.desc())
            .first()
        )

    def list_completed_before_message_id(
        self,
        db: Session,
        *,
        task_id: int,
        before_message_id: int,
        owner_user_id: int | None = None,
    ) -> list[Subtask]:
        if not is_new_task_id(task_id):
            return super().list_completed_before_message_id(
                db,
                task_id=task_id,
                before_message_id=before_message_id,
                owner_user_id=owner_user_id,
            )
        if not self._owner_matches_task_id(db, task_id, owner_user_id):
            return []

        model = subtask_model_for_task_id(task_id)
        return (
            db.query(model)
            .filter(
                model.task_id == task_id,
                model.message_id < before_message_id,
                model.status == SubtaskStatus.COMPLETED,
            )
            .order_by(model.message_id.asc())
            .all()
        )

    def get_retry_assistant(
        self,
        db: Session,
        *,
        task_id: int,
        subtask_id: int,
        owner_user_id: int | None = None,
    ) -> Subtask | None:
        if not is_new_task_id(task_id):
            return super().get_retry_assistant(
                db,
                task_id=task_id,
                subtask_id=subtask_id,
                owner_user_id=owner_user_id,
            )
        if not self._owner_matches_task_id(db, task_id, owner_user_id):
            return None

        model = subtask_model_for_task_id(task_id)
        return (
            db.query(model)
            .filter(
                model.id == subtask_id,
                model.task_id == task_id,
                model.role == SubtaskRole.ASSISTANT,
            )
            .first()
        )

    def get_latest_running_assistant_by_task(
        self, db: Session, *, task_id: int, owner_user_id: int | None = None
    ) -> Subtask | None:
        if not is_new_task_id(task_id):
            return super().get_latest_running_assistant_by_task(
                db,
                task_id=task_id,
                owner_user_id=owner_user_id,
            )
        if not self._owner_matches_task_id(db, task_id, owner_user_id):
            return None

        model = subtask_model_for_task_id(task_id)
        return (
            db.query(model)
            .filter(
                model.task_id == task_id,
                model.role == SubtaskRole.ASSISTANT,
                model.status == SubtaskStatus.RUNNING,
            )
            .order_by(model.id.desc())
            .first()
        )

    def list_after_message_id(
        self,
        db: Session,
        *,
        task_id: int,
        after_message_id: int,
        owner_user_id: int | None = None,
    ) -> list[Subtask]:
        if not is_new_task_id(task_id):
            return super().list_after_message_id(
                db,
                task_id=task_id,
                after_message_id=after_message_id,
                owner_user_id=owner_user_id,
            )
        if not self._owner_matches_task_id(db, task_id, owner_user_id):
            return []

        model = subtask_model_for_task_id(task_id)
        subtasks = (
            db.query(model)
            .filter(
                model.task_id == task_id,
                model.message_id > after_message_id,
            )
            .order_by(model.message_id.asc())
            .all()
        )
        self._attach_sender_user_names(db, subtasks)
        return subtasks

    def get_latest_by_task(
        self, db: Session, *, task_id: int, owner_user_id: int | None = None
    ) -> Subtask | None:
        if not is_new_task_id(task_id):
            return super().get_latest_by_task(
                db,
                task_id=task_id,
                owner_user_id=owner_user_id,
            )
        if not self._owner_matches_task_id(db, task_id, owner_user_id):
            return None

        model = subtask_model_for_task_id(task_id)
        return (
            db.query(model)
            .filter(model.task_id == task_id)
            .order_by(model.message_id.desc(), model.created_at.desc())
            .first()
        )

    def list_by_task_ordered(
        self,
        db: Session,
        *,
        task_id: int,
        message_ids: Sequence[int] | None = None,
        exclude_subtask_ids: Sequence[int] | None = None,
        exclude_deleted: bool = False,
        order_by: Literal["id", "message_id", "created_at"] = "message_id",
        owner_user_id: int | None = None,
    ) -> list[Subtask]:
        if is_new_task_id(task_id) and not self._owner_matches_task_id(
            db, task_id, owner_user_id
        ):
            return []
        model = self._subtask_model_for_task_lookup(
            db,
            task_id=task_id,
            owner_user_id=owner_user_id,
        )
        if model is Subtask:
            return super().list_by_task_ordered(
                db,
                task_id=task_id,
                message_ids=message_ids,
                exclude_subtask_ids=exclude_subtask_ids,
                exclude_deleted=exclude_deleted,
                order_by=order_by,
                owner_user_id=owner_user_id,
            )
        if message_ids is not None and not message_ids:
            return []

        query = db.query(model).filter(model.task_id == task_id)
        if message_ids is not None:
            query = query.filter(model.message_id.in_(message_ids))
        if exclude_subtask_ids:
            query = query.filter(model.id.notin_(exclude_subtask_ids))
        if exclude_deleted:
            query = query.filter(model.status != SubtaskStatus.DELETE)
        if order_by == "id":
            subtasks = query.order_by(model.id.asc()).all()
        elif order_by == "created_at":
            subtasks = query.order_by(model.created_at.asc(), model.id.asc()).all()
        else:
            subtasks = query.order_by(
                model.message_id.asc(), model.created_at.asc()
            ).all()
        self._attach_contexts(db, subtasks)
        return subtasks

    def list_by_task_for_user_ordered(
        self,
        db: Session,
        *,
        task_id: int,
        user_id: int,
    ) -> list[Subtask]:
        if not is_new_task_id(task_id):
            return super().list_by_task_for_user_ordered(
                db,
                task_id=task_id,
                user_id=user_id,
            )

        model = subtask_model_for_task_id(task_id)
        return (
            db.query(model)
            .filter(model.task_id == task_id, model.user_id == user_id)
            .order_by(model.message_id.asc())
            .all()
        )

    def list_by_task_unfiltered(
        self, db: Session, *, task_id: int, owner_user_id: int | None = None
    ) -> list[Subtask]:
        if is_new_task_id(task_id) and not self._owner_matches_task_id(
            db, task_id, owner_user_id
        ):
            return []
        model = self._subtask_model_for_task_lookup(
            db,
            task_id=task_id,
            owner_user_id=owner_user_id,
        )
        if model is Subtask:
            return super().list_by_task_unfiltered(
                db,
                task_id=task_id,
                owner_user_id=owner_user_id,
            )

        return db.query(model).filter(model.task_id == task_id).all()

    def list_assistant_by_task(
        self, db: Session, *, task_id: int, owner_user_id: int | None = None
    ) -> list[Subtask]:
        if not is_new_task_id(task_id):
            return super().list_assistant_by_task(
                db,
                task_id=task_id,
                owner_user_id=owner_user_id,
            )
        if not self._owner_matches_task_id(db, task_id, owner_user_id):
            return []

        model = subtask_model_for_task_id(task_id)
        return (
            db.query(model)
            .filter(
                model.task_id == task_id,
                model.role == SubtaskRole.ASSISTANT,
            )
            .order_by(model.message_id.asc())
            .all()
        )

    def list_ids_by_task(
        self,
        db: Session,
        *,
        task_id: int,
        user_id: int | None = None,
        owner_user_id: int | None = None,
    ) -> list[int]:
        if not is_new_task_id(task_id):
            return super().list_ids_by_task(
                db,
                task_id=task_id,
                user_id=user_id,
                owner_user_id=owner_user_id,
            )
        if not self._owner_matches_task_id(db, task_id, owner_user_id):
            return []

        model = subtask_model_for_task_id(task_id)
        query = db.query(model.id).filter(model.task_id == task_id)
        if user_id is not None:
            query = query.filter(model.user_id == user_id)
        rows = query.all()
        return [int(row[0]) for row in rows]

    def list_by_task_statuses(
        self,
        db: Session,
        *,
        task_id: int,
        statuses: Sequence[SubtaskStatus],
        owner_user_id: int | None = None,
    ) -> list[Subtask]:
        if not is_new_task_id(task_id):
            return super().list_by_task_statuses(
                db,
                task_id=task_id,
                statuses=statuses,
                owner_user_id=owner_user_id,
            )
        if not statuses or not self._owner_matches_task_id(db, task_id, owner_user_id):
            return []

        model = subtask_model_for_task_id(task_id)
        return (
            db.query(model)
            .filter(
                model.task_id == task_id,
                model.status.in_(statuses),
            )
            .all()
        )

    def list_not_executor_deleted_by_task(
        self, db: Session, *, task_id: int, owner_user_id: int | None = None
    ) -> list[Subtask]:
        if not is_new_task_id(task_id):
            return super().list_not_executor_deleted_by_task(
                db,
                task_id=task_id,
                owner_user_id=owner_user_id,
            )
        if not self._owner_matches_task_id(db, task_id, owner_user_id):
            return []

        model = subtask_model_for_task_id(task_id)
        return (
            db.query(model)
            .filter(
                model.task_id == task_id,
                model.executor_deleted_at == False,
            )
            .all()
        )

    def has_running_assistant(
        self, db: Session, *, task_id: int, owner_user_id: int | None = None
    ) -> bool:
        if not is_new_task_id(task_id):
            return super().has_running_assistant(
                db,
                task_id=task_id,
                owner_user_id=owner_user_id,
            )
        if not self._owner_matches_task_id(db, task_id, owner_user_id):
            return False

        model = subtask_model_for_task_id(task_id)
        return (
            db.query(model.id)
            .filter(
                model.task_id == task_id,
                model.role == SubtaskRole.ASSISTANT,
                model.status.in_([SubtaskStatus.PENDING, SubtaskStatus.RUNNING]),
            )
            .first()
            is not None
        )

    def get_latest_device_executor_for_task(
        self, db: Session, *, task_id: int, owner_user_id: int | None = None
    ) -> Subtask | None:
        if not is_new_task_id(task_id):
            return super().get_latest_device_executor_for_task(
                db,
                task_id=task_id,
                owner_user_id=owner_user_id,
            )
        if not self._owner_matches_task_id(db, task_id, owner_user_id):
            return None

        model = subtask_model_for_task_id(task_id)
        return (
            db.query(model)
            .filter(
                model.task_id == task_id,
                model.executor_name.like("device-%"),
            )
            .order_by(model.id.desc())
            .first()
        )

    def get_latest_active_executor_for_task(
        self, db: Session, *, task_id: int, owner_user_id: int | None = None
    ) -> Subtask | None:
        if not is_new_task_id(task_id):
            return super().get_latest_active_executor_for_task(
                db,
                task_id=task_id,
                owner_user_id=owner_user_id,
            )
        if not self._owner_matches_task_id(db, task_id, owner_user_id):
            return None

        model = subtask_model_for_task_id(task_id)
        return (
            db.query(model)
            .filter(
                model.task_id == task_id,
                model.executor_name.isnot(None),
                model.executor_name != "",
                model.executor_deleted_at == False,
            )
            .order_by(model.id.desc())
            .first()
        )

    def list_recent_by_task_ids(
        self,
        db: Session,
        *,
        task_ids: Sequence[int],
        limit: int,
        owner_user_id: int | None = None,
    ) -> list[Subtask]:
        if not task_ids or limit <= 0:
            return []

        legacy_task_ids, new_task_ids = self._bulk_task_ids_by_storage(
            db,
            task_ids,
            owner_user_id=owner_user_id,
        )
        subtasks = super().list_recent_by_task_ids(
            db,
            task_ids=legacy_task_ids,
            limit=limit,
            owner_user_id=owner_user_id,
        )
        for grouped_task_ids in group_task_ids_by_shard(new_task_ids).values():
            model = subtask_model_for_task_id(grouped_task_ids[0])
            subtasks.extend(
                db.query(model)
                .filter(model.task_id.in_(grouped_task_ids))
                .order_by(model.updated_at.desc())
                .limit(limit)
                .all()
            )

        unique_by_id = {subtask.id: subtask for subtask in subtasks}
        return sorted(
            unique_by_id.values(),
            key=lambda subtask: subtask.updated_at,
            reverse=True,
        )[:limit]

    def search_task_ids_by_content(
        self,
        db: Session,
        *,
        task_ids: Sequence[int],
        keyword: str,
        owner_user_id: int | None = None,
    ) -> set[int]:
        if not task_ids:
            return set()

        legacy_task_ids, new_task_ids = self._bulk_task_ids_by_storage(
            db,
            task_ids,
            owner_user_id=owner_user_id,
        )
        matching_task_ids = super().search_task_ids_by_content(
            db,
            task_ids=legacy_task_ids,
            keyword=keyword,
            owner_user_id=owner_user_id,
        )
        like_pattern = f"%{keyword}%"
        for grouped_task_ids in group_task_ids_by_shard(new_task_ids).values():
            model = subtask_model_for_task_id(grouped_task_ids[0])
            rows = (
                db.query(model.task_id)
                .filter(model.task_id.in_(grouped_task_ids))
                .filter(
                    or_(
                        model.prompt.ilike(like_pattern),
                        model.error_message.ilike(like_pattern),
                        cast(model.result, String).ilike(like_pattern),
                    )
                )
                .distinct()
                .all()
            )
            matching_task_ids.update(int(row[0]) for row in rows)
        return matching_task_ids

    def list_running_device_subtasks(self, db: Session) -> list[Subtask]:
        return self._scan_subtask_tables(
            db,
            lambda query, model: query.filter(
                model.status == SubtaskStatus.RUNNING,
                model.executor_name.like("device-%"),
            ),
        )

    def list_running_by_executor_name(
        self, db: Session, *, executor_name: str
    ) -> list[Subtask]:
        return self._scan_subtask_tables(
            db,
            lambda query, model: query.filter(
                model.executor_name == executor_name,
                model.status == SubtaskStatus.RUNNING,
            ),
        )

    def list_by_executor_ref(
        self, db: Session, *, executor_namespace: str, executor_name: str
    ) -> list[Subtask]:
        return self._scan_subtask_tables(
            db,
            lambda query, model: query.filter(
                model.executor_namespace == executor_namespace,
                model.executor_name == executor_name,
            ),
        )

    def list_running(self, db: Session) -> list[Subtask]:
        return self._scan_subtask_tables(
            db,
            lambda query, model: query.filter(model.status == SubtaskStatus.RUNNING),
        )

    def list_running_since(
        self,
        db: Session,
        *,
        created_after: datetime,
    ) -> list[Subtask]:
        return self._scan_subtask_tables(
            db,
            lambda query, model: query.filter(
                model.status == SubtaskStatus.RUNNING,
                model.created_at >= created_after,
            ),
        )

    def list_session_task_ids(self, db: Session, *, skip: int, limit: int) -> list[int]:
        max_subtask_id_by_task: dict[int, int] = {}
        for task_id_value, max_subtask_id in self._scan_subtask_tables(
            db,
            lambda query, model: query.with_entities(
                model.task_id,
                func.max(model.id),
            )
            .filter(model.status != SubtaskStatus.DELETE)
            .group_by(model.task_id),
        ):
            current_max = max_subtask_id_by_task.get(task_id_value)
            if current_max is None or max_subtask_id > current_max:
                max_subtask_id_by_task[task_id_value] = max_subtask_id

        sorted_task_ids = [
            task_id_value
            for task_id_value, _ in sorted(
                max_subtask_id_by_task.items(),
                key=lambda item: item[1],
                reverse=True,
            )
        ]
        return sorted_task_ids[skip : skip + limit]

    def get_cleanup_cursor_recent_start_reference(
        self, db: Session, *, recent_threshold: datetime
    ) -> Subtask | None:
        rows = self._scan_subtask_tables(
            db,
            lambda query, model: query.filter(
                model.created_at >= recent_threshold,
            )
            .order_by(model.created_at.asc(), model.id.asc())
            .limit(1),
        )
        if not rows:
            return None
        return min(rows, key=lambda subtask: (subtask.created_at, subtask.id))

    def get_cleanup_cursor_latest_reference(self, db: Session) -> Subtask | None:
        rows = self._scan_subtask_tables(
            db,
            lambda query, model: query.order_by(model.id.desc()).limit(1),
        )
        if not rows:
            return None
        return max(rows, key=lambda subtask: subtask.id)

    def list_runtime_cleanup_subtasks(self, db: Session) -> list[Subtask]:
        rows = self._scan_subtask_tables(
            db,
            lambda query, model: query.filter(
                model.executor_name.isnot(None),
                model.executor_name != "",
                model.executor_deleted_at == False,
            ),
        )
        return sorted(rows, key=lambda subtask: (subtask.updated_at, subtask.id))

    def scan_cleanup_candidate_subtasks(
        self, db: Session, *, last_id: int, cutoff: datetime, limit: int
    ) -> list[Subtask]:
        rows = self._scan_subtask_tables(
            db,
            lambda query, model: query.filter(
                model.id > last_id,
                model.created_at <= cutoff,
            )
            .order_by(model.id.asc())
            .limit(limit),
        )
        return sorted(rows, key=lambda subtask: subtask.id)[:limit]

    def scan_cleanup_lookback_subtasks(
        self,
        db: Session,
        *,
        lookback_start: datetime,
        cutoff: datetime,
        limit: int,
    ) -> list[Subtask]:
        rows = self._scan_subtask_tables(
            db,
            lambda query, model: query.filter(
                model.status.in_(
                    [
                        SubtaskStatus.PENDING,
                        SubtaskStatus.COMPLETED,
                        SubtaskStatus.FAILED,
                        SubtaskStatus.CANCELLED,
                    ]
                ),
                model.created_at > lookback_start,
                model.created_at <= cutoff,
                model.executor_name.isnot(None),
                model.executor_name != "",
                model.executor_deleted_at == False,
            )
            .order_by(model.created_at.asc(), model.id.asc())
            .limit(limit),
        )
        return sorted(rows, key=lambda subtask: (subtask.created_at, subtask.id))[
            :limit
        ]

    def list_cleanup_subtasks_for_task(
        self, db: Session, *, task_id: int, owner_user_id: int | None = None
    ) -> list[Subtask]:
        if not is_new_task_id(task_id):
            return super().list_cleanup_subtasks_for_task(
                db,
                task_id=task_id,
                owner_user_id=owner_user_id,
            )
        if not self._owner_matches_task_id(db, task_id, owner_user_id):
            return []

        model = subtask_model_for_task_id(task_id)
        return (
            db.query(model)
            .filter(
                model.task_id == task_id,
                model.executor_name.isnot(None),
                model.executor_name != "",
                model.executor_deleted_at == False,
            )
            .all()
        )

    def mark_executor_deleted(
        self, db: Session, *, executor_namespace: str, executor_name: str
    ) -> int:
        updated_count = super().mark_executor_deleted(
            db,
            executor_namespace=executor_namespace,
            executor_name=executor_name,
        )
        for model in self._all_shard_subtask_models():
            updated_count += (
                db.query(model)
                .filter(
                    model.executor_namespace == executor_namespace,
                    model.executor_name == executor_name,
                )
                .update(
                    {
                        model.executor_deleted_at: True,
                        model.updated_at: datetime.now(),
                    },
                    synchronize_session=False,
                )
            )
        return updated_count

    def mark_executor_deleted_by_ids(
        self, db: Session, *, subtask_ids: Sequence[int]
    ) -> int:
        if not subtask_ids:
            return 0

        legacy_ids: list[int] = []
        shard_ids_by_model: dict[type, list[int]] = defaultdict(list)
        for subtask_id in dict.fromkeys(subtask_ids):
            if is_new_task_id(subtask_id):
                shard_ids_by_model[subtask_model_for_subtask_id(subtask_id)].append(
                    subtask_id
                )
            else:
                legacy_ids.append(subtask_id)

        updated_count = super().mark_executor_deleted_by_ids(
            db,
            subtask_ids=legacy_ids,
        )
        for model, shard_ids in shard_ids_by_model.items():
            updated_count += (
                db.query(model)
                .filter(
                    model.id.in_(shard_ids),
                    model.executor_deleted_at == False,
                )
                .update(
                    {
                        model.executor_deleted_at: True,
                        model.updated_at: datetime.now(),
                    },
                    synchronize_session=False,
                )
            )
        return updated_count

    def list_by_task_status(
        self,
        db: Session,
        *,
        task_id: int,
        status: SubtaskStatus,
        owner_user_id: int | None = None,
    ) -> list[Subtask]:
        if not is_new_task_id(task_id):
            return super().list_by_task_status(
                db,
                task_id=task_id,
                status=status,
                owner_user_id=owner_user_id,
            )
        if not self._owner_matches_task_id(db, task_id, owner_user_id):
            return []

        model = subtask_model_for_task_id(task_id)
        subtasks = (
            db.query(model)
            .filter(model.task_id == task_id, model.status == status)
            .all()
        )
        self._attach_contexts(db, subtasks)
        return subtasks

    def mark_task_subtasks_deleted(
        self, db: Session, *, task_id: int, owner_user_id: int | None = None
    ) -> int:
        if not is_new_task_id(task_id):
            return super().mark_task_subtasks_deleted(
                db,
                task_id=task_id,
                owner_user_id=owner_user_id,
            )
        if not self._owner_matches_task_id(db, task_id, owner_user_id):
            return 0

        model = subtask_model_for_task_id(task_id)
        query = db.query(model).filter(model.task_id == task_id)
        self._queue_shard_bulk_status_metrics(
            db,
            query,
            model=model,
            status=SubtaskStatus.DELETE,
        )
        return query.update(
            {
                model.executor_deleted_at: True,
                model.status: SubtaskStatus.DELETE,
                model.updated_at: datetime.now(),
            },
            synchronize_session="fetch",
        )

    def mark_task_messages_status(
        self,
        db: Session,
        *,
        task_id: int,
        status: SubtaskStatus,
        owner_user_id: int | None = None,
    ) -> int:
        if not is_new_task_id(task_id):
            return super().mark_task_messages_status(
                db,
                task_id=task_id,
                status=status,
                owner_user_id=owner_user_id,
            )
        if not self._owner_matches_task_id(db, task_id, owner_user_id):
            return 0

        model = subtask_model_for_task_id(task_id)
        query = db.query(model).filter(model.task_id == task_id)
        self._queue_shard_bulk_status_metrics(
            db,
            query,
            model=model,
            status=status,
        )
        return query.update(
            {
                model.status: status,
                model.updated_at: datetime.now(),
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
        progress: int | None = None,
        completed_at: datetime | None = None,
        owner_user_id: int | None = None,
    ) -> int:
        if not is_new_task_id(task_id):
            return super().mark_task_subtasks_by_statuses(
                db,
                task_id=task_id,
                from_statuses=from_statuses,
                to_status=to_status,
                progress=progress,
                completed_at=completed_at,
                owner_user_id=owner_user_id,
            )
        if not from_statuses or not self._owner_matches_task_id(
            db, task_id, owner_user_id
        ):
            return 0

        model = subtask_model_for_task_id(task_id)
        values: dict[Any, Any] = {
            model.status: to_status,
            model.updated_at: datetime.now(),
        }
        if progress is not None:
            values[model.progress] = progress
        if completed_at is not None:
            values[model.completed_at] = completed_at
        query = db.query(model).filter(
            model.task_id == task_id,
            model.status.in_(from_statuses),
        )
        self._queue_shard_bulk_status_metrics(
            db,
            query,
            model=model,
            status=to_status,
        )
        return query.update(values, synchronize_session="fetch")

    def delete_from_message_id(
        self,
        db: Session,
        *,
        task_id: int,
        from_message_id: int,
        owner_user_id: int | None = None,
    ) -> int:
        if not is_new_task_id(task_id):
            return super().delete_from_message_id(
                db,
                task_id=task_id,
                from_message_id=from_message_id,
                owner_user_id=owner_user_id,
            )
        if not self._owner_matches_task_id(db, task_id, owner_user_id):
            return 0

        model = subtask_model_for_task_id(task_id)
        subtasks = (
            db.query(model)
            .filter(model.task_id == task_id, model.message_id >= from_message_id)
            .all()
        )
        return self._delete_subtasks(db, subtasks)

    def delete_after_message_id(
        self,
        db: Session,
        *,
        task_id: int,
        after_message_id: int,
        owner_user_id: int | None = None,
    ) -> int:
        if not is_new_task_id(task_id):
            return super().delete_after_message_id(
                db,
                task_id=task_id,
                after_message_id=after_message_id,
                owner_user_id=owner_user_id,
            )
        if not self._owner_matches_task_id(db, task_id, owner_user_id):
            return 0

        model = subtask_model_for_task_id(task_id)
        subtasks = (
            db.query(model)
            .filter(model.task_id == task_id, model.message_id > after_message_id)
            .all()
        )
        return self._delete_subtasks(db, subtasks)

    def _load_ordered_from_model(
        self, db: Session, model: type, subtask_ids: list[int]
    ) -> list[Subtask]:
        if not subtask_ids:
            return []
        subtasks = (
            db.query(model)
            .options(
                undefer(model.prompt),
                undefer(model.result),
                undefer(model.error_message),
            )
            .filter(model.id.in_(subtask_ids))
            .all()
        )
        self._attach_contexts(db, subtasks)
        id_to_subtask = {subtask.id: subtask for subtask in subtasks}
        return [
            id_to_subtask[subtask_id]
            for subtask_id in subtask_ids
            if subtask_id in id_to_subtask
        ]

    @staticmethod
    def _queue_shard_bulk_status_metrics(
        db: Session,
        query,
        *,
        model: type,
        status: SubtaskStatus,
    ) -> None:
        metric_query = query.filter(model.role == SubtaskRole.ASSISTANT)
        if status != SubtaskStatus.FAILED:
            metric_query = metric_query.filter(model.status == SubtaskStatus.FAILED)
        queue_bulk_sharded_subtask_status_metrics(
            db,
            metric_query.all(),
            status=status,
        )

    def _get_shard_subtask_by_id(self, db: Session, subtask_id: int) -> Subtask | None:
        model = subtask_model_for_subtask_id(subtask_id)
        return db.query(model).filter(model.id == subtask_id).first()

    def _get_migrated_legacy_subtask_by_id(
        self,
        db: Session,
        *,
        subtask_id: int,
        owner_user_id: int | None = None,
    ) -> Subtask | None:
        index_row = db.query(Subtask.task_id).filter(Subtask.id == subtask_id).first()
        if index_row is None:
            return None

        model = self._subtask_model_for_task_lookup(
            db,
            task_id=int(index_row[0]),
            owner_user_id=owner_user_id,
        )
        if model is Subtask:
            return None
        return db.query(model).filter(model.id == subtask_id).first()

    def _subtask_model_for_task_lookup(
        self,
        db: Session,
        *,
        task_id: int,
        owner_user_id: int | None,
    ) -> type:
        if is_new_task_id(task_id):
            return subtask_model_for_task_id(task_id)

        owner_id = self._legacy_task_owner_user_id(
            db,
            task_id=task_id,
            owner_user_id=owner_user_id,
        )
        if owner_id is None:
            return Subtask

        task_model = task_model_for_user(owner_id)
        migrated_task_exists = (
            db.query(task_model.id).filter(task_model.id == task_id).first() is not None
        )
        return subtask_model_for_owner(owner_id) if migrated_task_exists else Subtask

    def _task_uses_subtask_shard(self, db: Session, task_id: int) -> bool:
        return (
            self._subtask_model_for_task_lookup(
                db,
                task_id=task_id,
                owner_user_id=None,
            )
            is not Subtask
        )

    def _legacy_task_owner_user_id(
        self,
        db: Session,
        *,
        task_id: int,
        owner_user_id: int | None,
    ) -> int | None:
        query = db.query(TaskResource.user_id).filter(TaskResource.id == task_id)
        if owner_user_id is not None:
            query = query.filter(TaskResource.user_id == owner_user_id)
        row = query.first()
        return int(row[0]) if row is not None else None

    def _scan_subtask_tables(
        self,
        db: Session,
        query_factory: Callable[[Any, type], Any],
    ) -> list[Any]:
        rows = query_factory(db.query(Subtask), Subtask).all()
        for model in self._all_shard_subtask_models():
            rows.extend(query_factory(db.query(model), model).all())
        return rows

    def _all_shard_subtask_models(self) -> list[type]:
        return [
            subtask_model_for_task_id(self._representative_new_task_id(slot))
            for slot in range(SHARD_COUNT)
        ]

    def _representative_new_task_id(self, slot: int) -> int:
        # Generate a new-format (uid+reserved+seq) ID where uid maps to slot so that
        # uid_from_id(...) % SHARD_COUNT == slot, routing to the correct shard table.
        from wecode.task_sharding.uuid_factory.user_scoped_id_factory import (
            encode_user_scoped_id,
        )

        representative_uid = slot if slot > 0 else SHARD_COUNT
        return encode_user_scoped_id(representative_uid, 1)

    def _attach_contexts(self, db: Session, subtasks: list[Subtask]) -> None:
        subtask_ids = [subtask.id for subtask in subtasks]
        if not subtask_ids:
            return

        contexts = (
            db.query(SubtaskContext)
            .filter(SubtaskContext.subtask_id.in_(subtask_ids))
            .order_by(SubtaskContext.id.asc())
            .all()
        )
        contexts_by_subtask_id: dict[int, list[SubtaskContext]] = {}
        for context in contexts:
            contexts_by_subtask_id.setdefault(context.subtask_id, []).append(context)
        for subtask in subtasks:
            subtask.contexts = contexts_by_subtask_id.get(subtask.id, [])

    def _bulk_task_ids_by_storage(
        self,
        db: Session,
        task_ids: Sequence[int],
        *,
        owner_user_id: int | None,
    ) -> tuple[list[int], list[int]]:
        legacy_task_ids: list[int] = []
        new_task_ids: list[int] = []
        seen_task_ids: set[int] = set()
        for task_id in task_ids:
            if task_id in seen_task_ids:
                continue
            seen_task_ids.add(task_id)
            if not is_new_task_id(task_id):
                legacy_task_ids.append(task_id)
            elif self._owner_matches_task_id(db, task_id, owner_user_id):
                new_task_ids.append(task_id)
        return legacy_task_ids, new_task_ids

    def _owner_matches_task_id(
        self, db: Session, task_id: int, owner_user_id: int | None
    ) -> bool:
        if owner_user_id is None:
            return True

        task_model = task_model_for_task_id(task_id)
        task_exists = (
            db.query(task_model.id)
            .filter(
                task_model.id == task_id,
                task_model.user_id == owner_user_id,
            )
            .first()
            is not None
        )
        if task_exists:
            return True

        subtask_model = subtask_model_for_task_id(task_id)
        subtask_user_ids = (
            db.query(subtask_model.user_id)
            .filter(subtask_model.task_id == task_id)
            .distinct()
            .limit(2)
            .all()
        )
        return len(subtask_user_ids) == 1 and subtask_user_ids[0][0] == owner_user_id

    def _owner_matches_subtask_id(
        self, db: Session, subtask_id: int, owner_user_id: int | None
    ) -> bool:
        if owner_user_id is None:
            return True

        subtask = self._get_shard_subtask_by_id(db, subtask_id)
        if subtask is None:
            return False
        return self._owner_matches_task_id(db, subtask.task_id, owner_user_id)
