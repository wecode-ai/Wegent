# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Rate limiting module for API endpoints.

Uses slowapi with Redis backend for distributed rate limiting.
Rate limits are applied per API key for authenticated endpoints.
"""

import logging
from typing import Optional

from fastapi import Request
from slowapi import Limiter

from app.core.config import settings

logger = logging.getLogger(__name__)


def _get_redis_storage_uri() -> Optional[str]:
    """Get Redis URI for rate limit storage."""
    if not settings.RATE_LIMIT_ENABLED:
        return None
    return settings.REDIS_URL


def _check_redis_available() -> bool:
    """Check if Redis is available for rate limiting."""
    if not settings.RATE_LIMIT_ENABLED:
        return False
    try:
        import redis

        client = redis.from_url(settings.REDIS_URL, socket_connect_timeout=1)
        client.ping()
        return True
    except Exception as e:
        logger.warning(f"Redis not available for rate limiting, disabling: {e}")
        return False


def get_api_key_from_request(request: Request) -> str:
    """
    Extract API key from request headers for rate limiting.

    Priority: X-API-Key > Authorization Bearer > wegent-source

    Returns the API key or IP address as fallback.
    """
    # Try X-API-Key header first
    x_api_key = request.headers.get("X-API-Key", "")
    if x_api_key and x_api_key.startswith("wg-"):
        # Strip username suffix if present (api_key#username format)
        if "#" in x_api_key:
            x_api_key = x_api_key.split("#", 1)[0]
        return f"apikey:{x_api_key}"

    # Try Authorization Bearer token
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer ") and auth_header[7:].startswith("wg-"):
        api_key = auth_header[7:]
        # Strip username suffix if present
        if "#" in api_key:
            api_key = api_key.split("#", 1)[0]
        return f"apikey:{api_key}"

    # Try wegent-source header (legacy)
    wegent_source = request.headers.get("wegent-source", "")
    if wegent_source and wegent_source.startswith("wg-"):
        if "#" in wegent_source:
            wegent_source = wegent_source.split("#", 1)[0]
        return f"apikey:{wegent_source}"

    # Fallback to IP address if no API key found
    client_ip = request.client.host if request.client else "unknown"
    return f"ip:{client_ip}"


# Create limiter instance
# Uses Redis for distributed rate limiting across multiple workers
# Key function extracts API key from request headers
# Automatically disabled if Redis is not available
limiter = Limiter(
    key_func=get_api_key_from_request,
    storage_uri=_get_redis_storage_uri(),
    strategy="fixed-window",  # Simple and efficient
    default_limits=[],  # No default limits, apply per-endpoint
    enabled=_check_redis_available(),
)


def get_limiter() -> Limiter:
    """Get the rate limiter instance."""
    return limiter


def is_rate_limit_enabled() -> bool:
    """Check if rate limiting is enabled."""
    return settings.RATE_LIMIT_ENABLED
