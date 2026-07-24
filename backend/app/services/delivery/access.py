# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Authorization rules for cloud TODO delivery data."""

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.delivery import LoopItem
from app.schemas.base_role import BaseRole
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
    require_cloud_project_role(db, item.cloud_project_id, user_id, required_role)
    return item
