# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Best-effort WebSocket wake-up for local robot queue pullers.

The local puller ticks every few seconds anyway; this push only removes that
latency when the creator's App is connected. It is intentionally fire-and-forget
so a missing Socket.IO loop (tests, early startup) never blocks assignment.
"""

import asyncio
import logging

logger = logging.getLogger(__name__)

_socketio_loop: asyncio.AbstractEventLoop | None = None


def bind_socketio_loop(loop: asyncio.AbstractEventLoop) -> None:
    """Capture the app event loop so sync code can push events."""

    global _socketio_loop
    _socketio_loop = loop


def wake_robot_creator(*, user_id: int, project_id: str, agent_id: str) -> None:
    """Ask the robot creator's App to pull its local queue immediately."""

    loop = _socketio_loop
    if loop is None or loop.is_closed():
        return

    async def _emit() -> None:
        try:
            from app.api.ws.wework_runtime_namespace import (
                WEWORK_RUNTIME_NAMESPACE,
                wework_runtime_user_room,
            )
            from app.core.socketio import get_sio

            await get_sio().emit(
                "queue:task_assigned",
                {"projectId": str(project_id), "agentId": agent_id},
                room=wework_runtime_user_room(user_id),
                namespace=WEWORK_RUNTIME_NAMESPACE,
            )
        except Exception:
            logger.debug(
                "[RobotQueue] Wake push failed user=%s project=%s agent=%s",
                user_id,
                project_id,
                agent_id,
                exc_info=True,
            )

    try:
        asyncio.run_coroutine_threadsafe(_emit(), loop)
    except Exception:
        logger.debug("[RobotQueue] Wake push scheduling failed", exc_info=True)
