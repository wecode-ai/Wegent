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
    generation_id: str | None = None,
) -> bool:
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
    return subtask_store.update_fields_if_attempt(
        db,
        subtask=subtask,
        generation_id=generation_id,
        from_statuses=(SubtaskStatus.PENDING, SubtaskStatus.RUNNING),
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


def capture_cancellation_attempts(
    db: Session, *, task_id: int
) -> dict[int, str | None]:
    """Capture server-owned identities once when accepting a cancel request."""
    return {
        subtask.id: subtask.answer_generation_id
        for subtask in subtask_store.list_by_task_statuses(
            db,
            task_id=task_id,
            statuses=[SubtaskStatus.PENDING, SubtaskStatus.RUNNING],
        )
        if subtask.role == SubtaskRole.ASSISTANT
    }


def finalize_empty_cancellation(db: Session, *, task_id: int, user_id: int) -> bool:
    """Repair an idle task projection without adopting any answer attempt."""
    from fastapi import HTTPException

    try:
        task = task_store.get_owned_active_task(db, task_id=task_id, user_id=user_id)
        if not task:
            return False
        # A current locking read fences retries and new rows under InnoDB RR.
        active = subtask_store.list_by_task_statuses(
            db,
            task_id=task_id,
            statuses=[SubtaskStatus.PENDING, SubtaskStatus.RUNNING],
            for_update=True,
        )
        if any(row.role == SubtaskRole.ASSISTANT for row in active):
            db.rollback()
            return False
        db.refresh(task, with_for_update=True)
        task_crd = Task.model_validate(task.json)
        if not task_crd.status or task_crd.status.status in _TASK_FINAL_STATES:
            db.rollback()
            return False
        update_task_on_cancel(db, task)
        db.commit()
        return True
    except Exception as exc:
        db.rollback()
        logger.error(
            "Empty cancellation save unconfirmed: task_id=%s error_type=%s",
            task_id,
            type(exc).__name__,
        )
        raise HTTPException(
            status_code=503, detail="取消保存状态未确认，请刷新历史核对。"
        ) from None


def finalize_stuck_cancellation(
    db: Session, *, task_id: int, attempts: dict[int, str | None]
) -> List[int]:
    """
    Finalize cancellation locally when no runtime callback will arrive.

    Marks non-final assistant subtasks CANCELLED and the task CANCELLED.
    Used when the streaming runtime is dead (e.g. backend restart) and the
    task would otherwise remain in CANCELLING forever.

    Args:
        db: Database session
        task_id: Task ID to finalize
        attempts: Identities captured when accepting cancellation; never adopted here

    Returns:
        IDs of subtasks marked CANCELLED. Empty when the task was already in
        a final state or any active attempt changed.
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
        if subtask.id not in attempts or not update_subtask_on_cancel(
            db, subtask, generation_id=attempts[subtask.id]
        ):
            db.rollback()
            return []
        finalized.append(subtask.id)

    if not finalized:
        db.rollback()
        return []
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
