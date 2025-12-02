# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Base module for Direct Chat Service.

Provides shared HTTP client, base interfaces, and common utilities
for Chat and Dify direct chat implementations.
"""

import asyncio
import logging
from abc import ABC, abstractmethod
from typing import Any, AsyncIterator, Dict, List, Optional

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)

# Shell types that support direct chat mode
DIRECT_CHAT_SHELL_TYPES = ["Chat", "Dify"]

# Global HTTP client instance
_http_client: Optional[httpx.AsyncClient] = None
_client_lock = asyncio.Lock()


async def get_http_client() -> httpx.AsyncClient:
    """
    Get or create a shared async HTTP client with connection pooling.

    Returns:
        httpx.AsyncClient: Shared HTTP client instance
    """
    global _http_client
    async with _client_lock:
        if _http_client is None:
            _http_client = httpx.AsyncClient(
                timeout=httpx.Timeout(300.0, connect=10.0),
                limits=httpx.Limits(max_connections=100, max_keepalive_connections=20),
            )
            logger.info("Created new shared HTTP client for direct chat")
        return _http_client


async def close_http_client() -> None:
    """
    Close the shared HTTP client and release resources.
    Should be called during application shutdown.
    """
    global _http_client
    async with _client_lock:
        if _http_client is not None:
            await _http_client.aclose()
            _http_client = None
            logger.info("Closed shared HTTP client for direct chat")


class DirectChatService(ABC):
    """
    Abstract base class for direct chat services.

    Defines the interface that all direct chat implementations
    (Chat, Dify) must implement.
    """

    def __init__(self, task_id: int, subtask_id: int, user_id: int):
        """
        Initialize the direct chat service.

        Args:
            task_id: The task ID
            subtask_id: The subtask ID
            user_id: The user ID
        """
        self.task_id = task_id
        self.subtask_id = subtask_id
        self.user_id = user_id

    @abstractmethod
    async def chat_stream(
        self,
        prompt: str,
        config: Dict[str, Any],
        history: Optional[List[Dict[str, str]]] = None,
    ) -> AsyncIterator[str]:
        """
        Send a chat message and stream the response.

        Args:
            prompt: The user prompt/message
            config: Configuration dictionary containing API keys, base URLs, etc.
            history: Optional conversation history

        Yields:
            str: SSE-formatted response chunks
        """
        pass

    @abstractmethod
    async def cancel(self) -> bool:
        """
        Cancel the current chat operation.

        Returns:
            bool: True if cancellation was successful
        """
        pass


def is_direct_chat_shell_type(shell_type: str) -> bool:
    """
    Check if a shell type supports direct chat mode.

    Args:
        shell_type: The shell type to check

    Returns:
        bool: True if the shell type supports direct chat
    """
    return shell_type in DIRECT_CHAT_SHELL_TYPES
