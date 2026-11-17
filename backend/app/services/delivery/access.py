# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Authorization rules for cloud TODO delivery data."""

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.delivery import LoopItem
from app.schemas.base_role import BaseRole, has_permission
from app.services.loop_items.access import can_view_item, require_item_access


def require_loop_item_access(
    db: Session,
    item_id: str,
    user_id: int,
    required_role: BaseRole = BaseRole.Viewer,
) -> LoopItem:
    item = db.query(LoopItem).filter(LoopItem.id == item_id).first()
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "TODO not found")
    access = require_item_access(db, item, user_id)
    if not can_view_item(db, access, item, user_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "TODO not found")
    if not has_permission(access.role, required_role):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Insufficient permission")
    return item
