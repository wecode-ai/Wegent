from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app.stores.tasks.sqlalchemy_access_store import SqlAlchemyTaskAccessStore
from wecode.task_sharding.task_id import is_new_task_id
from wecode.task_sharding.task_store import ShardedTaskStore


class ShardedTaskAccessStore(SqlAlchemyTaskAccessStore):
    def __init__(self, *, task_store: ShardedTaskStore | None = None) -> None:
        self.task_store = task_store or ShardedTaskStore()

    def _get_accessible_task(self, db: Session, *, task_id: int) -> Any | None:
        if not is_new_task_id(task_id):
            return super()._get_accessible_task(db, task_id=task_id)
        return self.task_store.get_active_task(db, task_id=task_id)
