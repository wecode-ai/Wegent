# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Traced HTTP client utilities.

Provides factory functions for creating HTTP clients that automatically
inject W3C Trace Context headers (traceparent/tracestate) and X-Request-ID
into all outbound requests. This acts as a cross-cutting concern (AOP-style)
so callers don't need to manually inject trace headers at every call site.

Usage:
    # Sync requests (drop-in replacement for requests module)
    from shared.utils.http_client import traced_session

    session = traced_session()
    session.get("http://example.com/api")   # auto-injects trace headers
    session.post("http://example.com/api", json=data)

    # Async httpx
    from shared.utils.http_client import traced_async_client

    async with traced_async_client(timeout=10.0) as client:
        response = await client.post(url, json=data)

    # Sync httpx
    from shared.utils.http_client import traced_sync_client

    with traced_sync_client(timeout=10.0) as client:
        response = client.post(url, json=data)
"""

import logging
from typing import Optional

import httpx
import requests

logger = logging.getLogger(__name__)


def _inject_trace_headers(headers: dict) -> dict:
    """Inject W3C trace context and X-Request-ID into headers dict.

    Safe to call even when OTEL is not enabled — will simply be a no-op.
    """
    try:
        from shared.telemetry.context import (
            get_request_id,
            inject_trace_context_to_headers,
        )

        headers = inject_trace_context_to_headers(headers)
        request_id = get_request_id()
        if request_id:
            headers["X-Request-ID"] = request_id
    except Exception as e:
        logger.debug(f"Failed to inject trace context headers: {e}")
    return headers


# ---------------------------------------------------------------------------
# requests.Session with automatic trace context injection
# ---------------------------------------------------------------------------


class TracedSession(requests.Session):
    """A requests.Session subclass that auto-injects trace context headers."""

    def request(self, method, url, **kwargs):
        headers = dict(kwargs.pop("headers", None) or {})
        headers = _inject_trace_headers(headers)
        kwargs["headers"] = headers
        return super().request(method, url, **kwargs)


def traced_session() -> TracedSession:
    """Create a new requests session with automatic trace context injection."""
    return TracedSession()


# ---------------------------------------------------------------------------
# httpx clients with automatic trace context injection
# ---------------------------------------------------------------------------


def _httpx_request_hook(request: httpx.Request) -> None:
    """Event hook that injects trace context into every httpx request (sync)."""
    headers = dict(request.headers)
    headers = _inject_trace_headers(headers)
    for key, value in headers.items():
        if key not in request.headers:
            request.headers[key] = value


async def _async_httpx_request_hook(request: httpx.Request) -> None:
    """Event hook that injects trace context into every httpx request (async).

    httpx.AsyncClient requires event hooks to be async functions.
    """
    _httpx_request_hook(request)


def traced_async_client(timeout: Optional[float] = None, **kwargs) -> httpx.AsyncClient:
    """Create an httpx.AsyncClient with automatic trace context injection.

    Args:
        timeout: Request timeout in seconds
        **kwargs: Additional arguments passed to httpx.AsyncClient

    Returns:
        httpx.AsyncClient with trace context event hook
    """
    event_hooks = kwargs.pop("event_hooks", {})
    existing_request_hooks = event_hooks.get("request", [])
    event_hooks["request"] = [_async_httpx_request_hook] + list(existing_request_hooks)

    if timeout is not None:
        kwargs["timeout"] = timeout

    return httpx.AsyncClient(event_hooks=event_hooks, **kwargs)


def traced_sync_client(timeout: Optional[float] = None, **kwargs) -> httpx.Client:
    """Create an httpx.Client with automatic trace context injection.

    Args:
        timeout: Request timeout in seconds
        **kwargs: Additional arguments passed to httpx.Client

    Returns:
        httpx.Client with trace context event hook
    """
    event_hooks = kwargs.pop("event_hooks", {})
    existing_request_hooks = event_hooks.get("request", [])
    event_hooks["request"] = [_httpx_request_hook] + list(existing_request_hooks)

    if timeout is not None:
        kwargs["timeout"] = timeout

    return httpx.Client(event_hooks=event_hooks, **kwargs)
