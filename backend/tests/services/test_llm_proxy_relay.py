# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Behavioral proof for the bounded Web-side raw LLM relay."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
from starlette.requests import ClientDisconnect

from app.services.execution.stream_client import (
    web_stream_relay_byte_admission,
    web_stream_rpc_admission,
)
from app.services.llm_proxy_service import (
    BoundedRawProxyRelay,
    BoundedRawProxyResponse,
    LLMProxyRelayError,
    LLMProxyRelayLimits,
    LLMProxyRelayTimeout,
)


class _Admission:
    def __init__(self) -> None:
        self.in_flight = 0

    def acquire(self) -> None:
        self.in_flight += 1

    def release(self) -> None:
        assert self.in_flight > 0
        self.in_flight -= 1


class _Lease:
    def __init__(self, admission: "_ByteAdmission", size: int) -> None:
        self._admission = admission
        self._size = size
        self._released = False

    async def release(self) -> None:
        if self._released:
            return
        self._released = True
        self._admission.held_bytes -= self._size


class _ByteAdmission:
    def __init__(self) -> None:
        self.held_bytes = 0
        self.acquired_sizes: list[int] = []

    async def acquire(self, size: int) -> _Lease:
        self.acquired_sizes.append(size)
        self.held_bytes += size
        return _Lease(self, size)


class _Response:
    status_code = 200
    headers = {"content-type": "text/event-stream"}

    def __init__(
        self,
        chunks: list[bytes],
        *,
        byte_admission: _ByteAdmission | None = None,
        stall_after_chunks: bool = False,
    ) -> None:
        self._chunks = chunks
        self._byte_admission = byte_admission
        self._stall_after_chunks = stall_after_chunks
        self.chunk_size: int | None = None
        self.closed = False

    def aiter_raw(self, *, chunk_size: int | None = None) -> AsyncIterator[bytes]:
        self.chunk_size = chunk_size

        async def iterate() -> AsyncIterator[bytes]:
            for chunk in self._chunks:
                if self._byte_admission is not None:
                    assert self._byte_admission.held_bytes == chunk_size
                yield chunk
            if self._stall_after_chunks:
                await asyncio.Event().wait()

        return iterate()

    async def aclose(self) -> None:
        self.closed = True


class _Client:
    def __init__(
        self,
        response: _Response,
        *,
        stall_before_headers: bool = False,
    ) -> None:
        self._response = response
        self._stall_before_headers = stall_before_headers
        self.closed = False
        self.send_calls = 0

    async def send(
        self,
        request: httpx.Request,
        *,
        stream: bool,
    ) -> _Response:
        del request
        assert stream is True
        self.send_calls += 1
        if self._stall_before_headers:
            await asyncio.Event().wait()
        return self._response

    async def aclose(self) -> None:
        self.closed = True


def _limits(
    *,
    max_chunk_bytes: int = 4,
    max_response_bytes: int = 16,
    first_byte_timeout_seconds: float = 1.0,
    idle_timeout_seconds: float = 1.0,
    max_duration_seconds: float = 2.0,
) -> LLMProxyRelayLimits:
    return LLMProxyRelayLimits(
        max_chunk_bytes=max_chunk_bytes,
        max_response_bytes=max_response_bytes,
        first_byte_timeout_seconds=first_byte_timeout_seconds,
        idle_timeout_seconds=idle_timeout_seconds,
        max_duration_seconds=max_duration_seconds,
    )


async def _open_relay(
    response: _Response,
    *,
    admission: _Admission,
    byte_admission: _ByteAdmission,
    limits: LLMProxyRelayLimits | None = None,
    stall_before_headers: bool = False,
) -> tuple[BoundedRawProxyRelay, _Client]:
    client = _Client(response, stall_before_headers=stall_before_headers)

    def client_factory(**kwargs: Any) -> _Client:
        assert isinstance(kwargs["timeout"], httpx.Timeout)
        return client

    relay = await BoundedRawProxyRelay.open(
        httpx.Request("POST", "https://provider.example/v1/responses"),
        admission=admission,
        byte_admission=byte_admission,  # type: ignore[arg-type]
        limits=limits or _limits(),
        client_factory=client_factory,  # type: ignore[arg-type]
    )
    return relay, client


@pytest.mark.asyncio
async def test_relay_reads_fixed_chunks_only_after_byte_admission_and_holds_lease() -> (
    None
):
    admission = _Admission()
    byte_admission = _ByteAdmission()
    response = _Response(
        [b"abcd", b"ef"],
        byte_admission=byte_admission,
    )
    relay, client = await _open_relay(
        response,
        admission=admission,
        byte_admission=byte_admission,
    )
    stream = relay.stream()

    assert admission.in_flight == 1
    assert await anext(stream) == b"abcd"
    assert response.chunk_size == 4
    assert byte_admission.held_bytes == 4

    assert await anext(stream) == b"ef"
    assert byte_admission.held_bytes == 4
    with pytest.raises(StopAsyncIteration):
        await anext(stream)

    assert byte_admission.acquired_sizes == [4, 4, 4]
    assert byte_admission.held_bytes == 0
    assert admission.in_flight == 0
    assert response.closed is True
    assert client.closed is True


@pytest.mark.asyncio
async def test_downstream_disconnect_releases_lease_and_all_upstream_resources() -> (
    None
):
    admission = _Admission()
    byte_admission = _ByteAdmission()
    response = _Response(
        [b"data"],
        byte_admission=byte_admission,
        stall_after_chunks=True,
    )
    relay, client = await _open_relay(
        response,
        admission=admission,
        byte_admission=byte_admission,
    )
    stream = relay.stream()

    assert await anext(stream) == b"data"
    assert byte_admission.held_bytes == 4
    await stream.aclose()

    assert byte_admission.held_bytes == 0
    assert admission.in_flight == 0
    assert response.closed is True
    assert client.closed is True


@pytest.mark.asyncio
async def test_relay_rejects_oversized_provider_chunk_and_releases_capacity() -> None:
    admission = _Admission()
    byte_admission = _ByteAdmission()
    response = _Response([b"12345"], byte_admission=byte_admission)
    relay, client = await _open_relay(
        response,
        admission=admission,
        byte_admission=byte_admission,
    )

    with pytest.raises(LLMProxyRelayError) as exc_info:
        await anext(relay.stream())

    assert exc_info.value.error_code == "llm_proxy_chunk_too_large"
    assert byte_admission.held_bytes == 0
    assert admission.in_flight == 0
    assert response.closed is True
    assert client.closed is True


@pytest.mark.asyncio
async def test_relay_rejects_cumulative_response_overflow_and_releases_capacity() -> (
    None
):
    admission = _Admission()
    byte_admission = _ByteAdmission()
    response = _Response([b"1234", b"5678"], byte_admission=byte_admission)
    relay, client = await _open_relay(
        response,
        admission=admission,
        byte_admission=byte_admission,
        limits=_limits(max_response_bytes=6),
    )
    stream = relay.stream()

    assert await anext(stream) == b"1234"
    with pytest.raises(LLMProxyRelayError) as exc_info:
        await anext(stream)

    assert exc_info.value.error_code == "llm_proxy_response_too_large"
    assert byte_admission.held_bytes == 0
    assert admission.in_flight == 0
    assert response.closed is True
    assert client.closed is True


@pytest.mark.asyncio
async def test_header_timeout_closes_client_and_releases_global_admission() -> None:
    admission = _Admission()
    byte_admission = _ByteAdmission()
    response = _Response([])
    client = _Client(response, stall_before_headers=True)

    with pytest.raises(LLMProxyRelayTimeout) as exc_info:
        await BoundedRawProxyRelay.open(
            httpx.Request("POST", "https://provider.example/v1/responses"),
            admission=admission,
            byte_admission=byte_admission,  # type: ignore[arg-type]
            limits=_limits(first_byte_timeout_seconds=0.02),
            client_factory=lambda **_: client,  # type: ignore[arg-type]
        )

    assert exc_info.value.error_code == "llm_proxy_first_byte_timeout"
    assert admission.in_flight == 0
    assert client.closed is True


@pytest.mark.asyncio
async def test_first_byte_and_idle_timeouts_are_independent_hard_bounds() -> None:
    for initial_chunks, expected_code in (
        ([], "llm_proxy_first_byte_timeout"),
        ([b"data"], "llm_proxy_idle_timeout"),
    ):
        admission = _Admission()
        byte_admission = _ByteAdmission()
        response = _Response(
            initial_chunks,
            byte_admission=byte_admission,
            stall_after_chunks=True,
        )
        relay, client = await _open_relay(
            response,
            admission=admission,
            byte_admission=byte_admission,
            limits=_limits(
                first_byte_timeout_seconds=0.02,
                idle_timeout_seconds=0.02,
            ),
        )
        stream = relay.stream()
        if initial_chunks:
            assert await anext(stream) == b"data"

        with pytest.raises(LLMProxyRelayTimeout) as exc_info:
            await anext(stream)

        assert exc_info.value.error_code == expected_code
        assert byte_admission.held_bytes == 0
        assert admission.in_flight == 0
        assert response.closed is True
        assert client.closed is True


@pytest.mark.asyncio
async def test_absolute_duration_includes_downstream_backpressure_time() -> None:
    admission = _Admission()
    byte_admission = _ByteAdmission()
    response = _Response([b"data"], byte_admission=byte_admission)
    relay, client = await _open_relay(
        response,
        admission=admission,
        byte_admission=byte_admission,
        limits=_limits(
            first_byte_timeout_seconds=1.0,
            idle_timeout_seconds=1.0,
            max_duration_seconds=0.02,
        ),
    )
    stream = relay.stream()

    assert await anext(stream) == b"data"
    await asyncio.sleep(0.03)
    with pytest.raises(LLMProxyRelayTimeout) as exc_info:
        await anext(stream)

    assert exc_info.value.error_code == "llm_proxy_duration_exceeded"
    assert byte_admission.held_bytes == 0
    assert admission.in_flight == 0
    assert response.closed is True
    assert client.closed is True


@pytest.mark.asyncio
async def test_asgi_deadline_cancels_stalled_downstream_send_and_releases_all() -> None:
    admission = _Admission()
    byte_admission = _ByteAdmission()
    response = _Response([b"data"], byte_admission=byte_admission)
    relay, client = await _open_relay(
        response,
        admission=admission,
        byte_admission=byte_admission,
        limits=_limits(max_duration_seconds=0.03),
    )
    asgi_response = BoundedRawProxyResponse(
        relay,
        media_type="text/event-stream",
    )
    body_started = asyncio.Event()

    async def send(message: dict[str, Any]) -> None:
        if message["type"] == "http.response.body" and message.get("body"):
            body_started.set()
            await asyncio.Event().wait()

    async def receive() -> dict[str, Any]:
        await asyncio.Event().wait()
        raise AssertionError("unreachable")

    scope = {
        "type": "http",
        "method": "POST",
        "path": "/runtime/llm-responses-proxy/responses",
        "headers": [],
        "asgi": {"spec_version": "2.4"},
    }
    with pytest.raises(LLMProxyRelayTimeout) as exc_info:
        await asgi_response(scope, receive, send)  # type: ignore[arg-type]

    assert body_started.is_set()
    assert exc_info.value.error_code == "llm_proxy_duration_exceeded"
    assert byte_admission.held_bytes == 0
    assert admission.in_flight == 0
    assert response.closed is True
    assert client.closed is True


@pytest.mark.asyncio
async def test_asgi_client_disconnect_releases_held_chunk_and_upstream() -> None:
    admission = _Admission()
    byte_admission = _ByteAdmission()
    response = _Response([b"data"], byte_admission=byte_admission)
    relay, client = await _open_relay(
        response,
        admission=admission,
        byte_admission=byte_admission,
    )
    asgi_response = BoundedRawProxyResponse(
        relay,
        media_type="text/event-stream",
    )

    async def send(message: dict[str, Any]) -> None:
        if message["type"] == "http.response.body" and message.get("body"):
            raise OSError("client disconnected")

    async def receive() -> dict[str, Any]:
        await asyncio.Event().wait()
        raise AssertionError("unreachable")

    scope = {
        "type": "http",
        "method": "POST",
        "path": "/runtime/llm-responses-proxy/responses",
        "headers": [],
        "asgi": {"spec_version": "2.4"},
    }
    with pytest.raises(ClientDisconnect):
        await asgi_response(scope, receive, send)  # type: ignore[arg-type]

    assert byte_admission.held_bytes == 0
    assert admission.in_flight == 0
    assert response.closed is True
    assert client.closed is True


@pytest.mark.asyncio
async def test_default_relay_uses_the_shared_web_stream_admissions() -> None:
    response = _Response([])
    client = _Client(response)
    relay = await BoundedRawProxyRelay.open(
        httpx.Request("POST", "https://provider.example/v1/responses"),
        client_factory=lambda **_: client,  # type: ignore[arg-type]
    )
    try:
        assert relay._admission is web_stream_rpc_admission
        assert relay._byte_admission is web_stream_relay_byte_admission
    finally:
        await relay.aclose()

    assert response.closed is True
    assert client.closed is True
