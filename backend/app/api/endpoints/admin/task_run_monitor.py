# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Administrator endpoints for task run monitoring."""

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_admin_user
from app.models.user import User
from app.schemas.admin_task_runs import TaskRunStatsResponse
from app.services.admin_task_run_stats import get_task_run_stats

router = APIRouter(prefix="/task-runs")


@router.get("/stats", response_model=TaskRunStatsResponse)
async def get_admin_task_run_stats(
    hours: int = Query(24, ge=1, le=24 * 30),
    failure_reason_limit: int = Query(10, ge=1, le=50),
    recent_failure_limit: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
) -> TaskRunStatsResponse:
    """Return run status counts and failure details for all users' tasks."""
    return get_task_run_stats(
        db,
        hours=hours,
        failure_reason_limit=failure_reason_limit,
        recent_failure_limit=recent_failure_limit,
    )
