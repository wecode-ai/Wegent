# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Session manager for Chat Shell Service.

Manages cancellation state for streaming chat requests using local asyncio.Event.
For HTTP mode, the connection lifecycle handles cancellation naturally.
"""

import asyncio
import logging
from typing import Dict, Optional

logger = logging.getLogger(__name__)


class SessionManager:
    """
    Manages chat session state.

    Handles cancellation for streaming chat requests using local asyncio.Event.
    In HTTP mode, closing the connection is the primary cancellation mechanism.
    """

    def __init__(self):
        # Local asyncio events for in-process cancellation
        self._local_events: Dict[int, asyncio.Event] = {}

    # ==================== Cancellation Management ====================

    async def register_stream(self, subtask_id: int) -> asyncio.Event:
        """
        Register a new streaming request and return its cancellation event.
        """
        cancel_event = asyncio.Event()
        self._local_events[subtask_id] = cancel_event
        return cancel_event

    async def cancel_stream(self, subtask_id: int) -> bool:
        """Request cancellation of a streaming request."""
        local_event = self._local_events.get(subtask_id)
        if local_event:
            local_event.set()
            return True
        return False

    async def unregister_stream(self, subtask_id: int) -> None:
        """Unregister a streaming request."""
        if subtask_id in self._local_events:
            del self._local_events[subtask_id]

    def is_cancelled(self, subtask_id: int) -> bool:
        """Check if a streaming request has been cancelled."""
        local_event = self._local_events.get(subtask_id)
        return local_event is not None and local_event.is_set()

    # ==================== No-op methods for compatibility ====================
    # These methods exist for interface compatibility but do nothing
    # as Redis caching is not needed in HTTP mode

    async def save_streaming_content(
        self, subtask_id: int, content: str, expire: Optional[int] = None
    ) -> bool:
        """No-op: streaming content caching not needed in HTTP mode."""
        return True

    async def get_streaming_content(self, subtask_id: int) -> Optional[str]:
        """No-op: streaming content caching not needed in HTTP mode."""
        return None

    async def delete_streaming_content(self, subtask_id: int) -> bool:
        """No-op: streaming content caching not needed in HTTP mode."""
        return True

    async def publish_streaming_chunk(self, subtask_id: int, chunk: str) -> bool:
        """No-op: Redis pub/sub not needed in HTTP mode."""
        return True

    async def publish_streaming_done(
        self, subtask_id: int, result: Optional[dict] = None
    ) -> bool:
        """No-op: Redis pub/sub not needed in HTTP mode."""
        return True


# Global session manager instance
session_manager = SessionManager()
