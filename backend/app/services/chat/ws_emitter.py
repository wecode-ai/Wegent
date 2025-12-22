# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
WebSocket emitter for Socket.IO events.

This module provides a unified interface for emitting Socket.IO events
to clients. It wraps the Socket.IO server and provides typed methods
for all event types.
"""

import asyncio
import logging
from datetime import datetime
from typing import Any, Dict, Optional

import socketio

from app.api.ws.events import (
    ServerEvents,
)

logger = logging.getLogger(__name__)


class WebSocketEmitter:
    """
    WebSocket emitter for broadcasting Socket.IO events.

    Provides typed methods for emitting events to task rooms and user rooms.
    Supports cross-worker communication via Redis adapter.
    """

    def __init__(self, sio: socketio.AsyncServer, namespace: str = "/chat"):
        """
        Initialize the WebSocket emitter.

        Args:
            sio: Socket.IO server instance
            namespace: Socket.IO namespace (default: /chat)
        """
        self.sio = sio
        self.namespace = namespace

    # ============================================================
    # Chat Streaming Events (to task room)
    # ============================================================

    async def emit_chat_start(
        self,
        task_id: int,
        subtask_id: int,
        bot_name: Optional[str] = None,
    ) -> None:
        """
        Emit chat:start event to task room.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            bot_name: Optional bot name
        """
        await self.sio.emit(
            ServerEvents.CHAT_START,
            {
                "task_id": task_id,
                "subtask_id": subtask_id,
                "bot_name": bot_name,
            },
            room=f"task:{task_id}",
            namespace=self.namespace,
        )
        logger.debug(f"[WS] emit chat:start task={task_id} subtask={subtask_id}")

    async def emit_chat_chunk(
        self,
        task_id: int,
        subtask_id: int,
        content: str,
        offset: int,
        result: Optional[Dict[str, Any]] = None,
    ) -> None:
        """
        Emit chat:chunk event to task room.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            content: Content chunk (for text streaming)
            offset: Current offset in the full response
            result: Optional full result data (for executor tasks with thinking/workbench)
        """
        payload = {
            "subtask_id": subtask_id,
            "content": content,
            "offset": offset,
        }
        # Include full result if provided (for executor tasks)
        if result is not None:
            payload["result"] = result

        await self.sio.emit(
            ServerEvents.CHAT_CHUNK,
            payload,
            room=f"task:{task_id}",
            namespace=self.namespace,
        )

    async def emit_chat_done(
        self,
        task_id: int,
        subtask_id: int,
        offset: int,
        result: Optional[Dict[str, Any]] = None,
        message_id: Optional[int] = None,
    ) -> None:
        """
        Emit chat:done event to task room.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            offset: Final offset
            result: Optional result data
            message_id: Message ID for ordering (primary sort key)
        """
        await self.sio.emit(
            ServerEvents.CHAT_DONE,
            {
                "task_id": task_id,
                "subtask_id": subtask_id,
                "offset": offset,
                "result": result or {},
                "message_id": message_id,
            },
            room=f"task:{task_id}",
            namespace=self.namespace,
        )
        logger.debug(
            f"[WS] emit chat:done task={task_id} subtask={subtask_id} message_id={message_id}"
        )

    async def emit_chat_error(
        self,
        task_id: int,
        subtask_id: int,
        error: str,
        error_type: Optional[str] = None,
    ) -> None:
        """
        Emit chat:error event to task room.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            error: Error message
            error_type: Optional error type
        """
        await self.sio.emit(
            ServerEvents.CHAT_ERROR,
            {
                "subtask_id": subtask_id,
                "error": error,
                "type": error_type,
            },
            room=f"task:{task_id}",
            namespace=self.namespace,
        )
        logger.warning(
            f"[WS] emit chat:error task={task_id} subtask={subtask_id} error={error}"
        )

    async def emit_chat_cancelled(
        self,
        task_id: int,
        subtask_id: int,
    ) -> None:
        """
        Emit chat:cancelled event to task room.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
        """
        await self.sio.emit(
            ServerEvents.CHAT_CANCELLED,
            {
                "task_id": task_id,
                "subtask_id": subtask_id,
            },
            room=f"task:{task_id}",
            namespace=self.namespace,
        )
        logger.info(f"[WS] emit chat:cancelled task={task_id} subtask={subtask_id}")

    # ============================================================
    # Non-streaming Messages (to task room, exclude sender)
    # ============================================================

    async def emit_chat_message(
        self,
        task_id: int,
        subtask_id: int,
        message_id: int,
        role: str,
        content: str,
        sender: Dict[str, Any],
        created_at: datetime,
        skip_sid: Optional[str] = None,
    ) -> None:
        """
        Emit chat:message event to task room (excluding sender).

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            message_id: Message ID for ordering (primary sort key)
            role: Message role (user/assistant/system)
            content: Message content
            sender: Sender info dict
            created_at: Message creation time
            skip_sid: Socket ID to exclude (sender)
        """
        await self.sio.emit(
            ServerEvents.CHAT_MESSAGE,
            {
                "subtask_id": subtask_id,
                "task_id": task_id,
                "message_id": message_id,
                "role": role,
                "content": content,
                "sender": sender,
                "created_at": created_at.isoformat(),
            },
            room=f"task:{task_id}",
            skip_sid=skip_sid,
            namespace=self.namespace,
        )
        logger.debug(f"[WS] emit chat:message task={task_id} role={role}")

    async def emit_chat_bot_complete(
        self,
        user_id: int,
        task_id: int,
        subtask_id: int,
        content: str,
        result: Dict[str, Any],
    ) -> None:
        """
        Emit chat:bot_complete event to user room.

        This notifies all devices of the user about a completed AI response,
        even if they don't have the task page open.

        Args:
            user_id: User ID
            task_id: Task ID
            subtask_id: Subtask ID
            content: Full response content
            result: Result data
        """
        await self.sio.emit(
            ServerEvents.CHAT_BOT_COMPLETE,
            {
                "task_id": task_id,
                "subtask_id": subtask_id,
                "content": content,
                "result": result,
                "created_at": datetime.now().isoformat(),
            },
            room=f"user:{user_id}",
            namespace=self.namespace,
        )
        logger.debug(f"[WS] emit chat:bot_complete user={user_id} task={task_id}")

    async def emit_chat_system(
        self,
        task_id: int,
        msg_type: str,
        content: str,
        data: Optional[Dict[str, Any]] = None,
    ) -> None:
        """
        Emit chat:system event to task room.

        Args:
            task_id: Task ID
            msg_type: System message type
            content: Message content
            data: Optional additional data
        """
        await self.sio.emit(
            ServerEvents.CHAT_SYSTEM,
            {
                "task_id": task_id,
                "type": msg_type,
                "content": content,
                "data": data,
            },
            room=f"task:{task_id}",
            namespace=self.namespace,
        )
        logger.debug(f"[WS] emit chat:system task={task_id} type={msg_type}")

    # ============================================================
    # Task List Events (to user room)
    # ============================================================

    async def emit_task_created(
        self,
        user_id: int,
        task_id: int,
        title: str,
        team_id: int,
        team_name: str,
    ) -> None:
        """
        Emit task:created event to user room.

        Args:
            user_id: User ID
            task_id: Task ID
            title: Task title
            team_id: Team ID
            team_name: Team name
        """
        await self.sio.emit(
            ServerEvents.TASK_CREATED,
            {
                "task_id": task_id,
                "title": title,
                "team_id": team_id,
                "team_name": team_name,
                "created_at": datetime.now().isoformat(),
            },
            room=f"user:{user_id}",
            namespace=self.namespace,
        )
        logger.debug(f"[WS] emit task:created user={user_id} task={task_id}")

    async def emit_task_deleted(self, user_id: int, task_id: int) -> None:
        """
        Emit task:deleted event to user room.

        Args:
            user_id: User ID
            task_id: Task ID
        """
        await self.sio.emit(
            ServerEvents.TASK_DELETED,
            {"task_id": task_id},
            room=f"user:{user_id}",
            namespace=self.namespace,
        )
        logger.debug(f"[WS] emit task:deleted user={user_id} task={task_id}")

    async def emit_task_renamed(self, user_id: int, task_id: int, title: str) -> None:
        """
        Emit task:renamed event to user room.

        Args:
            user_id: User ID
            task_id: Task ID
            title: New title
        """
        await self.sio.emit(
            ServerEvents.TASK_RENAMED,
            {"task_id": task_id, "title": title},
            room=f"user:{user_id}",
            namespace=self.namespace,
        )
        logger.debug(f"[WS] emit task:renamed user={user_id} task={task_id}")

    async def emit_task_status(
        self,
        user_id: int,
        task_id: int,
        status: str,
        progress: Optional[int] = None,
        completed_at: Optional[str] = None,
    ) -> None:
        """
        Emit task:status event to user room.

        Args:
            user_id: User ID
            task_id: Task ID
            status: New status
            progress: Optional progress percentage
            completed_at: Optional completion timestamp (for terminal states)
        """
        payload = {
            "task_id": task_id,
            "status": status,
            "progress": progress,
        }
        # Include completed_at for terminal states
        if completed_at is not None:
            payload["completed_at"] = completed_at
        elif status in ("COMPLETED", "FAILED", "CANCELLED"):
            # Auto-generate completed_at for terminal states if not provided
            payload["completed_at"] = datetime.now().isoformat()

        await self.sio.emit(
            ServerEvents.TASK_STATUS,
            payload,
            room=f"user:{user_id}",
            namespace=self.namespace,
        )
        logger.debug(
            f"[WS] emit task:status user={user_id} task={task_id} status={status}"
        )

    async def emit_task_shared(
        self,
        user_id: int,
        task_id: int,
        title: str,
        shared_by: Dict[str, Any],
    ) -> None:
        """
        Emit task:shared event to user room.

        Args:
            user_id: Target user ID (who receives the shared task)
            task_id: Task ID
            title: Task title
            shared_by: Info about who shared the task
        """
        await self.sio.emit(
            ServerEvents.TASK_SHARED,
            {
                "task_id": task_id,
                "title": title,
                "shared_by": shared_by,
            },
            room=f"user:{user_id}",
            namespace=self.namespace,
        )
        logger.debug(f"[WS] emit task:shared user={user_id} task={task_id}")

    async def emit_task_invited(
        self,
        user_id: int,
        task_id: int,
        title: str,
        team_id: int,
        team_name: str,
        invited_by: Dict[str, Any],
    ) -> None:
        """
        Emit task:invited event to user room when user is invited to a group chat.

        Args:
            user_id: Target user ID (who is invited)
            task_id: Task ID
            title: Task title
            team_id: Team ID
            team_name: Team name
            invited_by: Info about who invited the user
        """
        await self.sio.emit(
            ServerEvents.TASK_INVITED,
            {
                "task_id": task_id,
                "title": title,
                "team_id": team_id,
                "team_name": team_name,
                "invited_by": invited_by,
                "is_group_chat": True,
                "created_at": datetime.now().isoformat(),
            },
            room=f"user:{user_id}",
            namespace=self.namespace,
        )
        logger.debug(f"[WS] emit task:invited user={user_id} task={task_id}")

    async def emit_unread_count(self, user_id: int, count: int) -> None:
        """
        Emit unread:count event to user room.

        Args:
            user_id: User ID
            count: Unread count
        """
        await self.sio.emit(
            ServerEvents.UNREAD_COUNT,
            {"count": count},
            room=f"user:{user_id}",
            namespace=self.namespace,
        )
        logger.debug(f"[WS] emit unread:count user={user_id} count={count}")


# Global emitter instance (lazy initialized)
_ws_emitter: Optional[WebSocketEmitter] = None
# Global reference to the main event loop (set during initialization)
_main_event_loop: Optional[asyncio.AbstractEventLoop] = None


def get_ws_emitter() -> Optional[WebSocketEmitter]:
    """
    Get the global WebSocket emitter instance.

    Returns:
        WebSocketEmitter or None if not initialized
    """
    return _ws_emitter


def get_main_event_loop() -> Optional[asyncio.AbstractEventLoop]:
    """
    Get the main event loop reference.

    Returns:
        The main event loop or None if not initialized
    """
    return _main_event_loop


def init_ws_emitter(sio: socketio.AsyncServer) -> WebSocketEmitter:
    """
    Initialize the global WebSocket emitter.

    Args:
        sio: Socket.IO server instance

    Returns:
        WebSocketEmitter: Initialized emitter instance
    """
    global _ws_emitter, _main_event_loop
    _ws_emitter = WebSocketEmitter(sio)

    # Capture the main event loop reference for use in synchronous contexts
    try:
        _main_event_loop = asyncio.get_running_loop()
        logger.info("WebSocket emitter initialized with main event loop reference")
    except RuntimeError:
        # No running loop during initialization (shouldn't happen in normal startup)
        try:
            _main_event_loop = asyncio.get_event_loop()
            logger.info(
                "WebSocket emitter initialized with event loop (not running yet)"
            )
        except RuntimeError:
            logger.warning("WebSocket emitter initialized without event loop reference")

    return _ws_emitter
