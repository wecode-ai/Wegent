# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Cancellation for turns placed on a traditional device."""

import logging
from datetime import datetime
from typing import Any, Callable

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.subtask import SubtaskStatus
from app.models.task import TaskResource
from app.schemas.kind import Task
from app.services.chat.operations.cancel import (
    is_cancellation_stuck,
    publish_task_cancelled_events,
    update_subtask_on_cancel,
    update_task_on_cancel,
)
from app.services.chat.storage import session_manager
from app.stores.tasks import subtask_store, task_store
from shared.models import EventType, ExecutionEvent
from shared.telemetry.decorators import trace_async

logger = logging.getLogger(__name__)
_ACTIVE_SUBTASK_STATUSES = (SubtaskStatus.PENDING, SubtaskStatus.RUNNING)


async def cancel_device_task(
    db: Session,
    *,
    task_id: int,
    device_id: str,
    background_task_runner: Callable[..., Any] | None,
) -> dict[str, str]:
    """Accept cancellation for the current turn of an authorized task."""
    task = task_store.get_by_id_for_update(db, task_id=task_id)
    if not task or not task.json or task.is_active != TaskResource.STATE_ACTIVE:
        raise HTTPException(status_code=404, detail="Task not found")

    resource = Task.model_validate(task.json)
    task_status = resource.status
    if task_status is None:
        db.rollback()
        raise HTTPException(status_code=400, detail="Task status is unavailable")
    status = task_status.status
    if status not in ("PENDING", "RUNNING", "CANCELLING"):
        db.rollback()
        raise HTTPException(
            status_code=400,
            detail=f"Task is already {str(status).lower()}, cannot cancel",
        )
    if status == "CANCELLING" and not is_cancellation_stuck(task_status.updatedAt):
        db.rollback()
        return {"message": "Task is already being cancelled", "status": "CANCELLING"}

    # Task access grants cancellation of the current assistant turn. Route
    # delivery under the turn's execution identity, independently of the caller.
    subtask = subtask_store.get_latest_assistant_by_statuses(
        db, task_id=task_id, statuses=_ACTIVE_SUBTASK_STATUSES, for_update=True
    )
    if subtask is None:
        update_task_on_cancel(db, task)
        db.commit()
        return {"message": "Task cancellation finalized", "status": "CANCELLED"}

    subtask_id, execution_user_id = subtask.id, subtask.user_id
    if status == "CANCELLING":
        db.rollback()
        if await _finalize_missed_device_cancel(task_id, subtask_id):
            return {"message": "Task cancellation finalized", "status": "CANCELLED"}
        return {"message": "Task is already being cancelled", "status": "CANCELLING"}

    task_status.status = "CANCELLING"
    task_status.errorMessage = ""
    task_status.updatedAt = datetime.now()
    task_status.completedAt = None
    task_store.update_json(db, task=task, payload=resource.model_dump(mode="json"))
    db.commit()
    args = (task_id, subtask_id, execution_user_id, device_id)
    if background_task_runner:
        background_task_runner(_call_device_cancel, *args)
    else:
        await _call_device_cancel(*args)
    return {"message": "Cancel request accepted", "status": "CANCELLING"}


@trace_async("task.cancel_device", "backend.execution")
async def _call_device_cancel(
    task_id: int, subtask_id: int, execution_user_id: int, device_id: str
) -> None:
    """Send cancellation to the device executing the accepted turn."""
    from app.core.socketio import get_sio
    from app.db.session import SessionLocal
    from app.services.device.runtime_route import runtime_route_resolver

    try:
        with SessionLocal() as db:
            subtask = subtask_store.get_basic_by_id(db, subtask_id=subtask_id)
            if (
                subtask is None
                or subtask.task_id != task_id
                or subtask.status not in _ACTIVE_SUBTASK_STATUSES
            ):
                return
            running = subtask.status == SubtaskStatus.RUNNING
        if running:
            route = await runtime_route_resolver.resolve(
                user_id=execution_user_id, submitted_device_id=device_id
            )
            await get_sio().emit(
                "task:cancel",
                {"task_id": task_id, "subtask_id": subtask_id},
                room=f"device:{execution_user_id}:{route.runtime_device_id}",
                namespace="/local-executor",
            )
            return
    except Exception:
        logger.exception(
            "Device cancellation delivery failed for subtask %s", subtask_id
        )
    await _finalize_missed_device_cancel(task_id, subtask_id)


@trace_async("task.finalize_device_cancel", "backend.execution")
async def _finalize_missed_device_cancel(task_id: int, subtask_id: int) -> bool:
    """Settle only the original live turn and publish its saved partial output."""
    from app.db.session import SessionLocal

    try:
        partial = await session_manager.get_streaming_content(subtask_id)
        with SessionLocal() as db:
            task = task_store.get_by_id_for_update(db, task_id=task_id)
            if (
                task is None
                or task.is_active != TaskResource.STATE_ACTIVE
                or ((task.json or {}).get("status") or {}).get("status") != "CANCELLING"
            ):
                return False
            subtask = subtask_store.get_latest_assistant_by_statuses(
                db, task_id=task_id, statuses=_ACTIVE_SUBTASK_STATUSES, for_update=True
            )
            if subtask is None or subtask.id != subtask_id:
                return False
            execution_user_id = subtask.user_id
            result = dict(subtask.result or {})
            if partial is not None:
                result["value"] = partial
            result.setdefault("value", "")
            update_subtask_on_cancel(db, subtask, result=result)
            update_task_on_cancel(db, task)
            db.commit()

        await publish_task_cancelled_events(task_id, [subtask_id], execution_user_id)
        await session_manager.publish_callback_event(
            subtask_id,
            ExecutionEvent(
                type=EventType.CANCELLED.value,
                task_id=task_id,
                subtask_id=subtask_id,
                result=result,
            ),
        )
    except Exception:
        logger.exception(
            "Could not finalize device cancellation for subtask %s", subtask_id
        )
        return False
    return True
