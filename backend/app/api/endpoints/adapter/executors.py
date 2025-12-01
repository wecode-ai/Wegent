# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.schemas.subtask import SubtaskExecutorUpdate
from app.services.adapters.executor_kinds import executor_kinds_service

router = APIRouter()


@router.post("/tasks/dispatch")
async def dispatch_tasks(
    task_status: str = Query(
        default="PENDING", description="Subtask status to filter by"
    ),
    limit: int = Query(
        default=1, ge=1, description="Maximum number of subtasks to return"
    ),
    task_ids: Optional[str] = Query(
        default=None, description="Optional task IDs to filter by, comma separated"
    ),
    type: str = Query(default="online", description="online or offline"),
    db: Session = Depends(get_db),
):
    """Task dispatch interface with subtask support using kinds table

    Args:
        status: Subtask status to filter by (PENDING, RUNNING, COMPLETED, FAILED, CANCELLED, DELETE)
        limit: Maximum number of subtasks to return
        task_ids: Optional task IDs to filter by, comma separated. If not provided, will search across all tasks
        type: Task type to filter by (default: "online")

    Returns:
        List of subtasks with aggregated context from previous subtasks
    """
    # Process task_ids parameter, convert comma-separated string to integer list
    task_id_list = None
    if task_ids:
        try:
            task_id_list = [int(tid.strip()) for tid in task_ids.split(",")]
        except ValueError:
            task_id_list = None

    return await executor_kinds_service.dispatch_tasks(
        db=db, status=task_status, limit=limit, task_ids=task_id_list, type=type
    )


@router.put("/tasks")
async def update_subtask(
    subtask_update: SubtaskExecutorUpdate, db: Session = Depends(get_db)
):
    """Update subtask status and automatically update associated task using kinds table

    Args:
        subtask_update: Subtask update information including status, progress, result, etc.

    Returns:
        Updated subtask information and task status
    """
    return await executor_kinds_service.update_subtask(
        db=db, subtask_update=subtask_update
    )
