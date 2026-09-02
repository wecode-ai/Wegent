# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import httpx
import pytest

from app.services.execution.sse_transport import (
    BoundedSSEByteStream,
    BoundedSSETransport,
    SSEEventTooLargeError,
)


class _Chunks(httpx.AsyncByteStream):
    def __init__(self, chunks: list[bytes]) -> None:
        self._chunks = chunks
        self.closed = False

    async def __aiter__(self):
        for chunk in self._chunks:
            yield chunk

    async def aclose(self) -> None:
        self.closed = True


@pytest.mark.asyncio
async def test_sse_event_limit_survives_cross_chunk_delimiters() -> None:
    source = _Chunks([b"data: one\r", b"\n\r", b"\ndata: two\n\n"])
    stream = BoundedSSEByteStream(source, max_event_bytes=16)

    chunks = [chunk async for chunk in stream]
    await stream.aclose()

    assert chunks == source._chunks
    assert source.closed is True


@pytest.mark.asyncio
async def test_sse_event_limit_rejects_before_unterminated_event_grows() -> None:
    source = _Chunks([b"data: 1234", b"56789"])
    stream = BoundedSSEByteStream(source, max_event_bytes=12)

    with pytest.raises(SSEEventTooLargeError, match="12 bytes"):
        _ = [chunk async for chunk in stream]


class _ResponseTransport(httpx.AsyncBaseTransport):
    def __init__(self, content_type: str) -> None:
        self.content_type = content_type
        self.closed = False

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": self.content_type},
            stream=_Chunks([b"data: ok\n\n"]),
            request=request,
        )

    async def aclose(self) -> None:
        self.closed = True


@pytest.mark.asyncio
async def test_transport_wraps_only_sse_responses() -> None:
    source = _ResponseTransport("text/event-stream; charset=utf-8")
    transport = BoundedSSETransport(source, max_event_bytes=32)
    request = httpx.Request("GET", "https://chat-shell.test/v1/responses")

    response = await transport.handle_async_request(request)
    await transport.aclose()

    assert isinstance(response.stream, BoundedSSEByteStream)
    assert source.closed is True
