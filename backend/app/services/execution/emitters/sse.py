# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
SSE result emitter.

Emits execution events in SSE format for OpenAPI streaming responses.
"""

import logging
from typing import AsyncIterator, Optional

from shared.models import EventType, ExecutionEvent

from .base import QueueBasedEmitter

logger = logging.getLogger(__name__)


class SSEResultEmitter(QueueBasedEmitter):
    """SSE result emitter.

    Used for OpenAPI streaming responses, converts events to SSE format.
    """

    def __init__(
        self,
        task_id: int,
        subtask_id: int,
        format_sse: bool = True,
    ):
        """Initialize the SSE emitter.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            format_sse: Whether to format output as SSE (default: True)
        """
        super().__init__(task_id, subtask_id)
        self.format_sse = format_sse

    async def stream_sse(self) -> AsyncIterator[str]:
        """Stream events in SSE format.

        Yields:
            str: SSE formatted event strings
        """
        async for event in self.stream():
            if self.format_sse:
                yield event.to_sse()
            else:
                yield str(event.to_dict())

    async def stream_content(self) -> AsyncIterator[str]:
        """Stream only content chunks.

        Used for simple text streaming scenarios.

        Yields:
            str: Content text
        """
        async for event in self.stream():
            if event.type == EventType.CHUNK.value and event.content:
                yield event.content
            elif event.type == EventType.ERROR.value:
                raise Exception(event.error or "Unknown error")


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
            yield event.to_sse()

    async def collect(self) -> tuple[str, Optional[ExecutionEvent]]:
        """Collect all content.

        Returns:
            tuple: (accumulated_content, final_event)

        Raises:
            Exception: If an error event is received
        """
        accumulated_content = ""
        final_event = None

        async for event in self.stream():
            if event.type == EventType.CHUNK.value:
                accumulated_content += event.content or ""
            elif event.type in (EventType.DONE.value, EventType.ERROR.value):
                final_event = event
                if event.type == EventType.ERROR.value:
                    raise Exception(event.error or "Unknown error")
                break

        return accumulated_content, final_event
