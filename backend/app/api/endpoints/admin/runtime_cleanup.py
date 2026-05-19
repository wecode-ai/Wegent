# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Admin runtime cleanup endpoints."""

from datetime import datetime, timezone
from typing import Any, Dict

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_admin_user
from app.db.session import get_async_db
from app.models.user import User
from app.services.adapters.executor_job import job_service
from app.services.execution import get_executor_runtime_client

router = APIRouter()


class RuntimeCleanupRequest(BaseModel):
    """Request body for stale runtime cleanup."""

    task_id: int = Field(ge=1)
    inactive_hours: int = Field(default=24, ge=1, le=720)
    dry_run: bool = False


def _format_timestamp(timestamp: float) -> str:
    """Format a Unix timestamp as an ISO string."""
    return datetime.fromtimestamp(timestamp, tz=timezone.utc).isoformat()


async def _cleanup_stale_sandbox_for_task(
    *,
    runtime_client,
    task_id: int,
    sandbox_payload: Dict[str, Any],
    inactive_hours: int,
    dry_run: bool,
) -> Dict[str, Any]:
    """Clean up one sandbox after validating its inactivity window."""
    sandbox_id = str(sandbox_payload.get("sandbox_id") or task_id)
    result: Dict[str, Any] = {
        "task_id": task_id,
        "sandbox_id": sandbox_id,
        "inactive_hours": inactive_hours,
        "dry_run": dry_run,
        "deleted": False,
        "skipped": True,
    }

    try:
        last_activity_at = float(sandbox_payload["last_activity_at"])
    except (KeyError, TypeError, ValueError):
        return {
            **result,
            "reason": "invalid_sandbox_payload",
        }

    eligible_after = last_activity_at + inactive_hours * 3600
    if datetime.now(timezone.utc).timestamp() < eligible_after:
        return {
            **result,
            "reason": "not_stale",
            "last_activity_at": _format_timestamp(last_activity_at),
            "eligible_after": _format_timestamp(eligible_after),
        }

    if dry_run:
        return {
            **result,
            "reason": "dry_run",
            "last_activity_at": _format_timestamp(last_activity_at),
        }

    deleted, error = await runtime_client.delete_sandbox(sandbox_id)
    if deleted:
        return {
            **result,
            "deleted": True,
            "skipped": False,
            "reason": "sandbox_deleted",
            "container_name": sandbox_payload.get("container_name"),
        }

    return {
        **result,
        "reason": "delete_failed",
        "error": error,
    }


@router.post("/runtime-cleanup/stale", response_model=Dict[str, Any])
async def cleanup_stale_runtimes(
    request: RuntimeCleanupRequest,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_admin_user),
):
    """Clean up stale task executor and sandbox runtimes."""
    results: Dict[str, Any] = {}

    runtime_client = get_executor_runtime_client()
    sandbox_payload, sandbox_error = await runtime_client.get_sandbox(
        str(request.task_id)
    )

    if sandbox_payload is not None:
        results["sandbox"] = await _cleanup_stale_sandbox_for_task(
            runtime_client=runtime_client,
            task_id=request.task_id,
            sandbox_payload=sandbox_payload,
            inactive_hours=request.inactive_hours,
            dry_run=request.dry_run,
        )
    else:
        if sandbox_error:
            results["sandbox"] = {
                "task_id": request.task_id,
                "deleted": False,
                "skipped": True,
                "reason": "sandbox_lookup_failed",
                "error": sandbox_error,
            }
        results["task_executor"] = await job_service.cleanup_stale_task_executor(
            db=db,
            task_id=request.task_id,
            inactive_hours=request.inactive_hours,
            dry_run=request.dry_run,
        )

    return {
        "task_id": request.task_id,
        "inactive_hours": request.inactive_hours,
        "dry_run": request.dry_run,
        "requested_by": current_user.id,
        "results": results,
    }
