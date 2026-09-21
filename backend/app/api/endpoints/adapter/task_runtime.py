# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Lightweight task runtime checkpoints."""

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.api.dependencies import get_db, with_task_telemetry
from app.core import security
from app.models.user import User
from app.schemas.task import TaskRuntimeActiveStream, TaskRuntimeCheck
from app.services.chat.storage import session_manager
from app.stores.tasks import task_access_store
from shared.telemetry.decorators import trace_async, trace_sync

router = APIRouter()


@trace_sync(span_name="tasks.runtime_check.state", tracer_name="backend.tasks")
def load_runtime_checkpoint(
    task_id: int = Depends(with_task_telemetry),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
) -> TaskRuntimeCheck:
    """FastAPI runs this synchronous dependency in its worker thread pool."""
    state = task_access_store.get_runtime_state(
        db, task_id=task_id, user_id=current_user.id
    )
    if state is None:
        raise HTTPException(status_code=404, detail="Task not found")
    return TaskRuntimeCheck(
        task_id=task_id,
        task_status=state.status,
        status_updated_at=state.updated_at,
    )


@router.get("/{task_id}/runtime-check", response_model=TaskRuntimeCheck)
@trace_async(span_name="tasks.runtime_check", tracer_name="backend.tasks")
async def get_task_runtime_check(
    checkpoint: TaskRuntimeCheck = Depends(load_runtime_checkpoint),
) -> TaskRuntimeCheck:
    """Return state and stream cursor; recover messages through WebSocket only."""
    streaming_status = await session_manager.get_task_streaming_status(
        checkpoint.task_id
    )
    if streaming_status:
        raw_subtask_id = streaming_status.get("subtask_id")
        if raw_subtask_id is not None:
            subtask_id = int(raw_subtask_id)
            cached_content = await session_manager.get_streaming_content(subtask_id)
            checkpoint.active_stream = TaskRuntimeActiveStream(
                subtask_id=subtask_id,
                cursor=len(cached_content or ""),
                last_activity_at=(
                    datetime.fromisoformat(streaming_status["last_activity_at"])
                    if streaming_status.get("last_activity_at")
                    else None
                ),
            )
    return checkpoint
