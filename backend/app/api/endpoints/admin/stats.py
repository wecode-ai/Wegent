# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Admin system statistics endpoints."""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_admin_user
from app.models.kind import Kind
from app.models.user import User
from app.schemas.admin import SystemStats

router = APIRouter()


@router.get("/stats", response_model=SystemStats)
async def get_system_stats(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
):
    """
    Get system statistics
    """
    from app.models.task import Task

    total_users = db.query(User).count()
    active_users = db.query(User).filter(User.is_active == True).count()
    admin_count = (
        db.query(User).filter(User.role == "admin", User.is_active == True).count()
    )
    total_tasks = db.query(Task).count()
    total_public_models = (
        db.query(Kind)
        .filter(Kind.user_id == 0, Kind.kind == "Model", Kind.namespace == "default")
        .count()
    )

    return SystemStats(
        total_users=total_users,
        active_users=active_users,
        admin_count=admin_count,
        total_tasks=total_tasks,
        total_public_models=total_public_models,
    )
