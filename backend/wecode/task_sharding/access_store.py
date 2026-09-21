from __future__ import annotations

from typing import Any

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.models.task import TaskResource
from app.stores.tasks.interfaces import TaskRuntimeState
from app.stores.tasks.sqlalchemy_access_store import SqlAlchemyTaskAccessStore
from wecode.task_sharding.shard import task_model_for_task_id
from wecode.task_sharding.task_id import is_new_task_id
from wecode.task_sharding.task_store import ShardedTaskStore


class ShardedTaskAccessStore(SqlAlchemyTaskAccessStore):
    def __init__(self, *, task_store: ShardedTaskStore | None = None) -> None:
        self.task_store = task_store or ShardedTaskStore()

    def _get_accessible_task(self, db: Session, *, task_id: int) -> Any | None:
        if not is_new_task_id(task_id):
            return super()._get_accessible_task(db, task_id=task_id)
        return self.task_store.get_active_task(db, task_id=task_id)

    def get_runtime_state(
        self, db: Session, *, task_id: int, user_id: int
    ) -> TaskRuntimeState | None:
        if not is_new_task_id(task_id):
            return super().get_runtime_state(db, task_id=task_id, user_id=user_id)

        model = task_model_for_task_id(task_id)
        task_status = model.json["status"]["status"].as_string()
        status_updated_at = model.json["status"]["updatedAt"].as_string()
        membership = self._approved_membership_query(
            db, task_id=task_id, user_id=user_id
        ).exists()
        row = (
            db.query(task_status, status_updated_at, model.updated_at)
            .filter(
                model.id == task_id,
                model.kind == "Task",
                model.is_active.in_(TaskResource.is_active_query()),
                task_status != "DELETE",
                or_(model.user_id == user_id, membership),
            )
            .first()
        )
        if row is None:
            return None
        return TaskRuntimeState(status=row[0], updated_at=row[1] or row[2])
