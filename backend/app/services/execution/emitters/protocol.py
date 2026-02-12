# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Protocol definitions for result emitters.

Defines the ResultEmitter and StreamableEmitter protocols that all
result emitters must implement.
"""

from abc import ABC, abstractmethod
from typing import AsyncIterator, Optional, Protocol, runtime_checkable

from shared.models import ExecutionEvent


@runtime_checkable
class ResultEmitter(Protocol):
    """Unified result emitter protocol.

    All result emission methods must implement this protocol.
    Supports three modes:
    - Sync streaming: Return event stream via stream method
    - Sync non-streaming: Wait for complete result via collect method
    - Async: Push events via emit method
    """

    async def emit(self, event: ExecutionEvent) -> None:
        """Emit a single event.

        Used for async mode, pushes event to target.

        Args:
            event: Execution event to emit
        """
        ...

    async def emit_start(
        self,
        task_id: int,
        subtask_id: int,
        message_id: Optional[int] = None,
        **kwargs,
    ) -> None:
        """Emit start event.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            message_id: Optional message ID for ordering
            **kwargs: Additional event parameters
        """
        ...

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
            task_id: Task ID
            subtask_id: Subtask ID
            content: Content chunk
            offset: Current offset in full response
            **kwargs: Additional event parameters
        """
        ...

    async def emit_done(
        self,
        task_id: int,
        subtask_id: int,
        result: Optional[dict] = None,
        **kwargs,
    ) -> None:
        """Emit done event.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            result: Optional result data
            **kwargs: Additional event parameters
        """
        ...

    async def emit_error(
        self,
        task_id: int,
        subtask_id: int,
        error: str,
        **kwargs,
    ) -> None:
        """Emit error event.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            error: Error message
            **kwargs: Additional event parameters
        """
        ...

    async def emit_cancelled(
        self,
        task_id: int,
        subtask_id: int,
        **kwargs,
    ) -> None:
        """Emit cancelled event.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            **kwargs: Additional event parameters
        """
        ...

    async def close(self) -> None:
        """Close the emitter and release resources."""
        ...


class StreamableEmitter(ResultEmitter, ABC):
    """Streamable emitter base class.

    In addition to basic emit functionality, supports use as async iterator.
    """

    @abstractmethod
    def stream(self) -> AsyncIterator[ExecutionEvent]:
        """Return event stream.

        Used for sync streaming mode, caller can iterate to get events.

        Yields:
            ExecutionEvent: Execution events
        """
        ...

    @abstractmethod
    async def collect(self) -> tuple[str, Optional[ExecutionEvent]]:
        """Collect all events and return complete result.

        Used for sync non-streaming mode, blocks until DONE or ERROR event.

        Returns:
            tuple: (accumulated_content, final_event)
        """
        ...
