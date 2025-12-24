# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Base classes and shared HTTP client for Chat Shell service.

This module provides:
- Shared HTTP client with connection pooling
- Base class for chat services
- Common utilities for LLM API calls
"""

import asyncio
import logging
from typing import Optional

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)

# Module-level HTTP client instance
_http_client: Optional[httpx.AsyncClient] = None
_client_lock = asyncio.Lock()


async def get_http_client() -> httpx.AsyncClient:
    """
    Get or create the shared HTTP client instance.

    Uses connection pooling for better performance when making
    multiple requests to LLM APIs.

    Returns:
        httpx.AsyncClient: Shared HTTP client instance
    """
    global _http_client

    if _http_client is None:
        async with _client_lock:
            # Double-check after acquiring lock
            if _http_client is None:
                _http_client = httpx.AsyncClient(
                    timeout=httpx.Timeout(
                        timeout=settings.CHAT_API_TIMEOUT_SECONDS,  # Total timeout
                        connect=10.0,  # Connection timeout
                        read=60.0,  # Read timeout per chunk (important for streaming)
                    ),
                    limits=httpx.Limits(
                        max_connections=100,
                        max_keepalive_connections=20,
                    ),
                    follow_redirects=True,
                )
                logger.info("Created shared HTTP client for chat service")

    return _http_client


async def close_http_client():
    """
    Close the shared HTTP client.

    Should be called during application shutdown to properly
    release resources.
    """
    global _http_client

    if _http_client is not None:
        async with _client_lock:
            if _http_client is not None:
                await _http_client.aclose()
                _http_client = None
                logger.info("Closed shared HTTP client for chat service")


class ChatServiceBase:
    """
    Base class for chat services.

    Provides common functionality for direct LLM API calls.
    """

    # Shell types that support direct chat (bypass executor)
    DIRECT_CHAT_SHELL_TYPES = ["Chat"]

    @classmethod
    def is_direct_chat_shell(cls, shell_type: str) -> bool:
        """
        Check if the shell type supports direct chat.

        Args:
            shell_type: The shell type to check

        Returns:
            bool: True if the shell type supports direct chat
        """
        return shell_type in cls.DIRECT_CHAT_SHELL_TYPES
