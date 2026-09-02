# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import asyncio
import os
import tempfile
from pathlib import Path
from uuid import uuid4

import orjson
import pytest

from app.services.execution.stream_client import (
    StreamRelayByteAdmission,
    StreamWorkerExecutionError,
    read_frame,
    write_raw_frame,
)
from app.services.execution.web_stream_client import WebStreamWorkerClient
from app.services.execution.web_stream_protocol import (
    MODEL_RUNTIME_EXECUTE,
    MODEL_RUNTIME_STREAM,
    REMOTE_WORKSPACE_FILE_STREAM,
    WEB_STREAM_FRAME_COMPLETE,
    WEB_STREAM_FRAME_DATA,
    WEB_STREAM_FRAME_HEARTBEAT,
    WEB_STREAM_FRAME_METADATA,
)
from app.stream_worker import LocalStreamServer


class _Admission:
    def __init__(self) -> None:
        self.in_flight = 0

    def acquire(self) -> None:
        self.in_flight += 1

    def release(self) -> None:
        self.in_flight -= 1


def _socket_path() -> Path:
    return Path(tempfile.gettempdir()) / (
        f"wegent-web-stream-{os.getpid()}-{uuid4().hex[:8]}.sock"
    )


async def _wait_for_socket(socket_path: Path) -> None:
    for _ in range(100):
        if socket_path.exists():
            return
        await asyncio.sleep(0.01)
    raise TimeoutError(f"Socket was not created: {socket_path}")


@pytest.mark.asyncio
async def test_client_relays_raw_bytes_and_sends_bounded_envelope() -> None:
    socket_path = _socket_path()
    received: list[dict] = []

    async def handler(reader, writer) -> None:
        received.append(await read_frame(reader))
        await write_raw_frame(
            writer,
            WEB_STREAM_FRAME_DATA + b"data: one\n\n",
            max_bytes=1024,
        )
        await write_raw_frame(
            writer,
            WEB_STREAM_FRAME_COMPLETE,
            max_bytes=1024,
        )
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_unix_server(handler, path=socket_path)
    admission = _Admission()
    try:
        result = [
            frame
            async for frame in WebStreamWorkerClient(
                socket_path,
                admission=admission,
                max_frame_bytes=1024,
                max_total_bytes=2048,
            ).stream(MODEL_RUNTIME_STREAM, {"model": "model"})
        ]
    finally:
        server.close()
        await server.wait_closed()
        socket_path.unlink(missing_ok=True)

    assert result == [b"data: one\n\n"]
    assert received == [
        {
            "type": "web_stream",
            "operation": MODEL_RUNTIME_STREAM,
            "payload": {"model": "model"},
        }
    ]
    assert admission.in_flight == 0


@pytest.mark.asyncio
async def test_client_holds_byte_lease_until_downstream_resumes() -> None:
    socket_path = _socket_path()
    payload = b"data: held\n\n"
    frame_size = len(payload) + 1
    disconnected = asyncio.Event()

    async def handler(reader, writer) -> None:
        await read_frame(reader)
        await write_raw_frame(
            writer,
            WEB_STREAM_FRAME_DATA + payload,
            max_bytes=1024,
        )
        if await reader.read(1) == b"":
            disconnected.set()
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_unix_server(handler, path=socket_path)
    byte_admission = StreamRelayByteAdmission(frame_size)
    stream = WebStreamWorkerClient(
        socket_path,
        byte_admission=byte_admission,
        max_frame_bytes=1024,
        max_total_bytes=2048,
    ).stream(MODEL_RUNTIME_STREAM, {"model": "model"})
    waiter: asyncio.Task | None = None
    try:
        assert await anext(stream) == payload
        waiter = asyncio.create_task(byte_admission.acquire(1))
        await asyncio.sleep(0)
        assert not waiter.done()

        await stream.aclose()
        lease = await asyncio.wait_for(waiter, timeout=1)
        await lease.release()
        await asyncio.wait_for(disconnected.wait(), timeout=1)
    finally:
        if waiter is not None and not waiter.done():
            waiter.cancel()
            await asyncio.gather(waiter, return_exceptions=True)
        await stream.aclose()
        server.close()
        await server.wait_closed()
        socket_path.unlink(missing_ok=True)


@pytest.mark.asyncio
async def test_stream_relays_worker_heartbeat_as_sse_comment() -> None:
    socket_path = _socket_path()

    async def handler(reader, writer) -> None:
        await read_frame(reader)
        await write_raw_frame(
            writer,
            WEB_STREAM_FRAME_HEARTBEAT,
            max_bytes=1024,
        )
        await write_raw_frame(
            writer,
            WEB_STREAM_FRAME_COMPLETE,
            max_bytes=1024,
        )
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_unix_server(handler, path=socket_path)
    try:
        result = [
            frame
            async for frame in WebStreamWorkerClient(
                socket_path,
                max_frame_bytes=1024,
                max_total_bytes=2048,
            ).stream(MODEL_RUNTIME_STREAM, {"model": "model"})
        ]
    finally:
        server.close()
        await server.wait_closed()
        socket_path.unlink(missing_ok=True)

    assert result == [b": keep-alive\n\n"]


@pytest.mark.asyncio
async def test_client_rejects_total_byte_overflow_and_releases_capacity() -> None:
    socket_path = _socket_path()
    admission = _Admission()

    async def handler(reader, writer) -> None:
        await read_frame(reader)
        await write_raw_frame(
            writer,
            WEB_STREAM_FRAME_DATA + b"12345678",
            max_bytes=64,
        )
        await write_raw_frame(
            writer,
            WEB_STREAM_FRAME_DATA + b"abcdefgh",
            max_bytes=64,
        )
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_unix_server(handler, path=socket_path)
    client = WebStreamWorkerClient(
        socket_path,
        admission=admission,
        max_frame_bytes=9,
        max_total_bytes=10,
    )
    try:
        with pytest.raises(StreamWorkerExecutionError, match="total byte limit"):
            _ = [
                frame
                async for frame in client.stream(
                    MODEL_RUNTIME_STREAM,
                    {"model": "model"},
                )
            ]
    finally:
        server.close()
        await server.wait_closed()
        socket_path.unlink(missing_ok=True)

    assert admission.in_flight == 0


@pytest.mark.asyncio
async def test_open_raw_stream_relays_metadata_and_bounded_body() -> None:
    socket_path = _socket_path()
    received: list[dict] = []
    admission = _Admission()

    async def handler(reader, writer) -> None:
        received.append(await read_frame(reader))
        await write_raw_frame(
            writer,
            WEB_STREAM_FRAME_HEARTBEAT,
            max_bytes=1024,
        )
        await write_raw_frame(
            writer,
            WEB_STREAM_FRAME_METADATA
            + orjson.dumps(
                {
                    "content_type": "text/plain",
                    "content_disposition": 'attachment; filename="hello.txt"',
                }
            ),
            max_bytes=1024,
        )
        await write_raw_frame(
            writer,
            WEB_STREAM_FRAME_DATA + b"hello",
            max_bytes=1024,
        )
        await write_raw_frame(
            writer,
            WEB_STREAM_FRAME_COMPLETE,
            max_bytes=1024,
        )
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_unix_server(handler, path=socket_path)
    try:
        response = await WebStreamWorkerClient(
            socket_path,
            admission=admission,
            max_frame_bytes=1024,
            max_total_bytes=2048,
        ).open_raw_stream(
            REMOTE_WORKSPACE_FILE_STREAM,
            {"task_id": 1, "user_id": 2, "path": "/workspace/hello.txt"},
        )
        content = b"".join([chunk async for chunk in response.body])
    finally:
        server.close()
        await server.wait_closed()
        socket_path.unlink(missing_ok=True)

    assert response.metadata["content_type"] == "text/plain"
    assert content == b"hello"
    assert received[0]["operation"] == REMOTE_WORKSPACE_FILE_STREAM
    assert admission.in_flight == 0


@pytest.mark.asyncio
async def test_execute_relays_one_bounded_worker_result_after_heartbeat() -> None:
    socket_path = _socket_path()
    received: list[dict] = []
    admission = _Admission()

    async def handler(reader, writer) -> None:
        received.append(await read_frame(reader))
        await write_raw_frame(
            writer,
            WEB_STREAM_FRAME_HEARTBEAT,
            max_bytes=1024,
        )
        await write_raw_frame(
            writer,
            WEB_STREAM_FRAME_DATA + orjson.dumps({"output_text": "ok"}),
            max_bytes=1024,
        )
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_unix_server(handler, path=socket_path)
    try:
        result = await WebStreamWorkerClient(
            socket_path,
            admission=admission,
            max_frame_bytes=1024,
            max_total_bytes=2048,
        ).execute(MODEL_RUNTIME_EXECUTE, {"model": "model"})
    finally:
        server.close()
        await server.wait_closed()
        socket_path.unlink(missing_ok=True)

    assert result == {"output_text": "ok"}
    assert received == [
        {
            "type": "web_execute",
            "operation": MODEL_RUNTIME_EXECUTE,
            "payload": {"model": "model"},
        }
    ]
    assert admission.in_flight == 0


@pytest.mark.asyncio
async def test_real_local_server_disconnect_cancels_worker_execute() -> None:
    socket_path = _socket_path()
    stop_event = asyncio.Event()
    started = asyncio.Event()
    cancelled = asyncio.Event()

    class Projector:
        async def execute(self, operation, payload):
            assert operation == MODEL_RUNTIME_EXECUTE
            assert payload == {"model": "model"}
            started.set()
            try:
                await asyncio.Future()
            finally:
                cancelled.set()

    server_task = asyncio.create_task(
        LocalStreamServer(
            socket_path,
            dispatcher=object(),  # type: ignore[arg-type]
            web_stream_projector=Projector(),  # type: ignore[arg-type]
        ).run(stop_event)
    )
    execute_task: asyncio.Task | None = None
    try:
        await _wait_for_socket(socket_path)
        execute_task = asyncio.create_task(
            WebStreamWorkerClient(socket_path).execute(
                MODEL_RUNTIME_EXECUTE,
                {"model": "model"},
            )
        )
        await asyncio.wait_for(started.wait(), timeout=1)
        execute_task.cancel()
        await asyncio.gather(execute_task, return_exceptions=True)
        await asyncio.wait_for(cancelled.wait(), timeout=1)
    finally:
        if execute_task is not None and not execute_task.done():
            execute_task.cancel()
            await asyncio.gather(execute_task, return_exceptions=True)
        stop_event.set()
        await asyncio.wait_for(server_task, timeout=2)
        socket_path.unlink(missing_ok=True)


@pytest.mark.asyncio
async def test_real_local_server_disconnect_cancels_worker_stream() -> None:
    socket_path = _socket_path()
    stop_event = asyncio.Event()
    started = asyncio.Event()
    cancelled = asyncio.Event()

    class Projector:
        async def stream(self, operation, payload):
            assert operation == MODEL_RUNTIME_STREAM
            assert payload == {"model": "model"}
            started.set()
            try:
                yield b"data: first\n\n"
                await asyncio.Future()
            finally:
                cancelled.set()

    server = LocalStreamServer(
        socket_path,
        dispatcher=object(),  # type: ignore[arg-type]
        web_stream_projector=Projector(),
    )
    server_task = asyncio.create_task(server.run(stop_event))
    stream = WebStreamWorkerClient(socket_path).stream(
        MODEL_RUNTIME_STREAM,
        {"model": "model"},
    )
    try:
        await _wait_for_socket(socket_path)
        assert await anext(stream) == b"data: first\n\n"
        await asyncio.wait_for(started.wait(), timeout=1)
        await stream.aclose()
        await asyncio.wait_for(cancelled.wait(), timeout=1)
    finally:
        await stream.aclose()
        stop_event.set()
        await asyncio.wait_for(server_task, timeout=2)
        socket_path.unlink(missing_ok=True)


@pytest.mark.asyncio
async def test_real_local_server_disconnect_cancels_worker_raw_stream() -> None:
    socket_path = _socket_path()
    stop_event = asyncio.Event()
    started = asyncio.Event()
    cancelled = asyncio.Event()

    class Projector:
        async def open_raw_stream(self, operation, payload):
            assert operation == REMOTE_WORKSPACE_FILE_STREAM
            assert payload == {"task_id": 1, "path": "/workspace/file.txt"}

            async def body():
                started.set()
                try:
                    yield b"first"
                    await asyncio.Future()
                finally:
                    cancelled.set()

            return {"content_type": "text/plain"}, body()

    server = LocalStreamServer(
        socket_path,
        dispatcher=object(),  # type: ignore[arg-type]
        web_stream_projector=Projector(),
    )
    server_task = asyncio.create_task(server.run(stop_event))
    response = None
    try:
        await _wait_for_socket(socket_path)
        response = await WebStreamWorkerClient(socket_path).open_raw_stream(
            REMOTE_WORKSPACE_FILE_STREAM,
            {"task_id": 1, "path": "/workspace/file.txt"},
        )
        assert await anext(response.body) == b"first"
        await asyncio.wait_for(started.wait(), timeout=1)
        await response.body.aclose()
        await asyncio.wait_for(cancelled.wait(), timeout=1)
    finally:
        if response is not None:
            await response.body.aclose()
        stop_event.set()
        await asyncio.wait_for(server_task, timeout=2)
        socket_path.unlink(missing_ok=True)
