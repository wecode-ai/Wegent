# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Best-effort Wework notification for human project task assignments."""

import asyncio
import logging

from app.services.loop_item_executions.wake import get_socketio_loop

logger = logging.getLogger(__name__)

PROJECT_TASK_ASSIGNED_EVENT = "project.task.assigned"


def notify_project_task_assignee(
    *,
    user_id: int,
    project_id: str,
    project_name: str,
    item_id: str,
    item_title: str,
    assigner_name: str,
) -> None:
    """Push an assignment event without blocking the committed assignment."""

    loop = get_socketio_loop()
    if loop is None or loop.is_closed():
        return

    async def _emit() -> None:
        try:
            from app.api.ws.wework_runtime_namespace import (
                WEWORK_RUNTIME_EVENT,
                WEWORK_RUNTIME_NAMESPACE,
                wework_runtime_user_room,
            )
            from app.core.socketio import get_sio

            await get_sio().emit(
                WEWORK_RUNTIME_EVENT,
                {
                    "event": PROJECT_TASK_ASSIGNED_EVENT,
                    "payload": {
                        "projectId": project_id,
                        "projectName": project_name,
                        "itemId": item_id,
                        "itemTitle": item_title,
                        "assignerName": assigner_name,
                    },
                },
                room=wework_runtime_user_room(user_id),
                namespace=WEWORK_RUNTIME_NAMESPACE,
            )
        except Exception:
            logger.debug(
                "[ProjectTaskAssignment] Notification push failed user=%s item=%s",
                user_id,
                item_id,
                exc_info=True,
            )

    try:
        asyncio.run_coroutine_threadsafe(_emit(), loop)
    except Exception:
        logger.debug(
            "[ProjectTaskAssignment] Notification scheduling failed",
            exc_info=True,
        )
