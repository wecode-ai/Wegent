# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Composite result emitter.

Emits events to multiple emitters simultaneously.
"""

import asyncio
import logging
from typing import List, Optional

from shared.models import ExecutionEvent

from .protocol import ResultEmitter

logger = logging.getLogger(__name__)


class CompositeResultEmitter:
    """Composite result emitter.

    Sends events to multiple emitters simultaneously, supports flexible composition.
    Example: Push to both WebSocket and Callback at the same time.
    """

    def __init__(self, emitters: List[ResultEmitter]):
        """Initialize the composite emitter.

        Args:
            emitters: List of emitters to send events to
        """
        self.emitters = emitters

    async def emit(self, event: ExecutionEvent) -> None:
        """Send event to all emitters.

        Args:
            event: Execution event to emit
        """
        tasks = [emitter.emit(event) for emitter in self.emitters]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        for i, result in enumerate(results):
            if isinstance(result, Exception):
                logger.error(f"[CompositeResultEmitter] Emitter {i} failed: {result}")

    async def emit_start(
        self,
        task_id: int,
        subtask_id: int,
        message_id: Optional[int] = None,
        **kwargs,
    ) -> None:
        """Send start event to all emitters.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            message_id: Optional message ID
            **kwargs: Additional event parameters
        """
        tasks = [
            emitter.emit_start(task_id, subtask_id, message_id=message_id, **kwargs)
            for emitter in self.emitters
        ]
        await asyncio.gather(*tasks, return_exceptions=True)

    async def emit_chunk(
        self,
        task_id: int,
        subtask_id: int,
        content: str,
        offset: int,
        **kwargs,
    ) -> None:
        """Send content chunk event to all emitters.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            content: Content chunk
            offset: Current offset
            **kwargs: Additional event parameters
        """
        tasks = [
            emitter.emit_chunk(task_id, subtask_id, content, offset, **kwargs)
            for emitter in self.emitters
        ]
        await asyncio.gather(*tasks, return_exceptions=True)

    async def emit_done(
        self,
        task_id: int,
        subtask_id: int,
        result: Optional[dict] = None,
        **kwargs,
    ) -> None:
        """Send done event to all emitters.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            result: Optional result data
            **kwargs: Additional event parameters
        """
        tasks = [
            emitter.emit_done(task_id, subtask_id, result=result, **kwargs)
            for emitter in self.emitters
        ]
        await asyncio.gather(*tasks, return_exceptions=True)

    async def emit_error(
        self,
        task_id: int,
        subtask_id: int,
        error: str,
        **kwargs,
    ) -> None:
        """Send error event to all emitters.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            error: Error message
            **kwargs: Additional event parameters
        """
        tasks = [
            emitter.emit_error(task_id, subtask_id, error, **kwargs)
            for emitter in self.emitters
        ]
        await asyncio.gather(*tasks, return_exceptions=True)

    async def close(self) -> None:
        """Close all emitters."""
        tasks = [emitter.close() for emitter in self.emitters]
        await asyncio.gather(*tasks, return_exceptions=True)

    def add_emitter(self, emitter: ResultEmitter) -> None:
        """Add an emitter.

        Args:
            emitter: Emitter to add
        """
        self.emitters.append(emitter)

    def remove_emitter(self, emitter: ResultEmitter) -> None:
        """Remove an emitter.

        Args:
            emitter: Emitter to remove
        """
        if emitter in self.emitters:
            self.emitters.remove(emitter)
