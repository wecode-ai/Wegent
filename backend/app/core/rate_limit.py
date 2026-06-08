# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Rate limiting module for API endpoints.

Uses slowapi with Redis backend for distributed rate limiting.
Rate limits are applied per API key for authenticated endpoints.
"""

import logging
import time
from enum import Enum
from hashlib import sha256
from typing import Optional

from fastapi import Request
from slowapi import Limiter

from app.core.config import settings
from app.services.auth.task_token import extract_token_from_header

logger = logging.getLogger(__name__)
_redis_rate_limit_client = None


class ExternalMcpRateLimitStatus(str, Enum):
    """Result of an external MCP rate-limit check."""

    ALLOWED = "allowed"
    LIMITED = "limited"
    UNAVAILABLE = "unavailable"


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

        client = redis.from_url(
            settings.REDIS_URL,
            socket_connect_timeout=1,
            socket_timeout=1,
        )
        client.ping()
        return True
    except Exception as e:
        logger.warning(f"Redis not available for rate limiting, disabling: {e}")
        return False


def _get_rate_limit_redis_client(*, require_global_enabled: bool = True):
    """Get a cached Redis client for custom rate limit checks."""
    global _redis_rate_limit_client
    if require_global_enabled and not settings.RATE_LIMIT_ENABLED:
        return None
    if _redis_rate_limit_client is not None:
        return _redis_rate_limit_client
    try:
        import redis

        client = redis.from_url(
            settings.REDIS_URL,
            socket_connect_timeout=1,
            socket_timeout=1,
        )
        client.ping()
        _redis_rate_limit_client = client
        return client
    except Exception as e:
        logger.warning(f"Redis not available for custom rate limiting: {e}")
        return None


def hash_rate_limit_value(value: str) -> str:
    """Hash sensitive rate limit dimensions before storing them in Redis keys."""
    return sha256(value.encode("utf-8")).hexdigest()[:32]


def _build_external_mcp_rate_limit_keys(request: Request) -> list[str]:
    client_ip = request.client.host if request.client else "unknown"
    keys = [f"ip:{hash_rate_limit_value(client_ip)}"]

    auth_header = request.headers.get("authorization", "")
    token = extract_token_from_header(auth_header)
    if token:
        keys.append(f"token:{hash_rate_limit_value(token)}")

    return keys


def is_external_mcp_rate_limited(
    request: Request,
    *,
    namespace: str,
    limit: int,
    window_seconds: int,
) -> bool:
    """Apply Redis-backed fixed-window rate limiting to external MCP requests.

    The limiter checks both IP and token dimensions. Any exceeded dimension blocks
    the request. Raw tokens are never stored in Redis keys.
    """
    return (
        check_external_mcp_rate_limit(
            request,
            namespace=namespace,
            limit=limit,
            window_seconds=window_seconds,
        )
        == ExternalMcpRateLimitStatus.LIMITED
    )


def check_external_mcp_rate_limit(
    request: Request,
    *,
    namespace: str,
    limit: int,
    window_seconds: int,
) -> ExternalMcpRateLimitStatus:
    """Apply external MCP rate limiting and report limiter availability."""
    if limit <= 0 or window_seconds <= 0:
        return ExternalMcpRateLimitStatus.ALLOWED

    return check_external_mcp_dimension_rate_limit(
        dimensions=_build_external_mcp_rate_limit_keys(request),
        namespace=namespace,
        limit=limit,
        window_seconds=window_seconds,
    )


def is_external_mcp_dimension_rate_limited(
    *,
    dimensions: list[str],
    namespace: str,
    limit: int,
    window_seconds: int,
) -> bool:
    """Apply Redis-backed fixed-window rate limiting to explicit dimensions."""
    return (
        check_external_mcp_dimension_rate_limit(
            dimensions=dimensions,
            namespace=namespace,
            limit=limit,
            window_seconds=window_seconds,
        )
        == ExternalMcpRateLimitStatus.LIMITED
    )


def check_external_mcp_dimension_rate_limit(
    *,
    dimensions: list[str],
    namespace: str,
    limit: int,
    window_seconds: int,
) -> ExternalMcpRateLimitStatus:
    """Apply Redis-backed fixed-window rate limiting to explicit dimensions."""
    if not dimensions or limit <= 0 or window_seconds <= 0:
        return ExternalMcpRateLimitStatus.ALLOWED

    client = _get_rate_limit_redis_client(require_global_enabled=False)
    if client is None:
        return ExternalMcpRateLimitStatus.UNAVAILABLE

    window = int(time.time() // window_seconds)
    keys = [
        f"external_kb_mcp:rate:{namespace}:{dimension}:{window}"
        for dimension in dimensions
    ]

    try:
        pipe = client.pipeline()
        for key in keys:
            pipe.incr(key)
            pipe.expire(key, window_seconds + 1)
        results = pipe.execute()
    except Exception as e:
        logger.warning(f"External MCP rate limit check failed: {e}")
        return ExternalMcpRateLimitStatus.UNAVAILABLE

    counts = results[::2]
    if any(count > limit for count in counts):
        return ExternalMcpRateLimitStatus.LIMITED
    return ExternalMcpRateLimitStatus.ALLOWED


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
