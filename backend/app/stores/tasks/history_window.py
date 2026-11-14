# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Select a global fork window before loading any full subtask payloads."""

from collections import defaultdict
from dataclasses import dataclass
from typing import Any, Callable, Optional, Sequence

from sqlalchemy.orm import Session

from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.stores.tasks.history_checkpoint import summary_checkpoint_predicate


@dataclass(frozen=True)
class HistoryTaskWindow:
    task_id: int
    owner_user_id: int
    before_message_id: Optional[int] = None


def load_history_window(
    db: Session,
    *,
    queries: Sequence[tuple[type, Any]],
    limit: int,
    load_payloads: Callable[[Session, type, list[int]], list[Subtask]],
    statuses: Optional[Sequence[SubtaskStatus]] = None,
    roles: Optional[Sequence[SubtaskRole]] = None,
    after_message_id: Optional[int] = None,
    summary_checkpoint_only: bool = False,
) -> list[Subtask]:
    """Read at most limit narrow candidates per node, then limit payloads total."""
    if (
        limit <= 0
        or (statuses is not None and not statuses)
        or (roles is not None and not roles)
    ):
        return []
    candidates = []
    for model, query in queries:
        if statuses is not None:
            query = query.filter(model.status.in_(statuses))
        if roles is not None:
            query = query.filter(model.role.in_(roles))
        if after_message_id is not None:
            query = query.filter(model.message_id > after_message_id)
        if summary_checkpoint_only:
            query = query.filter(summary_checkpoint_predicate(db, model))
        rows = (
            query.with_entities(model.id, model.message_id, model.created_at)
            .order_by(model.message_id.desc(), model.created_at.desc(), model.id.desc())
            .limit(limit)
            .all()
        )
        candidates.extend(
            (message, created, subtask_id, model)
            for subtask_id, message, created in rows
        )
    candidates.sort(key=lambda row: row[:3])
    selected = candidates[-limit:]
    ids_by_model = defaultdict(list)
    for _, _, subtask_id, model in selected:
        ids_by_model[model].append(subtask_id)
    loaded = {
        (model, subtask.id): subtask
        for model, ids in ids_by_model.items()
        for subtask in load_payloads(db, model, ids)
    }
    return [
        loaded[(model, subtask_id)]
        for _, _, subtask_id, model in selected
        if (model, subtask_id) in loaded
    ]
