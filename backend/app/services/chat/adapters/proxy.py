# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""ChatProxy - Factory for selecting Chat Shell adapter.

This module provides the ChatProxy class that selects the appropriate
adapter based on configuration:
- Package mode: Import and use Chat Shell directly (in-process)
- HTTP mode: Use HTTP/SSE to communicate with remote Chat Shell service
"""

import logging
from typing import AsyncIterator, Optional

from app.core.config import settings

from .interface import ChatEvent, ChatInterface, ChatRequest

logger = logging.getLogger(__name__)


class ChatProxy(ChatInterface):
    """Proxy class that routes to appropriate Chat Shell adapter.

    Based on CHAT_SHELL_MODE environment variable:
    - "package": Uses PackageAdapter (direct import)
    - "http": Uses HTTPAdapter (remote service)
    """

    def __init__(self):
        """Initialize ChatProxy with configured adapter."""
        self._adapter: Optional[ChatInterface] = None

    def _get_adapter(self) -> ChatInterface:
        """Get or create the adapter based on configuration."""
        if self._adapter is None:
            mode = settings.CHAT_SHELL_MODE.lower()

            if mode == "http":
                logger.info(
                    "[CHAT_PROXY] Using HTTP adapter: url=%s",
                    settings.CHAT_SHELL_URL,
                )
                from .http import HTTPAdapter

                self._adapter = HTTPAdapter(
                    base_url=settings.CHAT_SHELL_URL,
                    token=settings.INTERNAL_SERVICE_TOKEN,
                )
            else:
                # Default to package mode - use existing chat service
                logger.info("[CHAT_PROXY] Using package adapter (in-process)")
                self._adapter = PackageAdapter()

        return self._adapter

    async def chat(self, request: ChatRequest) -> AsyncIterator[ChatEvent]:
        """Route chat request to adapter.

        Args:
            request: Chat request data

        Yields:
            ChatEvent: Events from chat processing
        """
        adapter = self._get_adapter()
        async for event in adapter.chat(request):
            yield event

    async def resume(
        self, subtask_id: int, offset: int = 0
    ) -> AsyncIterator[ChatEvent]:
        """Route resume request to adapter.

        Args:
            subtask_id: Subtask ID to resume
            offset: Character offset to resume from

        Yields:
            ChatEvent: Events from the resumed position
        """
        adapter = self._get_adapter()
        async for event in adapter.resume(subtask_id, offset):
            yield event

    async def cancel(self, subtask_id: int) -> bool:
        """Route cancel request to adapter.

        For cancellation, we also use Redis for immediate signaling.

        Args:
            subtask_id: Subtask ID to cancel

        Returns:
            bool: True if cancellation was successful
        """
        # Use Redis for immediate cancellation (cross-worker support)
        from app.services.chat.storage import session_manager

        await session_manager.cancel_stream(subtask_id)

        # Also call adapter cancel for HTTP mode cleanup
        adapter = self._get_adapter()
        return await adapter.cancel(subtask_id)


class PackageAdapter(ChatInterface):
    """Package adapter that uses existing chat service in-process.

    This adapter provides backward compatibility by using the existing
    WebSocketStreamingHandler directly without going through HTTP.
    """

    async def chat(self, request: ChatRequest) -> AsyncIterator[ChatEvent]:
        """Process chat using existing chat service.

        This is a pass-through to existing functionality.
        The actual streaming is handled by WebSocketStreamingHandler.

        Args:
            request: Chat request data

        Yields:
            ChatEvent: Events from chat processing
        """
        from .interface import ChatEventType as EventType

        logger.info(
            "[PACKAGE_ADAPTER] Chat request routed to existing handler: "
            "task_id=%d, subtask_id=%d",
            request.task_id,
            request.subtask_id,
        )

        # In package mode, the existing WebSocket flow handles streaming
        # This adapter is mainly used for consistency with the interface
        # Actual streaming happens via trigger_ai_response -> WebSocketStreamingHandler

        # Emit a start event to indicate the request was received
        yield ChatEvent(
            type=EventType.START,
            data={
                "task_id": request.task_id,
                "subtask_id": request.subtask_id,
                "message": "Request received, streaming via WebSocket",
            },
        )

    async def resume(
        self, subtask_id: int, offset: int = 0
    ) -> AsyncIterator[ChatEvent]:
        """Resume streaming from Redis cache.

        Args:
            subtask_id: Subtask ID to resume
            offset: Character offset to resume from

        Yields:
            ChatEvent: Events from the resumed position
        """
        from app.services.chat.storage import session_manager

        from .interface import ChatEventType as EventType

        cached_content = await session_manager.get_streaming_content(subtask_id)

        if cached_content and offset < len(cached_content):
            remaining = cached_content[offset:]
            yield ChatEvent(
                type=EventType.CHUNK,
                data={
                    "content": remaining,
                    "offset": offset,
                    "subtask_id": subtask_id,
                },
            )

    async def cancel(self, subtask_id: int) -> bool:
        """Cancel via session manager.

        Args:
            subtask_id: Subtask ID to cancel

        Returns:
            bool: True if cancellation was successful
        """
        from app.services.chat.storage import session_manager

        return await session_manager.cancel_stream(subtask_id)


# Global proxy instance
chat_proxy = ChatProxy()
