# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Simple SSE emitter for streaming responses."""

import json
from typing import Any


class SSEEmitter:
    """Simple Server-Sent Events emitter.

    Collects events in a queue for SSE streaming.
    Used for backend-to-frontend streaming over HTTP.
    """

    def __init__(self):
        """Initialize SSE emitter with empty event queue."""
        self._events: list[str] = []

    @staticmethod
    def _format_sse(data: dict[str, Any]) -> str:
        """Format data as SSE event string."""
        return f"data: {json.dumps(data)}\n\n"

    async def emit_chunk(self, content: str, offset: int, subtask_id: int) -> None:
        """Emit a content chunk."""
        self._events.append(self._format_sse({"content": content, "done": False}))

    async def emit_done(
        self,
        task_id: int,
        subtask_id: int,
        offset: int,
        result: dict[str, Any],
        message_id: int | None = None,
    ) -> None:
        """Emit completion event."""
        self._events.append(
            self._format_sse({"content": "", "done": True, "result": result})
        )

    async def emit_error(self, subtask_id: int, error: str) -> None:
        """Emit error event."""
        self._events.append(self._format_sse({"error": error}))

    async def emit_cancelled(self, subtask_id: int) -> None:
        """Emit cancellation event."""
        self._events.append(
            self._format_sse({"content": "", "done": True, "cancelled": True})
        )

    def get_event(self) -> str | None:
        """Get and remove the next event from the queue."""
        if self._events:
            return self._events.pop(0)
        return None

    def has_events(self) -> bool:
        """Check if there are pending events."""
        return len(self._events) > 0
