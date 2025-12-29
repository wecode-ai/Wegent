# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Shared HTTP client for Simple Chat service.

Provides connection pooling for better performance when making
multiple requests to LLM APIs.
"""

import asyncio
import logging

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)

# Module-level HTTP client instance
_http_client: httpx.AsyncClient | None = None
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
                        timeout=settings.CHAT_API_TIMEOUT_SECONDS,
                        connect=10.0,
                        read=settings.CHAT_API_TIMEOUT_SECONDS,
                    ),
                    limits=httpx.Limits(
                        max_connections=100,
                        max_keepalive_connections=20,
                    ),
                    follow_redirects=True,
                )
                logger.info("Created shared HTTP client for simple chat service")

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
                logger.info("Closed shared HTTP client for simple chat service")
