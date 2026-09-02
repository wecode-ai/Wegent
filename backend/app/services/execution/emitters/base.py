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
from dataclasses import dataclass
from typing import AsyncIterator, Optional

import orjson

from app.core.bounded_executor import BoundedExecutor
from app.core.byte_admission import ByteLease, LoopLocalByteAdmission
from shared.models import EventType, ExecutionEvent

from .protocol import StreamableEmitter

logger = logging.getLogger(__name__)

DEFAULT_QUEUE_MAXSIZE = 256
DEFAULT_QUEUE_MAX_BYTES = 64 * 1024 * 1024
_QUEUE_COMPLETE = object()
_EVENT_SIZE_EXECUTOR = BoundedExecutor(
    max_workers=4,
    max_in_flight=16,
    max_waiters=256,
    thread_name_prefix="wegent-emitter-size",
)
_PROCESS_QUEUE_BYTE_ADMISSION = LoopLocalByteAdmission(
    DEFAULT_QUEUE_MAX_BYTES,
    label="Buffered execution event",
)


def _encoded_event_size(event: ExecutionEvent) -> int:
    """Measure retained event bytes outside the sole Web event loop."""
    return len(orjson.dumps(event.to_dict()))


@dataclass(frozen=True)
class _QueuedEvent:
    event: ExecutionEvent
    lease: ByteLease


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

    def __init__(
        self,
        task_id: int,
        subtask_id: int,
        maxsize: int = DEFAULT_QUEUE_MAXSIZE,
        *,
        byte_admission: LoopLocalByteAdmission | None = None,
    ):
        """Initialize the queue-based emitter.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            maxsize: Maximum buffered event count. Producers wait when the queue
                is full, so events are not dropped.
            byte_admission: Shared retained-byte budget. Defaults to the
                process-wide budget used by every queue emitter on this loop.
        """
        super().__init__(task_id, subtask_id)
        if maxsize < 1:
            raise ValueError("maxsize must be at least 1")
        self._queue: asyncio.Queue[_QueuedEvent | object] = asyncio.Queue(
            maxsize=maxsize
        )
        self._byte_admission = byte_admission or _PROCESS_QUEUE_BYTE_ADMISSION
        self._closed_event = asyncio.Event()
        self._done = False

    async def emit(self, event: ExecutionEvent) -> None:
        """Put event into queue.

        Args:
            event: Execution event to emit
        """
        if self._closed:
            logger.warning(f"Emitter closed, dropping event: {event.type}")
            return

        encoded_size = await _EVENT_SIZE_EXECUTOR.run(_encoded_event_size, event)
        lease = await self._byte_admission.acquire(encoded_size)
        queued = False
        try:
            if self._closed:
                logger.warning(f"Emitter closed, dropping event: {event.type}")
                return

            item = _QueuedEvent(event=event, lease=lease)
            if not self._queue.full():
                self._queue.put_nowait(item)
                queued = True
            else:
                # A full queue must wake promptly during shutdown while still
                # propagating normal downstream backpressure to the producer.
                put_task = asyncio.create_task(self._queue.put(item))
                close_task = asyncio.create_task(self._closed_event.wait())
                try:
                    done, _ = await asyncio.wait(
                        {put_task, close_task},
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                    if put_task in done:
                        await put_task
                        queued = True
                    else:
                        put_task.cancel()
                        await asyncio.gather(put_task, return_exceptions=True)
                        return
                finally:
                    close_task.cancel()
                    await asyncio.gather(close_task, return_exceptions=True)

            # Check if this is a terminal event only after the queue owns it.
            if event.type in (
                EventType.DONE.value,
                EventType.ERROR.value,
                EventType.CANCELLED.value,
            ):
                self._done = True
        finally:
            if not queued:
                await lease.release()

    async def stream(self) -> AsyncIterator[ExecutionEvent]:
        """Stream events from queue.

        Yields:
            ExecutionEvent: Events from the queue
        """
        try:
            while not self._done or not self._queue.empty():
                if self._closed and self._queue.empty():
                    break
                try:
                    item = await asyncio.wait_for(self._queue.get(), timeout=1.0)
                except asyncio.TimeoutError:
                    if self._closed:
                        break
                    continue
                if item is _QUEUE_COMPLETE:
                    break
                if not isinstance(item, _QueuedEvent):
                    raise RuntimeError("Invalid execution emitter queue item")
                try:
                    yield item.event
                finally:
                    # The async generator resumes only after its caller has
                    # finished processing/sending this event.
                    await item.lease.release()
                if item.event.type in (
                    EventType.DONE.value,
                    EventType.ERROR.value,
                    EventType.CANCELLED.value,
                ):
                    break
        finally:
            if not self._closed:
                await super().close()
                self._closed_event.set()
            await self._release_buffered_leases()

    async def _release_buffered_leases(self) -> None:
        """Release retained-byte leases for events no consumer will observe."""
        while True:
            try:
                item = self._queue.get_nowait()
            except asyncio.QueueEmpty:
                return
            if isinstance(item, _QueuedEvent):
                await item.lease.release()

    async def collect(self) -> tuple[str, Optional[ExecutionEvent]]:
        """Collect all events and return complete result.

        Returns:
            tuple: (accumulated_content, final_event)
        """
        content_chunks: list[str] = []
        final_event = None

        stream = self.stream()
        try:
            async for event in stream:
                if event.type == EventType.CHUNK.value:
                    if event.content:
                        content_chunks.append(event.content)
                elif event.type in (EventType.DONE.value, EventType.ERROR.value):
                    final_event = event
                    break
        finally:
            await stream.aclose()

        return "".join(content_chunks), final_event

    async def close(self) -> None:
        """Close emitter and send termination signal."""
        if self._closed:
            return
        await super().close()
        self._closed_event.set()
        try:
            self._queue.put_nowait(_QUEUE_COMPLETE)
        except asyncio.QueueFull:
            # A full queue already wakes the consumer. Once it drains the buffered
            # events, stream() observes _closed and exits without a sentinel.
            pass
