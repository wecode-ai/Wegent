# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Merge currently eligible human reviews into the bounded My Work result."""

from datetime import datetime

from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from app.models.delivery import LoopItem, loop_datetime_is_unset
from app.services.human_issue_work import human_issue_work_service

REVIEW_BATCH_SIZE = 100


def include_review_items(
    db: Session,
    user_id: int,
    project_ids: list[str],
    items: list[LoopItem],
    limit: int,
) -> list[LoopItem]:
    query = db.query(LoopItem).filter(
        LoopItem.cloud_project_id.in_(project_ids),
        LoopItem.status == "in_review",
        LoopItem.metadata_json["human_work"]["state"].as_string() == "submitted",
        loop_datetime_is_unset(LoopItem.deleted_at),
    )
    items = sorted(items, key=lambda item: (item.updated_at, item.id), reverse=True)
    known_ids = {item.id for item in items}
    cursor: tuple[datetime, str] | None = None
    while True:
        batch_query = query
        if cursor is not None:
            batch_query = batch_query.filter(
                or_(
                    LoopItem.updated_at < cursor[0],
                    and_(LoopItem.updated_at == cursor[0], LoopItem.id < cursor[1]),
                )
            )
        batch = (
            batch_query.order_by(LoopItem.updated_at.desc(), LoopItem.id.desc())
            .limit(REVIEW_BATCH_SIZE)
            .all()
        )
        for candidate in batch:
            # Later candidates cannot displace the oldest retained result.
            if len(items) == limit and (candidate.updated_at, candidate.id) <= (
                items[-1].updated_at,
                items[-1].id,
            ):
                return items
            if candidate.id in known_ids:
                continue
            # Assignment and permissions are live; the stored reviewer may have
            # lost access, activating Owner/Maintainer fallback instead.
            view = human_issue_work_service.view(db, candidate, user_id)
            if view is not None and view["can_review"]:
                known_ids.add(candidate.id)
                items.append(candidate)
                items.sort(key=lambda item: (item.updated_at, item.id), reverse=True)
                items = items[:limit]
        if len(batch) < REVIEW_BATCH_SIZE:
            return items
        cursor = (batch[-1].updated_at, batch[-1].id)
