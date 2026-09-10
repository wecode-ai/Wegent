# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Per-request correlation and transport timings for internal HTTP clients."""

import logging
import time
from collections.abc import Awaitable, Callable
from typing import Any

import httpx

logger = logging.getLogger(__name__)


async def trace_internal_request(request: httpx.Request) -> None:
    """Measure a request after the traced client has injected correlation headers."""
    started = time.perf_counter()
    request.extensions["internal_request_started"] = started
    logger.info(
        "[InternalHTTP] request method=%s path=%s request_id=%s",
        request.method,
        request.url.path,
        request.headers.get("X-Request-ID", "-"),
    )

    phases: dict[str, float] = {}

    async def transport_trace(event: str, info: dict[str, Any]) -> None:
        phase, _, state = event.rpartition(".")
        if not phase.endswith(("connect_tcp", "start_tls", "receive_response_headers")):
            return
        now = time.perf_counter()
        if state == "started":
            phases[phase] = now
        elif state in {"complete", "failed"}:
            logger.info(
                "[InternalHTTP] phase=%s state=%s method=%s path=%s "
                "request_id=%s duration_ms=%.2f total_ms=%.2f error_type=%s",
                phase,
                state,
                request.method,
                request.url.path,
                request.headers.get("X-Request-ID", "-"),
                (now - phases.get(phase, started)) * 1000,
                (now - started) * 1000,
                type(info["exception"]).__name__ if info.get("exception") else "-",
            )

    request.extensions.setdefault("trace", transport_trace)


async def trace_internal_response(response: httpx.Response) -> None:
    """Log receipt of headers without buffering streaming response bodies."""
    request = response.request
    started = request.extensions.get("internal_request_started")
    if started is None:
        return
    logger.info(
        "[InternalHTTP] response method=%s path=%s status=%s request_id=%s "
        "headers_ms=%.2f",
        request.method,
        request.url.path,
        response.status_code,
        request.headers.get("X-Request-ID", "-"),
        (time.perf_counter() - started) * 1000,
    )


def internal_http_event_hooks() -> dict[str, list[Callable[..., Awaitable[None]]]]:
    """Return fresh hooks for each client, with all state scoped to each request."""
    return {"request": [trace_internal_request], "response": [trace_internal_response]}
