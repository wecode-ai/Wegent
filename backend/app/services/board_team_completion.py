# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Project ordinary Wegent Team completion onto board execution truth."""

import logging
import weakref
from typing import Any

from app.core.events import EventBus, TaskCompletedEvent, get_event_bus
from app.db.session import get_db_session
from app.models.loop_item_execution import LoopItemExecution
from app.services.loop_item_executions.service import (
    STATUS_CANCELLED,
    TERMINAL_STATUSES,
    loop_item_execution_service,
)
from app.services.project_chat.service import project_chat_service
from app.stores.tasks import task_store

logger = logging.getLogger(__name__)
_REGISTERED_BUSES: weakref.WeakSet[EventBus] = weakref.WeakSet()


def _labels(task: Any) -> dict[str, Any]:
    task_json = task.json if isinstance(task.json, dict) else {}
    metadata = task_json.get("metadata")
    labels = metadata.get("labels") if isinstance(metadata, dict) else None
    return labels if isinstance(labels, dict) else {}


def _result_text(result: dict[str, Any] | None) -> str | None:
    if not isinstance(result, dict):
        return None
    return project_chat_service._project_chat_final_text(result, {"result": result})


def _matching_execution(
    db: Any,
    *,
    task_id: int,
    subtask_id: int,
    user_id: int,
    expected_native_status: str,
) -> LoopItemExecution | None:
    """Resolve an execution only when every durable identity agrees."""

    task = task_store.get_by_id(db, task_id=task_id)
    if task is None or task.user_id != user_id:
        return None
    task_json = task.json if isinstance(task.json, dict) else {}
    task_status = task_json.get("status")
    native_status = task_status.get("status") if isinstance(task_status, dict) else None
    if str(native_status or "").upper() != expected_native_status.upper():
        logger.warning(
            "[BoardTeamCompletion] Ignored event before native terminal persistence "
            "task=%s event_status=%s native_status=%s",
            task_id,
            expected_native_status,
            native_status,
        )
        return None
    labels = _labels(task)
    if labels.get("source") != "board_team_assignment":
        return None
    try:
        execution_id = int(labels["boardTeamExecutionId"])
        labelled_subtask_id = int(labels["boardTeamSubtaskId"])
        team_id = int(labels["boardTeamTeamId"])
    except (KeyError, TypeError, ValueError):
        return None
    if subtask_id != labelled_subtask_id:
        return None
    execution = db.get(LoopItemExecution, execution_id)
    if (
        execution is None
        or execution.team_id != team_id
        or execution.backend_task_id != task_id
        or execution.executor_owner_user_id != user_id
        or execution.loop_item_id != str(labels.get("weworkSpaceTaskId") or "")
        or execution.cloud_project_id != str(labels.get("weworkSpaceProjectId") or "")
    ):
        logger.error(
            "[BoardTeamCompletion] Ignored mismatched completion task=%s execution=%s",
            task_id,
            execution_id,
        )
        return None
    return execution


def request_board_team_cancellation(
    db: Any,
    *,
    task_id: int,
    subtask_id: int,
    user_id: int,
) -> LoopItemExecution | None:
    """Persist board cancellation intent before contacting the Runtime."""

    execution = _matching_execution(
        db,
        task_id=task_id,
        subtask_id=subtask_id,
        user_id=user_id,
        expected_native_status="CANCELLING",
    )
    if execution is None:
        return None
    requested = loop_item_execution_service.cancel(
        db,
        execution_id=execution.id,
        note="Wegent user requested cancellation.",
        commit=False,
    )
    db.commit()
    if requested.status == STATUS_CANCELLED:
        db.refresh(requested)
        loop_item_execution_service.publish_terminal_projection(db, requested)
    return requested


def project_board_team_cancellation(
    db: Any,
    event: TaskCompletedEvent,
    *,
    commit: bool = True,
) -> LoopItemExecution | None:
    """Project a proven native cancellation onto the linked board execution."""

    if event.status.upper() != "CANCELLED":
        raise ValueError("Board Team cancellation requires CANCELLED status")
    execution = _matching_execution(
        db,
        task_id=event.task_id,
        subtask_id=event.subtask_id,
        user_id=event.user_id,
        expected_native_status=event.status,
    )
    if execution is None:
        return None
    should_publish = execution.status not in TERMINAL_STATUSES
    content = _result_text(event.result) or "Wegent Team execution cancelled."
    requested = loop_item_execution_service.cancel(
        db,
        execution_id=execution.id,
        note=content,
        commit=False,
    )
    terminal = requested
    if requested.status == "cancel_requested":
        terminal = loop_item_execution_service.confirm_runtime_cancelled(
            db,
            execution_id=requested.id,
            note=content,
            commit=False,
        )
    if commit:
        db.commit()
        if (
            should_publish
            and terminal is not None
            and terminal.status == STATUS_CANCELLED
        ):
            db.refresh(terminal)
            loop_item_execution_service.publish_terminal_projection(db, terminal)
    return terminal


async def handle_board_team_task_completed(event: TaskCompletedEvent) -> None:
    """Accept terminal state only from the labelled Team Task for this run."""

    with get_db_session() as db:
        from app.services.board_team_continuation import (
            project_board_team_continuation,
        )

        if project_board_team_continuation(
            db,
            task_id=event.task_id,
            subtask_id=event.subtask_id,
            user_id=event.user_id,
            status_value=event.status,
            content=_result_text(event.result),
            error=event.error,
        ):
            return
        if event.status.upper() == "CANCELLED":
            project_board_team_cancellation(db, event)
            return

        execution = _matching_execution(
            db,
            task_id=event.task_id,
            subtask_id=event.subtask_id,
            user_id=event.user_id,
            expected_native_status=event.status,
        )
        if execution is None:
            return

        normalized = event.status.upper()
        content = _result_text(event.result)
        if normalized == "COMPLETED":
            loop_item_execution_service.complete(
                db,
                execution_id=execution.id,
                content=content or "Wegent Team execution completed.",
            )
        elif normalized == "FAILED":
            loop_item_execution_service.fail(
                db,
                execution_id=execution.id,
                error=event.error or content or "Wegent Team execution failed.",
                termination_reason="managed_team_failed",
            )


def register_board_team_completion_handler(
    event_bus: EventBus | None = None,
) -> None:
    """Register once for each event bus instance."""

    bus = event_bus or get_event_bus()
    if bus in _REGISTERED_BUSES:
        return
    bus.subscribe(TaskCompletedEvent, handle_board_team_task_completed)
    _REGISTERED_BUSES.add(bus)
