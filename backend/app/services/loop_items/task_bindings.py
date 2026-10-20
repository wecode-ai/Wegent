# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Query active Runtime session bindings through their owner's device identity."""

from sqlalchemy import and_, false, or_
from sqlalchemy.orm import Query, Session

from app.models.delivery import LoopItemTaskBinding, loop_datetime_is_unset
from app.services.device.identity import owned_device_aliases


def active_task_binding_query(
    db: Session,
    *,
    device_id: str,
    task_id: str,
    user_id: int | None = None,
    project_id: str | int | None = None,
    item_id: str | None = None,
    lock: bool = False,
) -> Query[LoopItemTaskBinding]:
    """Keep identity expansion user-scoped, including shared project reads."""

    if user_id is None and (project_id is None or item_id is None):
        raise ValueError("An owner or exact project Issue scope is required")
    query = db.query(LoopItemTaskBinding).filter(
        LoopItemTaskBinding.task_id == task_id,
        loop_datetime_is_unset(LoopItemTaskBinding.unlinked_at),
        loop_datetime_is_unset(LoopItemTaskBinding.deleted_at),
    )
    if project_id is not None:
        query = query.filter(LoopItemTaskBinding.cloud_project_id == project_id)
    if item_id is not None:
        query = query.filter(LoopItemTaskBinding.loop_item_id == item_id)
    owners = (
        [user_id]
        if user_id is not None
        else [
            row[0]
            for row in query.with_entities(LoopItemTaskBinding.task_user_id).distinct()
        ]
    )
    matches = [
        and_(
            LoopItemTaskBinding.task_user_id == owner,
            LoopItemTaskBinding.device_id.in_(
                owned_device_aliases(db, user_id=owner, device_id=device_id)
            ),
        )
        for owner in owners
        if owner is not None
    ]
    query = query.filter(or_(*matches) if matches else false()).order_by(
        LoopItemTaskBinding.linked_at.desc(), LoopItemTaskBinding.id.desc()
    )
    return query.with_for_update() if lock else query
