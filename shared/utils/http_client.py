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

import ipaddress
import logging
import os
from typing import Optional

import httpx
import requests

logger = logging.getLogger(__name__)

_NO_PROXY_ENV_VARS = ("NO_PROXY", "no_proxy")
_NO_PROXY_CIDR_PREFIX = "/"


def _is_cidr_entry(entry: str) -> bool:
    """Return True only for entries that are IP networks.

    ``NO_PROXY`` also accepts URL forms such as ``http://localhost``, which
    contain a slash and must be preserved.
    """
    if _NO_PROXY_CIDR_PREFIX not in entry:
        return False
    try:
        ipaddress.ip_network(entry, strict=False)
    except ValueError:
        return False
    return True


def sanitize_no_proxy_env() -> list[str]:
    """Drop NO_PROXY entries that httpx cannot parse.

    httpx converts every NO_PROXY entry into a URL pattern when a client is
    constructed. CIDR ranges such as ``fc00::/7`` are classified as IPv6
    hostnames, so the generated pattern ``all://[fc00::/7]`` fails with
    ``httpx.InvalidURL: Invalid port: ':'`` and aborts client construction
    before any request is sent. IPv4 ranges were never effective either, since
    ``all://192.0.2.0/24`` is parsed as the single host ``192.0.2.0``.

    Host patterns cannot express CIDR ranges, so those entries are dropped and
    logged; destinations inside the removed ranges fall back to the configured
    proxy instead of failing every client construction in the process. Only
    real IP networks are removed; URL-form entries such as
    ``NO_PROXY=http://localhost`` keep working.

    The change targets the process environment on purpose: every httpx client
    built with ``trust_env=True`` derives its proxy mounts from ``NO_PROXY``,
    so unsupported entries also break unrelated plain clients such as the ones
    in ``app.services.oidc`` or ``app.services.channels``. Restoring the
    variables after a traced client is constructed would leave those clients
    failing. The call is idempotent and only removes entries httpx cannot use.

    Returns:
        The removed entries, for logging and assertions.
    """
    removed: list[str] = []
    for name in _NO_PROXY_ENV_VARS:
        raw_value = os.environ.get(name)
        if not raw_value:
            continue

        entries = [entry.strip() for entry in raw_value.split(",")]
        unsupported = [entry for entry in entries if entry and _is_cidr_entry(entry)]
        if not unsupported:
            continue

        removed.extend(unsupported)
        os.environ[name] = ",".join(
            entry for entry in entries if entry not in unsupported
        )
        logger.warning(
            "Dropped %s entries unsupported by httpx: %s", name, ",".join(unsupported)
        )

    return removed


def _inject_trace_headers(headers: dict) -> dict:
    """Inject W3C trace context and X-Request-ID into headers dict.

    Request ID propagation works independently of optional OTel instrumentation.
    """
    try:
        from shared.telemetry.context.span import get_request_id

        request_id = get_request_id()
        if request_id:
            headers["X-Request-ID"] = request_id
        from shared.telemetry.context import inject_trace_context_to_headers

        headers = inject_trace_context_to_headers(headers)
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
    sanitize_no_proxy_env()

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
    sanitize_no_proxy_env()

    event_hooks = kwargs.pop("event_hooks", {})
    existing_request_hooks = event_hooks.get("request", [])
    event_hooks["request"] = [_httpx_request_hook] + list(existing_request_hooks)

    if timeout is not None:
        kwargs["timeout"] = timeout

    return httpx.Client(event_hooks=event_hooks, **kwargs)
