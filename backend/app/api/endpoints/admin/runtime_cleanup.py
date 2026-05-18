# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Admin runtime cleanup endpoints."""

from typing import Any, Dict, List, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_admin_user
from app.db.session import get_async_db
from app.models.user import User
from app.services.adapters.executor_job import job_service
from app.services.execution import get_executor_runtime_client

router = APIRouter()

CleanupTarget = Literal["task_executors", "sandboxes"]


class RuntimeCleanupRequest(BaseModel):
    """Request body for stale runtime cleanup."""

    inactive_hours: int = Field(default=24, ge=1, le=720)
    targets: List[CleanupTarget] = Field(
        default_factory=lambda: ["task_executors", "sandboxes"]
    )
    dry_run: bool = False


@router.post("/runtime-cleanup/stale", response_model=Dict[str, Any])
async def cleanup_stale_runtimes(
    request: RuntimeCleanupRequest,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_admin_user),
):
    """Clean up stale task executor and sandbox runtimes."""
    results: Dict[str, Any] = {}

    if "task_executors" in request.targets:
        results["task_executors"] = await job_service.cleanup_stale_task_executors(
            db=db,
            inactive_hours=request.inactive_hours,
            dry_run=request.dry_run,
        )

    if "sandboxes" in request.targets:
        runtime_client = get_executor_runtime_client()
        results["sandboxes"] = await runtime_client.cleanup_stale_sandboxes(
            inactive_hours=request.inactive_hours,
            dry_run=request.dry_run,
        )

    return {
        "inactive_hours": request.inactive_hours,
        "dry_run": request.dry_run,
        "requested_by": current_user.id,
        "results": results,
    }
