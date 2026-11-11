# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Authorization rules for cloud TODO delivery data."""

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.delivery import LoopItem
from app.schemas.base_role import BaseRole, has_permission
from app.services.collaboration_container_access import (
    lock_scoped_thread,
    require_collaboration_container_access,
)
from app.services.loop_items.access import can_view_item


def require_loop_item_access(
    db: Session,
    item_id: str,
    user_id: int,
    required_role: BaseRole = BaseRole.Viewer,
) -> LoopItem:
    item = db.query(LoopItem).filter(LoopItem.id == item_id).first()
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "TODO not found")
    access = require_collaboration_container_access(
        db,
        item.cloud_project_id,
        user_id,
        BaseRole.Viewer,
        write=required_role != BaseRole.Viewer,
    )
    if required_role != BaseRole.Viewer:
        item = lock_scoped_thread(db, access.project.id, item.id)
    if not can_view_item(db, access, item, user_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "TODO not found")
    if not has_permission(access.role, required_role):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Insufficient permission")
    if required_role != BaseRole.Viewer:
        from app.services.thread_participation import require_thread_participation

        require_thread_participation(db, item, user_id)
    return item
