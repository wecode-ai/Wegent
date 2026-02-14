# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Response Emitters for IM Channels.

This module provides ResultEmitter implementations for IM channels:
- SyncResponseEmitter: Collects complete response before replying (channel-agnostic)
- CompositeEmitter: Forwards events to multiple emitters

Channel-specific streaming emitters should be implemented in their respective modules.
"""

import asyncio
import logging
from typing import Any, Dict, List, Optional

from app.services.execution.emitters import ResultEmitter
from shared.models import ExecutionEvent

logger = logging.getLogger(__name__)


class SyncResponseEmitter(ResultEmitter):
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
        """Get the result dictionary from done event.

        Returns:
            Result dictionary or None
        """
        return self._result

    async def emit(self, event: ExecutionEvent) -> None:
        """Emit a single event.

        Args:
            event: Execution event to emit
        """
        from shared.models import EventType

        if event.type == EventType.START:
            await self.emit_start(
                task_id=event.task_id,
                subtask_id=event.subtask_id,
                message_id=event.message_id,
            )
        elif event.type == EventType.CHUNK:
            await self.emit_chunk(
                task_id=event.task_id,
                subtask_id=event.subtask_id,
                content=event.content or "",
                offset=event.offset,
            )
        elif event.type == EventType.DONE:
            await self.emit_done(
                task_id=event.task_id,
                subtask_id=event.subtask_id,
                result=event.result,
            )
        elif event.type == EventType.ERROR:
            await self.emit_error(
                task_id=event.task_id,
                subtask_id=event.subtask_id,
                error=event.error or "Unknown error",
            )

    async def emit_start(
        self,
        task_id: int,
        subtask_id: int,
        message_id: Optional[int] = None,
        **kwargs,
    ) -> None:
        """Emit start event."""
        logger.debug(f"[SyncEmitter] start task={task_id} subtask={subtask_id}")

    async def emit_chunk(
        self,
        task_id: int,
        subtask_id: int,
        content: str,
        offset: int,
        **kwargs,
    ) -> None:
        """Emit chunk event - collect chunk content."""
        if content:
            self._response_chunks.append(content)

    async def emit_done(
        self,
        task_id: int,
        subtask_id: int,
        result: Optional[dict] = None,
        **kwargs,
    ) -> None:
        """Emit done event - signal completion."""
        self._result = result
        logger.debug(
            f"[SyncEmitter] done task={task_id} subtask={subtask_id} "
            f"total_chunks={len(self._response_chunks)}"
        )
        self._complete_event.set()

    async def emit_error(
        self,
        task_id: int,
        subtask_id: int,
        error: str,
        **kwargs,
    ) -> None:
        """Emit error event - signal error."""
        self._error = error
        logger.warning(
            f"[SyncEmitter] error task={task_id} subtask={subtask_id} error={error}"
        )
        self._complete_event.set()

    async def close(self) -> None:
        """Close the emitter and release resources."""
        pass


class CompositeEmitter(ResultEmitter):
    """Composite emitter that forwards events to multiple emitters.

    This allows collecting response content while also streaming
    updates to the user.
    """

    def __init__(self, *emitters: ResultEmitter):
        """Initialize with multiple emitters."""
        self._emitters: List[ResultEmitter] = list(emitters)

    def add_emitter(self, emitter: ResultEmitter) -> None:
        """Add an emitter to the composite."""
        self._emitters.append(emitter)

    async def emit(self, event: ExecutionEvent) -> None:
        """Forward event to all emitters."""
        for emitter in self._emitters:
            await emitter.emit(event)

    async def emit_start(
        self,
        task_id: int,
        subtask_id: int,
        message_id: Optional[int] = None,
        **kwargs,
    ) -> None:
        """Forward to all emitters."""
        for emitter in self._emitters:
            await emitter.emit_start(
                task_id=task_id,
                subtask_id=subtask_id,
                message_id=message_id,
                **kwargs,
            )

    async def emit_chunk(
        self,
        task_id: int,
        subtask_id: int,
        content: str,
        offset: int,
        **kwargs,
    ) -> None:
        """Forward to all emitters."""
        for emitter in self._emitters:
            await emitter.emit_chunk(
                task_id=task_id,
                subtask_id=subtask_id,
                content=content,
                offset=offset,
                **kwargs,
            )

    async def emit_done(
        self,
        task_id: int,
        subtask_id: int,
        result: Optional[dict] = None,
        **kwargs,
    ) -> None:
        """Forward to all emitters."""
        for emitter in self._emitters:
            await emitter.emit_done(
                task_id=task_id,
                subtask_id=subtask_id,
                result=result,
                **kwargs,
            )

    async def emit_error(
        self,
        task_id: int,
        subtask_id: int,
        error: str,
        **kwargs,
    ) -> None:
        """Forward to all emitters."""
        for emitter in self._emitters:
            await emitter.emit_error(
                task_id=task_id,
                subtask_id=subtask_id,
                error=error,
                **kwargs,
            )

    async def close(self) -> None:
        """Close all emitters."""
        for emitter in self._emitters:
            await emitter.close()
