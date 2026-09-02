# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the thin Web-side OpenAPI worker transport."""

from __future__ import annotations

import asyncio
import os
import tempfile
import threading
from pathlib import Path
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest

from app.services.execution import stream_client as stream_client_module
from app.services.execution.stream_client import (
    StreamExecutionClient,
    StreamRelayByteAdmission,
    StreamWorkerExecutionError,
    read_frame,
    web_stream_relay_byte_admission,
    web_stream_rpc_admission,
    write_frame,
    write_raw_frame,
)
from app.services.openapi.worker_client import OpenAPIWorkerClient
from app.services.openapi.worker_protocol import (
    OPENAPI_STREAM_FRAME_COMPLETE,
    OPENAPI_STREAM_FRAME_SSE,
    OpenAPIExecutionOutcome,
    OpenAPIStreamSpec,
)
from app.stream_worker import LocalStreamServer
from shared.models import ExecutionRequest


def _short_socket_path() -> Path:
    return Path(tempfile.gettempdir()) / (
        f"wegent-openapi-{os.getpid()}-{uuid4().hex[:8]}.sock"
    )


async def _start_server(socket_path: Path, handler):
    server = await asyncio.start_unix_server(handler, path=socket_path)
    return server


async def _wait_for_socket(socket_path: Path) -> None:
    for _ in range(100):
        if socket_path.exists():
            return
        await asyncio.sleep(0.01)
    raise TimeoutError(f"Socket was not created: {socket_path}")


def _request() -> ExecutionRequest:
    return ExecutionRequest(task_id=10, subtask_id=11)


def _spec() -> OpenAPIStreamSpec:
    return OpenAPIStreamSpec(
        response_id="resp_10",
        model_string="default#team",
        created_at=1,
    )


@pytest.mark.asyncio
async def test_stream_relays_worker_sse_bytes_without_reprojection() -> None:
    socket_path = _short_socket_path()
    received = []
    payloads = [
        b'data: {"type":"response.created"}\n\n',
        b'data: {"type":"response.completed"}\n\n',
    ]

    async def handler(reader, writer) -> None:
        received.append(await read_frame(reader))
        for payload in payloads:
            await write_raw_frame(
                writer,
                OPENAPI_STREAM_FRAME_SSE + payload,
                max_bytes=1024,
            )
        await write_raw_frame(
            writer,
            OPENAPI_STREAM_FRAME_COMPLETE,
            max_bytes=1024,
        )
        writer.close()
        await writer.wait_closed()

    server = await _start_server(socket_path, handler)
    try:
        result = [
            payload
            async for payload in OpenAPIWorkerClient(socket_path).stream(
                _request(),
                _spec(),
            )
        ]
    finally:
        server.close()
        await server.wait_closed()
        socket_path.unlink(missing_ok=True)

    assert result == payloads
    assert received[0]["type"] == "openapi_stream"
    assert received[0]["request"]["task_id"] == 10


@pytest.mark.asyncio
async def test_stream_close_propagates_disconnect_to_worker() -> None:
    socket_path = _short_socket_path()
    disconnected = asyncio.Event()

    async def handler(reader, writer) -> None:
        await read_frame(reader)
        await write_raw_frame(
            writer,
            OPENAPI_STREAM_FRAME_SSE + b"data: first\n\n",
            max_bytes=1024,
        )
        if await reader.read(1) == b"":
            disconnected.set()
        writer.close()
        await writer.wait_closed()

    server = await _start_server(socket_path, handler)
    stream = OpenAPIWorkerClient(socket_path).stream(_request(), _spec())
    try:
        assert await anext(stream) == b"data: first\n\n"
        await stream.aclose()
        await asyncio.wait_for(disconnected.wait(), timeout=1)
    finally:
        await stream.aclose()
        server.close()
        await server.wait_closed()
        socket_path.unlink(missing_ok=True)


@pytest.mark.asyncio
async def test_stream_envelope_projection_runs_off_event_loop() -> None:
    socket_path = _short_socket_path()
    projection_threads: list[int] = []

    class RecordingRequest:
        def to_dict(self):
            projection_threads.append(threading.get_ident())
            return _request().to_dict()

    class RecordingSpec:
        def to_dict(self):
            projection_threads.append(threading.get_ident())
            return _spec().to_dict()

    async def handler(reader, writer) -> None:
        await read_frame(reader)
        await write_raw_frame(
            writer,
            OPENAPI_STREAM_FRAME_COMPLETE,
            max_bytes=1024,
        )
        writer.close()
        await writer.wait_closed()

    server = await _start_server(socket_path, handler)
    event_loop_thread = threading.get_ident()
    try:
        result = [
            payload
            async for payload in OpenAPIWorkerClient(socket_path).stream(
                RecordingRequest(),  # type: ignore[arg-type]
                RecordingSpec(),  # type: ignore[arg-type]
            )
        ]
    finally:
        server.close()
        await server.wait_closed()
        socket_path.unlink(missing_ok=True)

    assert result == []
    assert len(projection_threads) == 2
    assert all(thread_id != event_loop_thread for thread_id in projection_threads)


@pytest.mark.asyncio
async def test_openapi_and_execution_streams_share_one_web_admission() -> None:
    assert (
        StreamExecutionClient()._stream_admission
        is OpenAPIWorkerClient()._admission
        is web_stream_rpc_admission
    )
    assert (
        StreamExecutionClient()._relay_byte_admission
        is OpenAPIWorkerClient()._relay_byte_admission
        is web_stream_relay_byte_admission
    )

    admission = stream_client_module._RPCAdmission(
        1,
        message="Web stream connection capacity exhausted",
        error_code="web_stream_overloaded",
    )
    execution_client = StreamExecutionClient(
        _short_socket_path(),
        stream_admission=admission,
    )
    openapi_client = OpenAPIWorkerClient(
        _short_socket_path(),
        admission=admission,
    )
    admission.acquire()
    try:
        with pytest.raises(StreamWorkerExecutionError) as execution_error:
            await execution_client.dispatch(_request(), AsyncMock())
        with pytest.raises(StreamWorkerExecutionError) as openapi_error:
            await anext(openapi_client.stream(_request(), _spec()))
    finally:
        admission.release()

    assert execution_error.value.error_code == "web_stream_overloaded"
    assert openapi_error.value.error_code == "web_stream_overloaded"


@pytest.mark.asyncio
async def test_stream_byte_lease_spans_yield_and_disconnect_releases_it() -> None:
    socket_path = _short_socket_path()
    payload = b"data: retained\n\n"
    raw_frame = OPENAPI_STREAM_FRAME_SSE + payload
    frames_sent = 0
    both_frames_sent = asyncio.Event()
    disconnects = 0
    both_disconnected = asyncio.Event()

    async def handler(reader, writer) -> None:
        nonlocal frames_sent, disconnects
        await read_frame(reader)
        await write_raw_frame(
            writer,
            raw_frame,
            max_bytes=len(raw_frame),
        )
        frames_sent += 1
        if frames_sent == 2:
            both_frames_sent.set()
        await reader.read(1)
        disconnects += 1
        if disconnects == 2:
            both_disconnected.set()
        writer.close()
        await writer.wait_closed()

    server = await _start_server(socket_path, handler)
    byte_admission = StreamRelayByteAdmission(max_bytes=len(raw_frame))
    client = OpenAPIWorkerClient(
        socket_path,
        max_frame_bytes=len(raw_frame),
        max_total_bytes=len(raw_frame),
        relay_byte_admission=byte_admission,
    )
    first = client.stream(_request(), _spec())
    second = client.stream(_request(), _spec())
    second_next: asyncio.Task[bytes] | None = None
    try:
        assert await anext(first) == payload
        second_next = asyncio.create_task(anext(second))
        await asyncio.wait_for(both_frames_sent.wait(), timeout=1)
        done, _ = await asyncio.wait({second_next}, timeout=0.05)
        assert not done

        await first.aclose()
        assert await asyncio.wait_for(second_next, timeout=1) == payload
        await second.aclose()
        await asyncio.wait_for(both_disconnected.wait(), timeout=1)
    finally:
        if second_next is not None and not second_next.done():
            second_next.cancel()
            await asyncio.gather(second_next, return_exceptions=True)
        await first.aclose()
        await second.aclose()
        server.close()
        await server.wait_closed()
        socket_path.unlink(missing_ok=True)


@pytest.mark.asyncio
async def test_stream_rejects_aggregate_bytes_above_bound() -> None:
    socket_path = _short_socket_path()

    async def handler(reader, writer) -> None:
        try:
            await read_frame(reader)
            for payload in (b"12345", b"67890"):
                await write_raw_frame(
                    writer,
                    OPENAPI_STREAM_FRAME_SSE + payload,
                    max_bytes=16,
                )
            await reader.read(1)
        finally:
            writer.close()
            await writer.wait_closed()

    server = await _start_server(socket_path, handler)
    client = OpenAPIWorkerClient(
        socket_path,
        max_frame_bytes=8,
        max_total_bytes=8,
    )
    try:
        with pytest.raises(StreamWorkerExecutionError) as raised:
            async for _ in client.stream(_request(), _spec()):
                pass
    finally:
        server.close()
        await server.wait_closed()
        socket_path.unlink(missing_ok=True)

    assert raised.value.error_code == "openapi_stream_total_too_large"


@pytest.mark.asyncio
async def test_stream_accepts_structured_overload_control_frame() -> None:
    socket_path = _short_socket_path()

    async def handler(reader, writer) -> None:
        await read_frame(reader)
        await write_frame(
            writer,
            {
                "type": "error",
                "message": "Local stream worker is at capacity",
                "error_code": "stream_worker_overloaded",
            },
        )
        writer.close()
        await writer.wait_closed()

    server = await _start_server(socket_path, handler)
    try:
        with pytest.raises(StreamWorkerExecutionError) as raised:
            async for _ in OpenAPIWorkerClient(socket_path).stream(
                _request(),
                _spec(),
            ):
                pass
    finally:
        server.close()
        await server.wait_closed()
        socket_path.unlink(missing_ok=True)

    assert raised.value.error_code == "stream_worker_overloaded"


@pytest.mark.asyncio
async def test_real_local_stream_server_cancels_openapi_projection_on_disconnect() -> (
    None
):
    socket_path = _short_socket_path()
    stop_event = asyncio.Event()
    projection_cancelled = asyncio.Event()

    class UnusedDispatcher:
        async def dispatch_sse_upstream(self, request, emitter) -> None:
            raise AssertionError((request, emitter))

    class Projector:
        def immediate_status(self, request, *, background):
            raise AssertionError((request, background))

        async def stream_sse(self, request, spec):
            assert request.task_id == 10
            assert spec.response_id == "resp_10"
            try:
                yield b"data: first\n\n"
                await asyncio.Future()
            finally:
                projection_cancelled.set()

        async def collect(self, request):
            raise AssertionError(request)

        async def run_background(self, request):
            raise AssertionError(request)

    server_task = asyncio.create_task(
        LocalStreamServer(
            socket_path,
            UnusedDispatcher(),
            openapi_projector=Projector(),
        ).run(stop_event)
    )
    await _wait_for_socket(socket_path)
    stream = OpenAPIWorkerClient(socket_path).stream(_request(), _spec())
    try:
        assert await anext(stream) == b"data: first\n\n"
        await stream.aclose()
        await asyncio.wait_for(projection_cancelled.wait(), timeout=1)
    finally:
        await stream.aclose()
        stop_event.set()
        await asyncio.wait_for(server_task, timeout=1)


@pytest.mark.asyncio
async def test_real_local_stream_server_runs_nonstream_request_in_worker() -> None:
    socket_path = _short_socket_path()
    stop_event = asyncio.Event()
    background_completed = asyncio.Event()

    class UnusedDispatcher:
        async def dispatch_sse_upstream(self, request, emitter) -> None:
            raise AssertionError((request, emitter))

    class Projector:
        def immediate_status(self, request, *, background):
            assert request.task_id == 10
            assert not background
            return "queued"

        async def stream_sse(self, request, spec):
            raise AssertionError((request, spec))
            yield b""

        async def collect(self, request):
            raise AssertionError(request)

        async def run_background(self, request):
            assert request.subtask_id == 11
            background_completed.set()

    server_task = asyncio.create_task(
        LocalStreamServer(
            socket_path,
            UnusedDispatcher(),
            openapi_projector=Projector(),
        ).run(stop_event)
    )
    await _wait_for_socket(socket_path)
    try:
        outcome = await OpenAPIWorkerClient(socket_path).execute(
            _request(),
            background=False,
        )
        await asyncio.wait_for(background_completed.wait(), timeout=1)
    finally:
        stop_event.set()
        await asyncio.wait_for(server_task, timeout=1)

    assert outcome == OpenAPIExecutionOutcome(status="queued")
