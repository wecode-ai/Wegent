# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Default conversation groups for tasks created through external sources."""

import logging
from typing import Literal

from fastapi import HTTPException
from sqlalchemy import event, func
from sqlalchemy.orm import Query, Session, SessionTransaction

from app.core.cache import cache_manager
from app.core.config import settings
from app.models.project import Project
from app.models.user import User
from shared.telemetry.decorators import trace_sync

logger = logging.getLogger(__name__)

TASK_SOURCE_GROUP_CACHE_TTL = 3600
_PENDING_CACHE = "task_source_group_pending_cache"


def _source_groups_query(
    db: Session, user_id: int, client_origin: str, task_source: str
) -> Query:
    return db.query(Project).filter(
        Project.user_id == user_id,
        Project.client_origin == client_origin,
        Project.is_active == True,
        Project.config["taskSource"].as_string() == task_source,
    )


@event.listens_for(Session, "after_commit")
def _publish_group_cache(db: Session) -> None:
    if db.in_nested_transaction():
        return
    for key, group_id in db.info.pop(_PENDING_CACHE, {}).items():
        try:
            cache_manager.set_from_sync(
                key, group_id, expire=TASK_SOURCE_GROUP_CACHE_TTL
            )
        except Exception:
            # Cache delivery must not turn a committed task into a failed request.
            logger.exception("Failed to cache committed task source group")


@event.listens_for(Session, "after_rollback")
def _discard_group_cache(db: Session) -> None:
    db.info.pop(_PENDING_CACHE, None)


@event.listens_for(Session, "after_transaction_end")
def _clear_closed_transaction_cache(
    db: Session, transaction: SessionTransaction
) -> None:
    if transaction.parent is None:
        db.info.pop(_PENDING_CACHE, None)


@trace_sync("chat.task_source_group", "backend.chat")
def get_or_create_task_source_group(
    db: Session,
    *,
    user_id: int,
    client_origin: str,
    task_source: Literal["api", "dingtalk"],
) -> Project:
    """Resolve the owner's source group within the task creation transaction."""
    cache_key = f"task_source_group:{task_source}:{client_origin}:{user_id}"
    cached_id = cache_manager.get_sync(cache_key)
    if type(cached_id) is int and cached_id > 0:
        # The ID is only a lookup hint: groups can be deleted or reconfigured.
        # A primary-key current read also locks the group until the task commits.
        group = (
            _source_groups_query(db, user_id, client_origin, task_source)
            .filter(Project.id == cached_id)
            .with_for_update()
            .first()
        )
        if group:
            return group

    group = _create_or_reuse_group(db, user_id, client_origin, task_source)
    db.info.setdefault(_PENDING_CACHE, {})[cache_key] = group.id
    return group


def _create_or_reuse_group(
    db: Session, user_id: int, client_origin: str, task_source: str
) -> Project:
    # Serialize creation even when no group exists yet. Locking the group query
    # also ensures a current read under MySQL's repeatable-read isolation.
    owner = db.query(User.id).filter(User.id == user_id).with_for_update().first()
    if not owner:
        raise HTTPException(status_code=404, detail="User not found")

    group = (
        _source_groups_query(db, user_id, client_origin, task_source)
        .with_for_update()
        .first()
    )
    if group:
        return group

    max_sort_order = (
        db.query(func.max(Project.sort_order))
        .filter(
            Project.user_id == user_id,
            Project.client_origin == client_origin,
            Project.is_active == True,
        )
        .scalar()
    )
    group = Project(
        user_id=user_id,
        client_origin=client_origin,
        name=settings.TASK_SOURCE_GROUP_NAMES[task_source],
        description="",
        color="",
        config={"taskSource": task_source},
        sort_order=(max_sort_order or 0) + 1,
        is_expanded=False,
        is_active=True,
    )
    db.add(group)
    db.flush()
    return group
