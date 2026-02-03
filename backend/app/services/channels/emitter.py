# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Response Emitters for IM Channels.

This module provides ChatEventEmitter implementations for IM channels:
- SyncResponseEmitter: Collects complete response before replying (channel-agnostic)
- CompositeEmitter: Forwards events to multiple emitters

Channel-specific streaming emitters should be implemented in their respective modules.
"""

import asyncio
import logging
from typing import Any, Dict, List, Optional

from app.services.chat.trigger.emitter import ChatEventEmitter

logger = logging.getLogger(__name__)


class SyncResponseEmitter(ChatEventEmitter):
    """Synchronous response collector emitter.

    Used for external channel integrations (DingTalk, Feishu, Telegram, etc.) that need
    to wait for the complete AI response before replying. This emitter collects
    streaming chunks and signals completion via an asyncio.Event.

    Usage:
        emitter = SyncResponseEmitter()
        # ... trigger AI response with this emitter ...
        response = await emitter.wait_for_response()
    """

    def __init__(self):
        """Initialize SyncResponseEmitter."""
        self._response_chunks: list[str] = []
        self._complete_event = asyncio.Event()
        self._result: Optional[Dict[str, Any]] = None
        self._error: Optional[str] = None

    async def wait_for_response(self) -> str:
        """Wait for the complete response.

        Returns:
            Complete response text

        Raises:
            RuntimeError: If an error occurred during streaming
        """
        await self._complete_event.wait()

        if self._error:
            raise RuntimeError(self._error)

        return "".join(self._response_chunks)

    def get_result(self) -> Optional[Dict[str, Any]]:
        """Get the result dictionary from chat:done event.

        Returns:
            Result dictionary or None
        """
        return self._result

    async def emit_chat_start(
        self,
        task_id: int,
        subtask_id: int,
        message_id: Optional[int] = None,
        shell_type: str = "Chat",
    ) -> None:
        """Emit chat:start event."""
        logger.debug(
            f"[SyncEmitter] chat:start task={task_id} subtask={subtask_id} "
            f"shell_type={shell_type}"
        )

    async def emit_chat_chunk(
        self,
        task_id: int,
        subtask_id: int,
        content: str,
        offset: int,
        result: Optional[Dict[str, Any]] = None,
        block_id: Optional[str] = None,
        block_offset: Optional[int] = None,
    ) -> None:
        """Emit chat:chunk event - collect chunk content."""
        if content:
            self._response_chunks.append(content)

    async def emit_chat_done(
        self,
        task_id: int,
        subtask_id: int,
        offset: int,
        result: Optional[Dict[str, Any]] = None,
        message_id: Optional[int] = None,
    ) -> None:
        """Emit chat:done event - signal completion."""
        self._result = result
        logger.debug(
            f"[SyncEmitter] chat:done task={task_id} subtask={subtask_id} "
            f"total_chunks={len(self._response_chunks)}"
        )
        self._complete_event.set()

    async def emit_chat_error(
        self,
        task_id: int,
        subtask_id: int,
        error: str,
        message_id: Optional[int] = None,
    ) -> None:
        """Emit chat:error event - signal error."""
        self._error = error
        logger.warning(
            f"[SyncEmitter] chat:error task={task_id} subtask={subtask_id} error={error}"
        )
        self._complete_event.set()

    async def emit_chat_cancelled(
        self,
        task_id: int,
        subtask_id: int,
    ) -> None:
        """Emit chat:cancelled event - signal cancellation."""
        self._error = "Response was cancelled"
        logger.debug(
            f"[SyncEmitter] chat:cancelled task={task_id} subtask={subtask_id}"
        )
        self._complete_event.set()

    async def emit_chat_bot_complete(
        self,
        user_id: int,
        task_id: int,
        subtask_id: int,
        content: str,
        result: Dict[str, Any],
    ) -> None:
        """Emit chat:bot_complete event (no-op for sync emitter)."""
        logger.debug(
            f"[SyncEmitter] chat:bot_complete user={user_id} task={task_id} "
            f"subtask={subtask_id} (skipped)"
        )


class CompositeEmitter(ChatEventEmitter):
    """Composite emitter that forwards events to multiple emitters.

    This allows collecting response content while also streaming
    updates to the user.
    """

    def __init__(self, *emitters: ChatEventEmitter):
        """Initialize with multiple emitters."""
        self._emitters: List[ChatEventEmitter] = list(emitters)

    def add_emitter(self, emitter: ChatEventEmitter) -> None:
        """Add an emitter to the composite."""
        self._emitters.append(emitter)

    async def emit_chat_start(
        self,
        task_id: int,
        subtask_id: int,
        message_id: Optional[int] = None,
        shell_type: str = "Chat",
    ) -> None:
        """Forward to all emitters."""
        for emitter in self._emitters:
            await emitter.emit_chat_start(
                task_id=task_id,
                subtask_id=subtask_id,
                message_id=message_id,
                shell_type=shell_type,
            )

    async def emit_chat_chunk(
        self,
        task_id: int,
        subtask_id: int,
        content: str,
        offset: int,
        result: Optional[Dict[str, Any]] = None,
        block_id: Optional[str] = None,
        block_offset: Optional[int] = None,
    ) -> None:
        """Forward to all emitters."""
        for emitter in self._emitters:
            await emitter.emit_chat_chunk(
                task_id=task_id,
                subtask_id=subtask_id,
                content=content,
                offset=offset,
                result=result,
                block_id=block_id,
                block_offset=block_offset,
            )

    async def emit_chat_done(
        self,
        task_id: int,
        subtask_id: int,
        offset: int,
        result: Optional[Dict[str, Any]] = None,
        message_id: Optional[int] = None,
    ) -> None:
        """Forward to all emitters."""
        for emitter in self._emitters:
            await emitter.emit_chat_done(
                task_id=task_id,
                subtask_id=subtask_id,
                offset=offset,
                result=result,
                message_id=message_id,
            )

    async def emit_chat_error(
        self,
        task_id: int,
        subtask_id: int,
        error: str,
        message_id: Optional[int] = None,
    ) -> None:
        """Forward to all emitters."""
        for emitter in self._emitters:
            await emitter.emit_chat_error(
                task_id=task_id,
                subtask_id=subtask_id,
                error=error,
                message_id=message_id,
            )

    async def emit_chat_cancelled(
        self,
        task_id: int,
        subtask_id: int,
    ) -> None:
        """Forward to all emitters."""
        for emitter in self._emitters:
            await emitter.emit_chat_cancelled(
                task_id=task_id,
                subtask_id=subtask_id,
            )

    async def emit_chat_bot_complete(
        self,
        user_id: int,
        task_id: int,
        subtask_id: int,
        content: str,
        result: Dict[str, Any],
    ) -> None:
        """Forward to all emitters."""
        for emitter in self._emitters:
            await emitter.emit_chat_bot_complete(
                user_id=user_id,
                task_id=task_id,
                subtask_id=subtask_id,
                content=content,
                result=result,
            )
