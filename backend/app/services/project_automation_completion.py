# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Persist managed project-automation task outcomes in the board timeline."""

import logging
import weakref
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

from app.core.events import EventBus, TaskCompletedEvent, get_event_bus
from app.db.session import get_db_session
from app.models.delivery import ProjectAutomationRun
from app.models.project_chat_message import ProjectChatMessage
from app.services.project_chat.push import push_project_chat_message
from app.services.project_chat.service import project_chat_service
from app.services.project_workflow_projection import sync_automation_workflow_node
from app.stores.tasks import task_store

logger = logging.getLogger(__name__)

_REGISTERED_BUSES: weakref.WeakSet[EventBus] = weakref.WeakSet()
_TERMINAL_RUN_STATUSES = {"succeeded", "failed", "cancelled", "skipped"}


@dataclass(frozen=True)
class _ManagedActivity:
    """Persistent automation records linked by labels on a Wegent Task."""

    message: ProjectChatMessage
    run: ProjectAutomationRun


def _task_labels(task: Any) -> dict[str, Any]:
    task_json = task.json if isinstance(task.json, dict) else {}
    metadata = task_json.get("metadata")
    labels = metadata.get("labels") if isinstance(metadata, dict) else None
    return labels if isinstance(labels, dict) else {}


def _managed_activity(
    db: Session,
    *,
    task_id: int,
    subtask_id: int | None = None,
    user_id: int | None = None,
) -> _ManagedActivity | None:
    task = task_store.get_by_id(db, task_id=task_id)
    if task is None or (user_id is not None and task.user_id != user_id):
        return None

    labels = _task_labels(task)
    if labels.get("source") != "project_automation":
        return None
    try:
        managed_subtask_id = int(labels["projectAutomationSubtaskId"])
    except (KeyError, TypeError, ValueError):
        return None
    if subtask_id is not None and managed_subtask_id != subtask_id:
        return None
    message_id = labels.get("projectChatMessageId")
    run_id = labels.get("projectAutomationRunId")
    if not isinstance(message_id, str) or not message_id:
        return None
    if not isinstance(run_id, str) or not run_id:
        return None

    run = (
        db.query(ProjectAutomationRun)
        .filter(ProjectAutomationRun.id == run_id)
        .with_for_update()
        .first()
    )
    message = (
        db.query(ProjectChatMessage)
        .filter(ProjectChatMessage.message_id == message_id)
        .with_for_update()
        .first()
    )
    if message is None or run is None:
        return None
    if run.created_by_user_id != task.user_id:
        return None
    if run.backend_task_id not in (None, 0, task_id):
        return None

    project_id = labels.get("weworkSpaceProjectId")
    board_task_id = labels.get("weworkSpaceTaskId")
    if project_id is not None and str(message.project_id) != str(project_id):
        logger.error(
            "[ProjectAutomationCompletion] Project label mismatch: "
            "backend_task_id=%s message_id=%s",
            task_id,
            message_id,
        )
        return None
    if project_id is not None and str(run.cloud_project_id) != str(project_id):
        return None
    if board_task_id is not None and str(message.task_id) != str(board_task_id):
        return None

    message_metadata = (
        message.metadata_json if isinstance(message.metadata_json, dict) else {}
    )
    message_run_id = message_metadata.get("automation_run_id")
    if message_run_id is not None and str(message_run_id) != str(run_id):
        return None
    message_task_id = message_metadata.get("backend_task_id")
    if message_task_id not in (None, 0, task_id):
        return None
    return _ManagedActivity(message=message, run=run)


def _result_text(result: dict[str, Any] | None) -> str | None:
    if not isinstance(result, dict):
        return None
    return project_chat_service._project_chat_final_text(result, {"result": result})


def _apply_terminal_state(
    db: Session,
    *,
    activity: _ManagedActivity,
    task_id: int,
    status: str,
    result: dict[str, Any] | None,
    error: str | None,
) -> bool:
    normalized = status.upper()
    projection = {
        "COMPLETED": ("succeeded", "completed"),
        "FAILED": ("failed", "failed"),
        "CANCELLED": ("cancelled", "cancelled"),
    }.get(normalized)
    if projection is None:
        return False

    run_status, message_status = projection
    run = activity.run
    message = activity.message
    if run.status == run_status and message.status == message_status:
        return False
    if run.status in _TERMINAL_RUN_STATUSES and run.status != run_status:
        logger.warning(
            "[ProjectAutomationCompletion] Ignoring conflicting terminal state: "
            "run_id=%s current=%s incoming=%s",
            run.id,
            run.status,
            run_status,
        )
        return False

    content = _result_text(result)
    if normalized == "FAILED":
        content = error or content or "AI 托管任务执行失败。"
    elif normalized == "CANCELLED":
        content = content or message.content or "AI 托管任务已取消。"
    elif not content and not message.content:
        content = "AI 托管任务已完成。"

    if content:
        message.content = content
    message.status = message_status
    message.message_type = "text"
    metadata = dict(message.metadata_json or {})
    metadata.update(
        {
            "automation_run_id": str(run.id),
            "backend_task_id": task_id,
            "run_id": str(run.id),
            "run_status": message_status,
        }
    )
    if error:
        metadata["error"] = error
    else:
        metadata.pop("error", None)
    message.metadata_json = metadata

    run.status = run_status
    run.backend_task_id = task_id
    run.completed_at = datetime.now()
    run.version += 1
    if normalized == "FAILED" and content:
        run.description = content
    sync_automation_workflow_node(db, run)
    return True


async def handle_project_automation_task_completed(
    event: TaskCompletedEvent,
) -> None:
    """Project one terminal Wegent Task event onto its automation run/comment."""

    message_view: dict[str, Any] | None = None
    with get_db_session() as db:
        activity = _managed_activity(
            db,
            task_id=event.task_id,
            subtask_id=event.subtask_id,
            user_id=event.user_id,
        )
        if activity is None:
            return
        if event.status.upper() == "COMPLETED":
            content = _result_text(event.result)
            from app.services.project_automation_execution import (
                project_automation_execution,
            )

            try:
                changed = project_automation_execution.finalize_manager_result(
                    db,
                    run_id=str(activity.run.id),
                    content=content,
                    backend_task_id=event.task_id,
                    activity_message_id=activity.message.message_id,
                    push_activity=False,
                )
            except Exception as exc:
                logger.exception(
                    "[ProjectAutomationCompletion] Manager finalization failed "
                    "task_id=%s run_id=%s",
                    event.task_id,
                    activity.run.id,
                )
                db.rollback()
                activity = _managed_activity(
                    db,
                    task_id=event.task_id,
                    subtask_id=event.subtask_id,
                    user_id=event.user_id,
                )
                changed = bool(
                    activity
                    and _apply_terminal_state(
                        db,
                        activity=activity,
                        task_id=event.task_id,
                        status="FAILED",
                        result=None,
                        error=str(exc) or "AI manager finalization failed",
                    )
                )
        else:
            from app.services.project_automation_execution import (
                project_automation_execution,
            )

            if project_automation_execution.has_recorded_manager_assignment(
                db, run_id=str(activity.run.id)
            ):
                changed = project_automation_execution.finalize_manager_result(
                    db,
                    run_id=str(activity.run.id),
                    content="AI 调度员已完成分派，但调度结果回传失败。",
                    backend_task_id=event.task_id,
                    activity_message_id=activity.message.message_id,
                    push_activity=False,
                )
            else:
                changed = _apply_terminal_state(
                    db,
                    activity=activity,
                    task_id=event.task_id,
                    status=event.status,
                    result=event.result,
                    error=event.error,
                )
        if not changed:
            return
        db.commit()
        refreshed = _managed_activity(db, task_id=event.task_id)
        if refreshed is None:
            return
        db.refresh(refreshed.message)
        message_view = project_chat_service.to_view(refreshed.message).model_dump(
            by_alias=True
        )

    if message_view is not None:
        push_project_chat_message(message_view)


def register_project_automation_task_completion_handler(
    event_bus: EventBus | None = None,
) -> None:
    """Register the durable handler once on the supplied process-local bus."""

    bus = event_bus or get_event_bus()
    if bus in _REGISTERED_BUSES:
        return
    bus.subscribe(TaskCompletedEvent, handle_project_automation_task_completed)
    _REGISTERED_BUSES.add(bus)


def mark_project_automation_dispatch_started(*, task_id: int) -> bool:
    """Project the Celery worker's actual start onto the run and parent comment."""

    message_view: dict[str, Any] | None = None
    with get_db_session() as db:
        activity = _managed_activity(db, task_id=task_id)
        if activity is None:
            return False
        if activity.run.status in _TERMINAL_RUN_STATUSES:
            return False
        if activity.message.status in {"completed", "failed", "cancelled"}:
            return False

        changed = False
        if activity.run.status != "running":
            activity.run.status = "running"
            activity.run.backend_task_id = task_id
            activity.run.version += 1
            changed = True
        sync_automation_workflow_node(db, activity.run)
        metadata = dict(activity.message.metadata_json or {})
        next_metadata = {
            **metadata,
            "automation_run_id": str(activity.run.id),
            "backend_task_id": task_id,
            "run_id": str(activity.run.id),
            "run_status": "running",
        }
        if (
            activity.message.status != "streaming"
            or activity.message.metadata_json != next_metadata
        ):
            activity.message.status = "streaming"
            activity.message.metadata_json = next_metadata
            changed = True
        if not changed:
            return False

        db.commit()
        db.refresh(activity.message)
        message_view = project_chat_service.to_view(activity.message).model_dump(
            by_alias=True
        )
    if message_view is not None:
        push_project_chat_message(message_view)
    return True


def fail_project_automation_dispatch(*, task_id: int, error: str) -> None:
    """Persist failures that occur before the dispatcher can emit an event."""

    message_view: dict[str, Any] | None = None
    with get_db_session() as db:
        activity = _managed_activity(db, task_id=task_id)
        if activity is None:
            return
        if not _apply_terminal_state(
            db,
            activity=activity,
            task_id=task_id,
            status="FAILED",
            result=None,
            error=error or "AI 托管任务派发失败。",
        ):
            return
        db.commit()
        db.refresh(activity.message)
        message_view = project_chat_service.to_view(activity.message).model_dump(
            by_alias=True
        )
    if message_view is not None:
        push_project_chat_message(message_view)
