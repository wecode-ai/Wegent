# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
SSE result emitter.

Emits execution events in SSE format for OpenAPI streaming responses.
"""

import logging
from typing import AsyncIterator, Optional

from app.core.bounded_executor import BoundedExecutor
from app.core.byte_admission import LoopLocalByteAdmission
from shared.models import EventType, ExecutionEvent

from .base import DEFAULT_QUEUE_MAXSIZE, QueueBasedEmitter

logger = logging.getLogger(__name__)

_SSE_CODEC_EXECUTOR = BoundedExecutor(
    max_workers=4,
    max_in_flight=16,
    thread_name_prefix="wegent-sse-codec",
)


def _serialize_sse_event(event: ExecutionEvent) -> str:
    """Serialize one client event outside the sole Uvicorn event loop."""
    return event.to_sse()


def _stringify_event(event: ExecutionEvent) -> str:
    """Build the legacy non-SSE representation outside the event loop."""
    return str(event.to_dict())


async def _serialize_sse_event_nonblocking(event: ExecutionEvent) -> str:
    """Serialize with bounded admission while preserving caller ordering."""
    return await _SSE_CODEC_EXECUTOR.run(_serialize_sse_event, event)


class SSEResultEmitter(QueueBasedEmitter):
    """SSE result emitter.

    Used for OpenAPI streaming responses, converts events to SSE format.
    """

    def __init__(
        self,
        task_id: int,
        subtask_id: int,
        format_sse: bool = True,
        maxsize: int = DEFAULT_QUEUE_MAXSIZE,
        *,
        byte_admission: LoopLocalByteAdmission | None = None,
    ):
        """Initialize the SSE emitter.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            format_sse: Whether to format output as SSE (default: True)
            maxsize: Maximum buffered event count before applying backpressure
            byte_admission: Shared retained-byte budget for queued events
        """
        super().__init__(
            task_id,
            subtask_id,
            maxsize=maxsize,
            byte_admission=byte_admission,
        )
        self.format_sse = format_sse

    async def stream_sse(self) -> AsyncIterator[str]:
        """Stream events in SSE format.

        Yields:
            str: SSE formatted event strings
        """
        events = self.stream()
        try:
            async for event in events:
                if self.format_sse:
                    yield await _serialize_sse_event_nonblocking(event)
                else:
                    yield await _SSE_CODEC_EXECUTOR.run(_stringify_event, event)
        finally:
            await events.aclose()

    async def stream_content(self) -> AsyncIterator[str]:
        """Stream only content chunks.

        Used for simple text streaming scenarios.

        Yields:
            str: Content text
        """
        events = self.stream()
        try:
            async for event in events:
                if event.type == EventType.CHUNK.value and event.content:
                    yield event.content
                elif event.type == EventType.ERROR.value:
                    raise Exception(event.error or "Unknown error")
        finally:
            await events.aclose()


class DirectSSEEmitter:
    """Direct SSE emitter.

    Does not use queue, directly forwards events from upstream source.
    Used for ExecutionDispatcher.dispatch_sse_stream scenarios.
    """

    def __init__(
        self,
        task_id: int,
        subtask_id: int,
        upstream: AsyncIterator[ExecutionEvent],
    ):
        """Initialize the direct SSE emitter.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            upstream: Upstream event source
        """
        self.task_id = task_id
        self.subtask_id = subtask_id
        self.upstream = upstream

    async def stream(self) -> AsyncIterator[ExecutionEvent]:
        """Directly forward upstream events.

        Yields:
            ExecutionEvent: Events from upstream
        """
        async for event in self.upstream:
            yield event

    async def stream_sse(self) -> AsyncIterator[str]:
        """Stream in SSE format.

        Yields:
            str: SSE formatted event strings
        """
        async for event in self.stream():
            yield await _serialize_sse_event_nonblocking(event)

    async def collect(self) -> tuple[str, Optional[ExecutionEvent]]:
        """Collect all content.

        Returns:
            tuple: (accumulated_content, final_event)

        Raises:
            Exception: If an error event is received
        """
        content_chunks: list[str] = []
        final_event = None

        async for event in self.stream():
            if event.type == EventType.CHUNK.value:
                if event.content:
                    content_chunks.append(event.content)
            elif event.type in (EventType.DONE.value, EventType.ERROR.value):
                final_event = event
                if event.type == EventType.ERROR.value:
                    raise Exception(event.error or "Unknown error")
                break

        return "".join(content_chunks), final_event
