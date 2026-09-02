# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Register task-completion side effects in the execution worker process."""

from __future__ import annotations

import logging

from app.core.events import EventBus, TaskCompletedEvent, init_event_bus

logger = logging.getLogger(__name__)


def _bounded_channel_text(value: object) -> str:
    from app.services.channels.worker_client import (
        CHANNEL_COMPLETION_CONTENT_MAX_CHARS,
    )

    if value is None:
        return ""
    text = value if isinstance(value, str) else str(value)
    return text[:CHANNEL_COMPLETION_CONTENT_MAX_CHARS]


async def _forward_channel_completion(event: TaskCompletedEvent) -> None:
    """Send terminal channel delivery to its dedicated provider process."""
    from app.services.channels.worker_client import channel_worker_client

    result = event.result if isinstance(event.result, dict) else {}
    content = result.get("value") or result.get("output") or ""
    await channel_worker_client.task_completed(
        task_id=event.task_id,
        subtask_id=event.subtask_id,
        status=event.status,
        content=_bounded_channel_text(content),
        error=_bounded_channel_text(event.error) if event.error is not None else None,
    )


def initialize_execution_completion_handlers() -> EventBus:
    """Own every durable task-completion side effect outside Uvicorn."""
    from app.services.board_team_completion import (
        register_board_team_completion_handler,
    )
    from app.services.knowledge.code_wiki.task_completion import (
        conclude_code_wiki_run,
    )
    from app.services.pet.event_handlers import handle_task_completed_for_pet
    from app.services.project_automation_completion import (
        register_project_automation_task_completion_handler,
    )
    from app.services.subscription.task_completion_handler import (
        handle_task_completed,
    )

    event_bus = init_event_bus()
    event_bus.subscribe(TaskCompletedEvent, handle_task_completed_for_pet)
    event_bus.subscribe(TaskCompletedEvent, handle_task_completed)
    event_bus.subscribe(TaskCompletedEvent, _forward_channel_completion)
    register_project_automation_task_completion_handler(event_bus)
    register_board_team_completion_handler(event_bus)
    event_bus.subscribe(TaskCompletedEvent, conclude_code_wiki_run)
    logger.info("Execution task-completion handlers initialized")
    return event_bus
