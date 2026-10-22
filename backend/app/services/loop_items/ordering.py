# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""One persisted sibling order shared by every board grouping."""

from fastapi import HTTPException
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.models.delivery import LoopItem, loop_datetime_is_unset
from app.schemas.loop_item_position import LoopItemPosition


def sibling_items(
    db: Session, project_id: str, parent_id: str | None
) -> list[LoopItem]:
    parent_filter = (
        LoopItem.parent_id == parent_id
        if parent_id
        else or_(LoopItem.parent_id.is_(None), LoopItem.parent_id == "")
    )
    return (
        db.query(LoopItem)
        .filter(
            LoopItem.cloud_project_id == project_id,
            parent_filter,
            loop_datetime_is_unset(LoopItem.deleted_at),
        )
        .order_by(LoopItem.sort_order, LoopItem.updated_at.desc(), LoopItem.id)
        .with_for_update()
        .all()
    )


def position_siblings(
    db: Session,
    item: LoopItem,
    parent_id: str | None,
    position: LoopItemPosition,
) -> list[LoopItem]:
    siblings = [
        sibling
        for sibling in sibling_items(db, item.cloud_project_id, parent_id)
        if sibling.id != item.id
    ]
    anchor = position.before_item_id
    index = next(
        (index for index, sibling in enumerate(siblings) if sibling.id == anchor),
        len(siblings) if anchor is None else -1,
    )
    if index < 0:
        raise HTTPException(422, "Position anchor is not an active sibling")
    siblings.insert(index, item)
    return siblings


def persist_sibling_order(
    siblings: list[LoopItem], *, updated_item_id: str | None = None
) -> None:
    for position, item in enumerate(siblings):
        if item.sort_order != position:
            item.sort_order = position
            if item.id != updated_item_id:
                item.version += 1
