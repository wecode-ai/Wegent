# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Rate limiting module for API endpoints.

Uses slowapi with Redis backend for distributed rate limiting.
Rate limits are applied per API key for authenticated endpoints.
"""

import asyncio
import functools
import inspect
import logging
import time
from enum import Enum
from hashlib import sha256
from typing import Any, Callable, Optional

from fastapi import Request
from slowapi import Limiter
from starlette.responses import Response

from app.core.blocking_work import run_rate_limit_io
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
    storage_options={"socket_connect_timeout": 1, "socket_timeout": 1},
    strategy="fixed-window",  # Simple and efficient
    default_limits=[],  # No default limits, apply per-endpoint
    enabled=_check_redis_available(),
)


def get_limiter() -> Limiter:
    """Get the rate limiter instance."""
    return limiter


def nonblocking_limit(
    rate_limiter: Limiter,
    limit_value: str | Callable[..., str],
    **limit_options: Any,
) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """Apply a SlowAPI limit without running its Redis check on the event loop.

    SlowAPI's async decorator executes the synchronous limits storage call before
    awaiting the endpoint. Register the route with SlowAPI as usual, then perform
    that exact check in Starlette's worker pool. Limit evaluation, error handling,
    response headers, and the shared Redis storage remain unchanged.
    """

    def decorator(endpoint: Callable[..., Any]) -> Callable[..., Any]:
        if not asyncio.iscoroutinefunction(endpoint):
            raise TypeError("nonblocking_limit requires an async endpoint")

        # Register the original endpoint and its limits in SlowAPI's route maps.
        # The generated wrapper is intentionally not used because it performs the
        # synchronous storage check on the event-loop thread.
        rate_limiter.limit(limit_value, **limit_options)(endpoint)

        parameters = list(inspect.signature(endpoint).parameters.values())
        request_index = next(
            (
                index
                for index, parameter in enumerate(parameters)
                if parameter.name == "request"
            ),
            None,
        )
        if request_index is None:
            raise TypeError('limited endpoint must define a "request" parameter')

        @functools.wraps(endpoint)
        async def wrapper(*args: Any, **kwargs: Any) -> Response:
            request = kwargs.get(
                "request",
                args[request_index] if len(args) > request_index else None,
            )
            if not isinstance(request, Request):
                raise TypeError("request must be a Starlette Request")

            if rate_limiter.enabled:
                if rate_limiter._auto_check and not getattr(  # noqa: SLF001
                    request.state,
                    "_rate_limiting_complete",
                    False,
                ):
                    await run_rate_limit_io(
                        rate_limiter._check_request_limit,  # noqa: SLF001
                        request,
                        endpoint,
                        False,
                    )
                    request.state._rate_limiting_complete = True

            response = await endpoint(*args, **kwargs)
            if rate_limiter.enabled:
                if not isinstance(response, Response):
                    rate_limiter._inject_headers(  # noqa: SLF001
                        kwargs.get("response"),
                        request.state.view_rate_limit,
                    )
                else:
                    rate_limiter._inject_headers(  # noqa: SLF001
                        response,
                        request.state.view_rate_limit,
                    )
            return response

        return wrapper

    return decorator


def is_rate_limit_enabled() -> bool:
    """Check if rate limiting is enabled."""
    return settings.RATE_LIMIT_ENABLED
