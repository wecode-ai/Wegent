# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Hard byte admission for upstream Server-Sent Events."""

from __future__ import annotations

from typing import AsyncIterator

import httpx

UPSTREAM_SSE_EVENT_MAX_BYTES = 1024 * 1024


class SSEEventTooLargeError(RuntimeError):
    """Raised before an unterminated upstream event can grow without bound."""


class BoundedSSEByteStream(httpx.AsyncByteStream):
    """Count SSE event bytes while preserving the original byte stream."""

    def __init__(
        self,
        wrapped: httpx.AsyncByteStream,
        *,
        max_event_bytes: int = UPSTREAM_SSE_EVENT_MAX_BYTES,
    ) -> None:
        if max_event_bytes <= 0:
            raise ValueError("max_event_bytes must be positive")
        self._wrapped = wrapped
        self._max_event_bytes = max_event_bytes
        self._event_bytes = 0
        self._line_has_data = False
        self._previous_was_cr = False

    async def __aiter__(self) -> AsyncIterator[bytes]:
        async for chunk in self._wrapped:
            self._admit_chunk(chunk)
            yield chunk

    def _admit_chunk(self, chunk: bytes) -> None:
        for value in chunk:
            if value == 13:  # CR
                self._end_line()
                self._previous_was_cr = True
                continue
            if value == 10:  # LF
                if self._previous_was_cr:
                    self._previous_was_cr = False
                    continue
                self._end_line()
                continue

            self._previous_was_cr = False
            self._line_has_data = True
            self._event_bytes += 1
            if self._event_bytes > self._max_event_bytes:
                raise SSEEventTooLargeError(
                    "Upstream SSE event exceeds "
                    f"{self._max_event_bytes} bytes before its delimiter"
                )

    def _end_line(self) -> None:
        if self._line_has_data:
            self._line_has_data = False
            return
        self._event_bytes = 0

    async def aclose(self) -> None:
        await self._wrapped.aclose()


class BoundedSSETransport(httpx.AsyncBaseTransport):
    """Wrap only event-stream responses from a normal HTTP transport."""

    def __init__(
        self,
        wrapped: httpx.AsyncBaseTransport | None = None,
        *,
        max_event_bytes: int = UPSTREAM_SSE_EVENT_MAX_BYTES,
    ) -> None:
        self._wrapped = wrapped or httpx.AsyncHTTPTransport(retries=0)
        self._max_event_bytes = max_event_bytes

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        response = await self._wrapped.handle_async_request(request)
        content_type = response.headers.get("content-type", "").lower()
        if content_type.split(";", 1)[0].strip() == "text/event-stream":
            if not isinstance(response.stream, httpx.AsyncByteStream):
                await response.aclose()
                raise TypeError("SSE response did not provide an async byte stream")
            response.stream = BoundedSSEByteStream(
                response.stream,
                max_event_bytes=self._max_event_bytes,
            )
        return response

    async def aclose(self) -> None:
        await self._wrapped.aclose()


def create_bounded_sse_http_client(timeout_seconds: float) -> httpx.AsyncClient:
    """Create the OpenAI SDK client transport with hard event admission."""
    return httpx.AsyncClient(
        transport=BoundedSSETransport(),
        timeout=httpx.Timeout(timeout_seconds),
        trust_env=False,
    )
