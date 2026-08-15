# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Project ordinary Wegent Team completion onto board execution truth."""

import logging
import weakref
from typing import Any

from app.core.events import EventBus, TaskCompletedEvent, get_event_bus
from app.db.session import get_db_session
from app.models.loop_item_execution import LoopItemExecution
from app.services.loop_item_executions.service import loop_item_execution_service
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


async def handle_board_team_task_completed(event: TaskCompletedEvent) -> None:
    """Accept terminal state only from the labelled Team Task for this run."""

    with get_db_session() as db:
        task = task_store.get_by_id(db, task_id=event.task_id)
        if task is None or task.user_id != event.user_id:
            return
        labels = _labels(task)
        if labels.get("source") != "board_team_assignment":
            return
        try:
            execution_id = int(labels["boardTeamExecutionId"])
            subtask_id = int(labels["boardTeamSubtaskId"])
            team_id = int(labels["boardTeamTeamId"])
        except (KeyError, TypeError, ValueError):
            return
        if event.subtask_id is not None and event.subtask_id != subtask_id:
            return
        execution = db.get(LoopItemExecution, execution_id)
        if (
            execution is None
            or execution.team_id != team_id
            or execution.backend_task_id != event.task_id
            or execution.executor_owner_user_id != event.user_id
            or execution.loop_item_id != str(labels.get("weworkSpaceTaskId") or "")
            or execution.cloud_project_id
            != str(labels.get("weworkSpaceProjectId") or "")
        ):
            logger.error(
                "[BoardTeamCompletion] Ignored mismatched completion task=%s execution=%s",
                event.task_id,
                execution_id,
            )
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
        elif normalized == "CANCELLED":
            requested = loop_item_execution_service.cancel(
                db,
                execution_id=execution.id,
                note=content or "Wegent Team execution cancelled.",
            )
            if requested.status == "cancel_requested":
                loop_item_execution_service.confirm_runtime_cancelled(
                    db,
                    execution_id=requested.id,
                    note=content or "Wegent Team execution cancelled.",
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
