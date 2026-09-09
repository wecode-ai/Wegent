# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Cancel operation utilities for Chat Service.

This module provides utilities for cancelling chat streams and updating
subtask status on cancellation.
"""

import logging
from datetime import datetime, timezone
from typing import Any, List, Optional

from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.session import SessionLocal
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.schemas.kind import Task
from app.stores.tasks import subtask_store, task_store

logger = logging.getLogger(__name__)


async def cancel_chat_stream(
    subtask_id: int,
    shell_type: Optional[str] = None,
    stream_versions: Optional[dict] = None,
) -> None:
    """
    Cancel a chat stream based on shell type.

    For Chat Shell tasks, uses session_manager.
    For Executor tasks, calls executor_manager API.

    Args:
        subtask_id: Subtask ID to cancel
        shell_type: Shell type (e.g., "Chat", "ClaudeCode")
        stream_versions: Dict mapping subtask_id to stream version ("v1" or "v2")
    """
    is_chat_shell = shell_type == "Chat" if shell_type else False

    if is_chat_shell:
        # For Chat Shell tasks, determine which session_manager to use
        stream_version = (
            stream_versions.get(subtask_id, "v1") if stream_versions else "v1"
        )

        if stream_version == "v2":
            logger.info(f"Using chat session_manager (v2) for subtask_id={subtask_id}")
            from app.services.chat.storage import session_manager as session_manager_v2

            await session_manager_v2.cancel_stream(subtask_id)
        else:
            logger.info(f"Using chat session_manager (v1) for subtask_id={subtask_id}")
            from app.services.chat.storage import session_manager

            await session_manager.cancel_stream(subtask_id)
    else:
        # For Executor tasks, call executor_manager API
        # Get task_id from subtask
        from app.services.chat.operations.executor import call_executor_cancel

        db = SessionLocal()
        try:
            subtask = subtask_store.get_by_id(db, subtask_id=subtask_id)
            if subtask:
                await call_executor_cancel(subtask.task_id)
        finally:
            db.close()


def update_subtask_on_cancel(
    db: Session,
    subtask: Subtask,
    partial_content: Optional[str] = None,
    result: Optional[dict[str, Any]] = None,
) -> None:
    """
    Update subtask status and result on cancellation.

    Args:
        db: Database session
        subtask: Subtask to update
        partial_content: Optional partial content to save
        result: Optional full result payload collected from streaming state
    """
    now = datetime.now()
    result_payload = result if result is not None else {"value": partial_content or ""}
    subtask_store.update_fields(
        db,
        subtask=subtask,
        status=SubtaskStatus.CANCELLED,
        progress=100,
        completed_at=now,
        updated_at=now,
        result=result_payload,
    )


def update_task_on_cancel(db: Session, task: TaskResource) -> None:
    """
    Update task status on cancellation.

    Args:
        db: Database session
        task: Task to update
    """
    task_crd = Task.model_validate(task.json)
    if task_crd.status:
        task_crd.status.status = "CANCELLED"
        task_crd.status.errorMessage = ""
        task_crd.status.updatedAt = datetime.now()
        task_crd.status.completedAt = datetime.now()

    task_store.update_json(db, task=task, payload=task_crd.model_dump(mode="json"))


_TASK_FINAL_STATES = ("COMPLETED", "FAILED", "CANCELLED", "DELETE")


async def is_stream_alive(task_id: int, subtask_id: Optional[int] = None) -> bool:
    """
    Return True when a runtime consumer is still streaming for this task.

    Healthy streams refresh the task streaming key roughly every second via
    StatusUpdatingEmitter, so a missing key, a different subtask owning the
    key, or a stale last_activity_at means the consumer is gone and no
    terminal callback will ever arrive.

    Args:
        task_id: Task ID to check
        subtask_id: When given, the key must belong to this subtask

    Returns:
        True if streaming activity is fresh, False otherwise
    """
    from app.services.chat.storage import session_manager

    status = await session_manager.get_task_streaming_status(task_id)
    if not status:
        return False
    if subtask_id is not None and status.get("subtask_id") != subtask_id:
        return False
    last_activity_raw = status.get("last_activity_at")
    if not last_activity_raw:
        return False
    try:
        last_activity = datetime.fromisoformat(str(last_activity_raw))
    except ValueError:
        return False
    if last_activity.tzinfo is None:
        last_activity = last_activity.replace(tzinfo=timezone.utc)
    idle_seconds = (datetime.now(timezone.utc) - last_activity).total_seconds()
    return idle_seconds <= settings.CANCELLING_STUCK_TIMEOUT_SECONDS


def finalize_stuck_cancellation(db: Session, *, task_id: int) -> List[int]:
    """
    Finalize cancellation locally when no runtime callback will arrive.

    Marks non-final assistant subtasks CANCELLED and the task CANCELLED.
    Used when the streaming runtime is dead (e.g. backend restart) and the
    task would otherwise remain in CANCELLING forever.

    Args:
        db: Database session
        task_id: Task ID to finalize

    Returns:
        IDs of subtasks marked CANCELLED. Empty when the task was already in
        a final state.
    """
    task = task_store.get_regular_active_task(db, task_id=task_id)
    if not task or not task.json:
        return []

    task_crd = Task.model_validate(task.json)
    if task_crd.status and task_crd.status.status in _TASK_FINAL_STATES:
        return []

    finalized: List[int] = []
    stuck_subtasks = subtask_store.list_by_task_statuses(
        db,
        task_id=task_id,
        statuses=[SubtaskStatus.PENDING, SubtaskStatus.RUNNING],
    )
    for subtask in stuck_subtasks:
        if subtask.role != SubtaskRole.ASSISTANT:
            continue
        update_subtask_on_cancel(db, subtask)
        finalized.append(subtask.id)

    update_task_on_cancel(db, task)
    db.commit()

    logger.warning(
        "Finalized stuck cancellation locally: task_id=%s, subtask_ids=%s",
        task_id,
        finalized,
    )
    return finalized


async def publish_task_cancelled_events(
    task_id: int, subtask_ids: List[int], user_id: int
) -> None:
    """
    Publish TaskCompletedEvent(CANCELLED) for locally finalized cancellations.

    Lets downstream projections (board team, subscriptions) react exactly as
    if the runtime had delivered the cancellation callback itself.
    """
    from app.core.events import TaskCompletedEvent, get_event_bus

    event_bus = get_event_bus()
    for subtask_id in subtask_ids:
        try:
            await event_bus.publish(
                TaskCompletedEvent(
                    task_id=task_id,
                    subtask_id=subtask_id,
                    user_id=user_id,
                    status="CANCELLED",
                )
            )
        except Exception as e:
            logger.error(
                f"Failed to publish TaskCompletedEvent for finalized cancel: "
                f"task_id={task_id}, subtask_id={subtask_id}, error={e}"
            )
