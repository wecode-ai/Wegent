# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Task-scoped projections and pages shared by base and routed stores."""

from typing import Any, Iterator, Optional

from sqlalchemy import func
from sqlalchemy.orm import Query, Session, load_only

from app.models.subtask import Subtask, SubtaskStatus

RUNTIME_READ_BATCH_SIZE = 100


class SubtaskRuntimeReads:
    """Reuse the deployment's model and owner-scoped query for ancillary reads."""

    def _runtime_read_query(
        self, db: Session, task_id: int, owner_user_id: Optional[int]
    ) -> tuple[Any, Query]:
        raise NotImplementedError

    def ids_query_by_task(
        self,
        db: Session,
        *,
        task_id: int,
        owner_user_id: Optional[int] = None,
        user_id: Optional[int] = None,
    ) -> Query:
        """Keep attachment membership inside SQL instead of hydrating history."""
        model, query = self._runtime_read_query(db, task_id, owner_user_id)
        if user_id is not None:
            query = query.filter(model.user_id == user_id)
        return query.with_entities(model.id)

    def list_visible_history_page(
        self,
        db: Session,
        *,
        task_id: int,
        owner_user_id: int,
        limit: Optional[int],
        offset: int,
    ) -> tuple[list[Subtask], int]:
        """Count visible messages, then hydrate only the requested page."""
        model, query = self._runtime_read_query(db, task_id, owner_user_id)
        query = query.filter(model.status != SubtaskStatus.DELETE)
        total = query.with_entities(func.count(model.id)).scalar()
        if limit is not None and limit <= 0:
            return [], total
        page = query.order_by(
            model.message_id.asc(), model.created_at.asc(), model.id.asc()
        ).offset(max(0, offset))
        if limit is not None:
            page = page.limit(limit)
        return page.all(), total

    def iter_runtime_cleanup_rows(
        self, db: Session, *, task_id: int, owner_user_id: int
    ) -> Iterator[Subtask]:
        """Read executor references in keyset pages without prompt/result payloads."""
        model, query = self._runtime_read_query(db, task_id, owner_user_id)
        query = query.filter(model.executor_deleted_at == False).options(
            load_only(
                model.id,
                model.task_id,
                model.user_id,
                model.executor_name,
                model.executor_namespace,
                model.executor_deleted_at,
                raiseload=True,
            )
        )
        after_id = None
        while True:
            page = query
            if after_id is not None:
                page = page.filter(model.id > after_id)
            rows = page.order_by(model.id).limit(RUNTIME_READ_BATCH_SIZE).all()
            if not rows:
                return
            after_id = rows[-1].id
            yield from rows
