# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Authorization rules for cloud TODO delivery data."""

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.delivery import LoopItem
from app.schemas.base_role import BaseRole, has_permission
from app.services.cloud_projects.access import require_cloud_project_role


def require_loop_item_access(
    db: Session,
    item_id: str,
    user_id: int,
    required_role: BaseRole = BaseRole.Reporter,
) -> LoopItem:
    item = db.query(LoopItem).filter(LoopItem.id == item_id).first()
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "TODO not found")
    access = require_cloud_project_role(
        db, item.cloud_project_id, user_id, BaseRole.RestrictedAnalyst
    )
    if access.is_public_visitor:
        if item.created_by_user_id != user_id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "TODO not found")
    elif not has_permission(access.role, required_role):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Insufficient permission")
    return item
