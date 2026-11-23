# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Task-scoped projections and pages shared by base and routed stores."""

from typing import Any, Iterator, Optional

from sqlalchemy import Text, cast, func, or_
from sqlalchemy.orm import Query, Session, load_only

from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus

RUNTIME_READ_BATCH_SIZE = 100
FORM_READ_BATCH_SIZE = 50


def _form_position(model: Any, position: Any, *, newer: bool) -> Any:
    """Match message/id ordering including the legacy nullable message column."""
    if position.message_id is None:
        same_message = model.message_id.is_(None)
        other_messages = model.message_id.is_not(None) if newer else False
    else:
        same_message = model.message_id == position.message_id
        other_messages = (
            model.message_id > position.message_id
            if newer
            else or_(model.message_id < position.message_id, model.message_id.is_(None))
        )
    same_message_id = model.id > position.id if newer else model.id < position.id
    return or_(other_messages, same_message & same_message_id)


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
        bounded_payload_sort: bool = False,
    ) -> tuple[list[Subtask], int]:
        """Count visible messages, then hydrate only the requested page."""
        model, query = self._runtime_read_query(db, task_id, owner_user_id)
        query = query.filter(model.status != SubtaskStatus.DELETE)
        total = query.with_entities(func.count(model.id)).scalar()
        if limit is not None and limit <= 0:
            return [], total
        if bounded_payload_sort:
            selected = (
                query.with_entities(model.id)
                .order_by(
                    model.message_id.asc(), model.created_at.asc(), model.id.asc()
                )
                .offset(max(0, offset))
                .limit(limit)
                .subquery()
            )
            rows = query.join(selected, model.id == selected.c.id).all()
            rows.sort(
                key=lambda row: (
                    row.message_id is not None,
                    row.message_id or 0,
                    row.created_at is not None,
                    row.created_at,
                    row.id,
                )
            )
            return rows, total
        page = query.order_by(
            model.message_id.asc(), model.created_at.asc(), model.id.asc()
        ).offset(max(0, offset))
        if limit is not None:
            page = page.limit(limit)
        return page.all(), total

    def iter_pending_form_candidates(
        self, db: Session, *, task_id: int, owner_user_id: int
    ) -> Iterator[Any]:
        """Page only potential form blocks newer than the last user message."""
        model, query = self._runtime_read_query(db, task_id, owner_user_id)
        latest_user = (
            query.with_entities(model.message_id, model.id)
            .filter(model.role == SubtaskRole.USER)
            .order_by(model.message_id.desc(), model.id.desc())
            .limit(1)
            .first()
        )
        blocks = model.result["blocks"].as_json()
        candidates = query.with_entities(model.id).filter(
            model.role == SubtaskRole.ASSISTANT,
            cast(blocks, Text).contains("interactive_form_question"),
        )
        if latest_user is not None:
            candidates = candidates.filter(
                _form_position(model, latest_user, newer=True)
            )
        after = None
        while True:
            page = candidates
            if after is not None:
                page = page.filter(_form_position(model, after, newer=False))
            selected = (
                page.order_by(model.message_id.desc(), model.id.desc())
                .limit(FORM_READ_BATCH_SIZE)
                .subquery()
            )
            rows = (
                query.with_entities(model.id, model.message_id, blocks.label("blocks"))
                .join(selected, model.id == selected.c.id)
                .all()
            )
            if not rows:
                return
            rows.sort(
                key=lambda row: (
                    row.message_id is not None,
                    row.message_id or 0,
                    row.id,
                ),
                reverse=True,
            )
            after = rows[-1]
            yield from rows

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
