# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Base classes and utilities for direct chat services.

This module provides:
- HTTP client manager for shared connection pool
- Base class for direct chat services
- Common utilities and constants
"""

import asyncio
import logging
from abc import ABC, abstractmethod
from typing import Any, AsyncGenerator, Dict, List, Optional

import httpx

logger = logging.getLogger(__name__)


class ChatShellTypes:
    """Shell types that support direct chat mode"""
    CHAT = "Chat"
    DIFY = "Dify"

    @classmethod
    def is_direct_chat_shell(cls, shell_type: str) -> bool:
        """Check if shell type supports direct chat"""
        return shell_type in [cls.CHAT, cls.DIFY]


class HttpClientManager:
    """
    Manages shared HTTP client for direct chat services.

    Uses connection pooling to improve performance and resource utilization.
    """

    def __init__(self):
        self._client: Optional[httpx.AsyncClient] = None
        self._lock = asyncio.Lock()

    async def get_client(self) -> httpx.AsyncClient:
        """
        Get or create the shared HTTP client.

        Returns:
            httpx.AsyncClient: Shared HTTP client instance
        """
        if self._client is None or self._client.is_closed:
            async with self._lock:
                # Double check after acquiring lock
                if self._client is None or self._client.is_closed:
                    self._client = httpx.AsyncClient(
                        timeout=httpx.Timeout(300.0, connect=10.0),
                        limits=httpx.Limits(
                            max_connections=100,
                            max_keepalive_connections=20
                        ),
                        follow_redirects=True,
                    )
                    logger.info("Created new HTTP client for direct chat services")
        return self._client

    async def close(self) -> None:
        """Close the HTTP client and release resources"""
        if self._client and not self._client.is_closed:
            await self._client.aclose()
            self._client = None
            logger.info("Closed HTTP client for direct chat services")


# Global HTTP client manager instance
http_client_manager = HttpClientManager()


class DirectChatService(ABC):
    """
    Abstract base class for direct chat services.

    Provides common interface for Chat and Dify services.
    """

    @abstractmethod
    async def chat_stream(
        self,
        task_id: int,
        subtask_id: int,
        prompt: str,
        config: Dict[str, Any],
    ) -> AsyncGenerator[str, None]:
        """
        Execute streaming chat and yield SSE-formatted responses.

        Args:
            task_id: Task ID for session management
            subtask_id: Subtask ID for status updates
            prompt: User message
            config: Service configuration (API keys, model settings, etc.)

        Yields:
            str: SSE-formatted response chunks
        """
        pass

    @abstractmethod
    async def cancel(self, task_id: int) -> bool:
        """
        Cancel an ongoing chat request.

        Args:
            task_id: Task ID to cancel

        Returns:
            bool: True if cancellation was successful
        """
        pass

    def _format_sse_event(
        self,
        event_type: str,
        data: Dict[str, Any]
    ) -> str:
        """
        Format data as SSE event.

        Args:
            event_type: Event type (message, error, done, etc.)
            data: Event data

        Returns:
            str: SSE-formatted string
        """
        import json
        data["event"] = event_type
        return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"

    def _format_message_event(self, content: str) -> str:
        """Format a message content event"""
        return self._format_sse_event("message", {"content": content})

    def _format_done_event(self, full_response: str = "") -> str:
        """Format a completion event"""
        return self._format_sse_event("done", {"done": True, "fullResponse": full_response})

    def _format_error_event(self, error: str) -> str:
        """Format an error event"""
        return self._format_sse_event("error", {"error": error})
