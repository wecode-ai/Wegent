# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Base classes for result emitters.

Provides common functionality for event creation and logging.
"""

import asyncio
import logging
from abc import ABC, abstractmethod
from typing import AsyncIterator, Optional

from shared.models import EventType, ExecutionEvent

from .protocol import StreamableEmitter

logger = logging.getLogger(__name__)


class BaseResultEmitter(ABC):
    """Base class for result emitters.

    Provides common event creation and logging functionality.
    """

    def __init__(self, task_id: int, subtask_id: int):
        """Initialize the base emitter.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
        """
        self.task_id = task_id
        self.subtask_id = subtask_id
        self._closed = False

    def _create_event(
        self,
        event_type: EventType,
        **kwargs,
    ) -> ExecutionEvent:
        """Create an execution event.

        Args:
            event_type: Type of event
            **kwargs: Additional event parameters

        Returns:
            ExecutionEvent instance
        """
        return ExecutionEvent.create(
            event_type=event_type,
            task_id=self.task_id,
            subtask_id=self.subtask_id,
            **kwargs,
        )

    async def emit_start(
        self,
        task_id: int,
        subtask_id: int,
        message_id: Optional[int] = None,
        **kwargs,
    ) -> None:
        """Emit start event.

        Args:
            task_id: Task ID (ignored, uses instance task_id)
            subtask_id: Subtask ID (ignored, uses instance subtask_id)
            message_id: Optional message ID for ordering
            **kwargs: Additional event parameters
        """
        event = self._create_event(
            EventType.START,
            message_id=message_id,
            **kwargs,
        )
        await self.emit(event)

    async def emit_chunk(
        self,
        task_id: int,
        subtask_id: int,
        content: str,
        offset: int,
        **kwargs,
    ) -> None:
        """Emit content chunk event.

        Args:
            task_id: Task ID (ignored, uses instance task_id)
            subtask_id: Subtask ID (ignored, uses instance subtask_id)
            content: Content chunk
            offset: Current offset in full response
            **kwargs: Additional event parameters
        """
        event = self._create_event(
            EventType.CHUNK,
            content=content,
            offset=offset,
            **kwargs,
        )
        await self.emit(event)

    async def emit_done(
        self,
        task_id: int,
        subtask_id: int,
        result: Optional[dict] = None,
        **kwargs,
    ) -> None:
        """Emit done event.

        Args:
            task_id: Task ID (ignored, uses instance task_id)
            subtask_id: Subtask ID (ignored, uses instance subtask_id)
            result: Optional result data
            **kwargs: Additional event parameters
        """
        event = self._create_event(
            EventType.DONE,
            result=result,
            **kwargs,
        )
        await self.emit(event)

    async def emit_error(
        self,
        task_id: int,
        subtask_id: int,
        error: str,
        **kwargs,
    ) -> None:
        """Emit error event.

        Args:
            task_id: Task ID (ignored, uses instance task_id)
            subtask_id: Subtask ID (ignored, uses instance subtask_id)
            error: Error message
            **kwargs: Additional event parameters
        """
        event = self._create_event(
            EventType.ERROR,
            error=error,
            **kwargs,
        )
        await self.emit(event)

    async def emit_cancelled(
        self,
        task_id: int,
        subtask_id: int,
        **kwargs,
    ) -> None:
        """Emit cancelled event.

        Args:
            task_id: Task ID (ignored, uses instance task_id)
            subtask_id: Subtask ID (ignored, uses instance subtask_id)
            **kwargs: Additional event parameters
        """
        event = self._create_event(
            EventType.CANCELLED,
            **kwargs,
        )
        await self.emit(event)

    @abstractmethod
    async def emit(self, event: ExecutionEvent) -> None:
        """Emit event - subclasses must implement.

        Args:
            event: Execution event to emit
        """
        ...

    async def close(self) -> None:
        """Close the emitter."""
        self._closed = True


class QueueBasedEmitter(BaseResultEmitter, StreamableEmitter):
    """Queue-based streaming emitter.

    Uses asyncio.Queue for event buffering, supports streaming output.
    """

    def __init__(self, task_id: int, subtask_id: int, maxsize: int = 0):
        """Initialize the queue-based emitter.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            maxsize: Maximum queue size (0 for unlimited)
        """
        super().__init__(task_id, subtask_id)
        self._queue: asyncio.Queue[Optional[ExecutionEvent]] = asyncio.Queue(
            maxsize=maxsize
        )
        self._done = False

    async def emit(self, event: ExecutionEvent) -> None:
        """Put event into queue.

        Args:
            event: Execution event to emit
        """
        if self._closed:
            logger.warning(f"Emitter closed, dropping event: {event.type}")
            return

        await self._queue.put(event)

        # Check if this is a terminal event
        if event.type in (
            EventType.DONE.value,
            EventType.ERROR.value,
            EventType.CANCELLED.value,
        ):
            self._done = True

    async def stream(self) -> AsyncIterator[ExecutionEvent]:
        """Stream events from queue.

        Yields:
            ExecutionEvent: Events from the queue
        """
        while not self._done or not self._queue.empty():
            try:
                event = await asyncio.wait_for(self._queue.get(), timeout=1.0)
                if event is not None:
                    yield event
                    if event.type in (
                        EventType.DONE.value,
                        EventType.ERROR.value,
                        EventType.CANCELLED.value,
                    ):
                        break
            except asyncio.TimeoutError:
                if self._closed:
                    break
                continue

    async def collect(self) -> tuple[str, Optional[ExecutionEvent]]:
        """Collect all events and return complete result.

        Returns:
            tuple: (accumulated_content, final_event)
        """
        accumulated_content = ""
        final_event = None

        async for event in self.stream():
            if event.type == EventType.CHUNK.value:
                accumulated_content += event.content or ""
            elif event.type in (EventType.DONE.value, EventType.ERROR.value):
                final_event = event
                break

        return accumulated_content, final_event

    async def close(self) -> None:
        """Close emitter and send termination signal."""
        await super().close()
        await self._queue.put(None)  # Send termination signal
