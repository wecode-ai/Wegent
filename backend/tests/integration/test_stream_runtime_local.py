# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Real-process integration tests for Pod-local stream execution."""

from __future__ import annotations

import asyncio
import multiprocessing
import os
import signal
import socket
import tempfile
import time
from collections.abc import Iterator
from contextlib import contextmanager
from multiprocessing.connection import Connection
from pathlib import Path
from typing import Callable
from uuid import uuid4

import httpx
import pytest
import uvicorn
from fastapi import FastAPI
from fastapi.responses import StreamingResponse

from app.services.execution.emitters.sse import SSEResultEmitter
from app.services.execution.stream_client import StreamExecutionClient
from app.stream_worker import LocalStreamServer
from shared.models import ExecutionEvent, ExecutionRequest


class _SyntheticDispatcher:
    async def dispatch_sse_upstream(self, request, emitter) -> None:
        for index in range(30):
            await emitter.emit(
                ExecutionEvent(
                    type="chunk",
                    task_id=request.task_id,
                    subtask_id=request.subtask_id,
                    content="x",
                    offset=index,
                )
            )
            await asyncio.sleep(1 / 30)
        await emitter.emit(
            ExecutionEvent(
                type="done",
                task_id=request.task_id,
                subtask_id=request.subtask_id,
            )
        )

    async def dispatch_worker_owned(self, request, emitter) -> None:
        await self.dispatch_sse_upstream(request, emitter)


class _BlockingSideEffectDispatcher:
    """Represent a synchronous DB/Redis stall inside the isolated process."""

    async def dispatch_sse_upstream(self, request, emitter) -> None:
        await emitter.emit(
            ExecutionEvent(
                type="chunk",
                task_id=request.task_id,
                subtask_id=request.subtask_id,
                content="started",
                offset=0,
            )
        )
        time.sleep(1.0)
        await emitter.emit(
            ExecutionEvent(
                type="done",
                task_id=request.task_id,
                subtask_id=request.subtask_id,
            )
        )

    async def dispatch_worker_owned(self, request, emitter) -> None:
        await self.dispatch_sse_upstream(request, emitter)


class _RecordingPointProjector:
    def __init__(self, connection: Connection) -> None:
        self._connection = connection

    async def project_callback_body(self, body: bytes, *, batch: bool) -> dict:
        self._connection.send(("received", body, batch))
        await asyncio.sleep(0.2)
        self._connection.send(("completed", body, batch))
        return {"status": "ok", "message": None}

    async def project_device_event(self, **kwargs) -> dict:
        return {"success": True}

    async def project_execution_event(self, **kwargs) -> dict:
        return {"success": True}

    async def close(self) -> None:
        return None


async def _serve_synthetic_worker(socket_path: str) -> None:
    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    for handled_signal in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(handled_signal, stop_event.set)
    await LocalStreamServer(socket_path, _SyntheticDispatcher()).run(stop_event)


def _synthetic_worker_main(socket_path: str) -> None:
    asyncio.run(_serve_synthetic_worker(socket_path))


async def _serve_blocking_worker(socket_path: str) -> None:
    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    for handled_signal in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(handled_signal, stop_event.set)
    await LocalStreamServer(socket_path, _BlockingSideEffectDispatcher()).run(
        stop_event
    )


def _blocking_worker_main(socket_path: str) -> None:
    asyncio.run(_serve_blocking_worker(socket_path))


async def _serve_point_worker(socket_path: str, connection: Connection) -> None:
    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    for handled_signal in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(handled_signal, stop_event.set)
    await LocalStreamServer(
        socket_path,
        _SyntheticDispatcher(),
        point_projector=_RecordingPointProjector(connection),
    ).run(stop_event)


def _point_worker_main(socket_path: str, connection: Connection) -> None:
    asyncio.run(_serve_point_worker(socket_path, connection))


def _build_forwarding_app(socket_path: str) -> FastAPI:
    app = FastAPI()
    stream_client = StreamExecutionClient(socket_path)

    @app.get("/probe")
    async def probe() -> dict[str, str]:
        await asyncio.sleep(0)
        return {"status": "ok"}

    @app.get("/stream/{request_id}")
    async def stream(request_id: int) -> StreamingResponse:
        emitter = SSEResultEmitter(
            task_id=request_id,
            subtask_id=request_id,
            maxsize=8,
        )

        async def dispatch() -> None:
            try:
                await stream_client.dispatch(
                    ExecutionRequest(task_id=request_id, subtask_id=request_id),
                    emitter,
                )
            finally:
                await emitter.close()

        dispatch_task = asyncio.create_task(dispatch())

        async def body():
            try:
                async for event in emitter.stream_sse():
                    yield event
                await dispatch_task
            finally:
                if not dispatch_task.done():
                    dispatch_task.cancel()
                await asyncio.gather(dispatch_task, return_exceptions=True)
                await emitter.close()

        return StreamingResponse(body(), media_type="text/event-stream")

    return app


async def _serve_forwarding_web(
    socket_path: str,
    ready_connection: Connection,
) -> None:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", 0))
    listener.listen(256)
    port = listener.getsockname()[1]
    ready_connection.send(port)
    ready_connection.close()

    config = uvicorn.Config(
        _build_forwarding_app(socket_path),
        log_level="warning",
        lifespan="off",
        workers=1,
    )
    await uvicorn.Server(config).serve(sockets=[listener])


def _synthetic_web_main(
    socket_path: str,
    ready_connection: Connection,
) -> None:
    asyncio.run(_serve_forwarding_web(socket_path, ready_connection))


@contextmanager
def _spawn_stream_process(
    target: Callable[[str], None],
    label: str,
) -> Iterator[Path]:
    socket_path = Path(tempfile.gettempdir()) / (
        f"wegent-{label}-{os.getpid()}-{uuid4().hex[:8]}.sock"
    )
    process = multiprocessing.get_context("spawn").Process(
        target=target,
        args=(str(socket_path),),
    )
    process.start()
    deadline = time.monotonic() + 30
    while not socket_path.exists():
        if process.exitcode is not None:
            raise RuntimeError(
                f"local stream worker exited during startup: {process.exitcode}"
            )
        if time.monotonic() >= deadline:
            raise RuntimeError("local stream worker socket was not created")
        time.sleep(0.01)
    try:
        yield socket_path
    finally:
        if process.is_alive():
            os.kill(process.pid, signal.SIGTERM)
        process.join(timeout=10)
        if process.is_alive():
            process.kill()
            process.join(timeout=5)
        assert process.exitcode == 0


@contextmanager
def _spawn_point_process() -> Iterator[tuple[Path, Connection]]:
    socket_path = Path(tempfile.gettempdir()) / (
        f"wegent-point-{os.getpid()}-{uuid4().hex[:8]}.sock"
    )
    parent_connection, child_connection = multiprocessing.Pipe(duplex=False)
    process = multiprocessing.get_context("spawn").Process(
        target=_point_worker_main,
        args=(str(socket_path), child_connection),
    )
    process.start()
    child_connection.close()
    deadline = time.monotonic() + 30
    while not socket_path.exists():
        if process.exitcode is not None:
            raise RuntimeError(
                f"point worker exited during startup: {process.exitcode}"
            )
        if time.monotonic() >= deadline:
            raise RuntimeError("point worker socket was not created")
        time.sleep(0.01)
    try:
        yield socket_path, parent_connection
    finally:
        parent_connection.close()
        if process.is_alive():
            os.kill(process.pid, signal.SIGTERM)
        process.join(timeout=10)
        if process.is_alive():
            process.kill()
            process.join(timeout=5)
        assert process.exitcode == 0


@pytest.fixture
def local_stream_process() -> Iterator[Path]:
    with _spawn_stream_process(
        _synthetic_worker_main,
        "integration",
    ) as socket_path:
        yield socket_path


@pytest.fixture
def blocking_stream_process() -> Iterator[Path]:
    with _spawn_stream_process(
        _blocking_worker_main,
        "blocking-integration",
    ) as socket_path:
        yield socket_path


@contextmanager
def _spawn_forwarding_runtime(stream_socket_path: Path) -> Iterator[str]:
    context = multiprocessing.get_context("spawn")
    receive_connection, send_connection = context.Pipe(duplex=False)
    process = context.Process(
        target=_synthetic_web_main,
        args=(str(stream_socket_path), send_connection),
    )
    process.start()
    send_connection.close()
    if not receive_connection.poll(30):
        process.kill()
        process.join(timeout=5)
        raise RuntimeError("single-worker Uvicorn probe did not bind")
    port = receive_connection.recv()
    receive_connection.close()
    base_url = f"http://127.0.0.1:{port}"

    deadline = time.monotonic() + 30
    while True:
        if process.exitcode is not None:
            raise RuntimeError(
                f"single-worker Uvicorn exited during startup: {process.exitcode}"
            )
        try:
            if httpx.get(f"{base_url}/probe", timeout=0.5).status_code == 200:
                break
        except httpx.HTTPError:
            pass
        if time.monotonic() >= deadline:
            raise RuntimeError("single-worker Uvicorn did not become ready")
        time.sleep(0.01)

    try:
        yield base_url
    finally:
        if process.is_alive():
            os.kill(process.pid, signal.SIGTERM)
        process.join(timeout=10)
        if process.is_alive():
            process.kill()
            process.join(timeout=5)
        # Uvicorn restores and re-raises its captured SIGTERM after graceful
        # shutdown, so a signal exit is its expected process-level result.
        assert process.exitcode in (0, -signal.SIGTERM)


@pytest.fixture
def local_forwarding_runtime(local_stream_process: Path) -> Iterator[str]:
    with _spawn_forwarding_runtime(local_stream_process) as base_url:
        yield base_url


@pytest.fixture
def blocking_forwarding_runtime(blocking_stream_process: Path) -> Iterator[str]:
    with _spawn_forwarding_runtime(blocking_stream_process) as base_url:
        yield base_url


class _RecordingEmitter:
    def __init__(self) -> None:
        self.events: list[ExecutionEvent] = []

    async def emit(self, event: ExecutionEvent) -> None:
        self.events.append(event)

    async def close(self) -> None:
        return None


async def _receive_process_message(connection: Connection) -> tuple:
    deadline = time.monotonic() + 5
    while not connection.poll():
        if time.monotonic() >= deadline:
            raise TimeoutError("point worker did not report progress")
        await asyncio.sleep(0.005)
    return connection.recv()


@pytest.mark.asyncio
async def test_web_cancellation_does_not_cancel_accepted_point_event() -> None:
    body = b'{"event_type":"response.output_text.delta","task_id":1,"subtask_id":2}'
    with _spawn_point_process() as (socket_path, connection):
        dispatch = asyncio.create_task(
            StreamExecutionClient(socket_path).dispatch_callback_body(
                body,
                batch=False,
            )
        )
        assert await _receive_process_message(connection) == (
            "received",
            body,
            False,
        )

        dispatch.cancel()
        with pytest.raises(asyncio.CancelledError):
            await dispatch

        assert await _receive_process_message(connection) == (
            "completed",
            body,
            False,
        )


@pytest.mark.asyncio
async def test_separate_process_preserves_every_event(
    local_stream_process: Path,
) -> None:
    emitter = _RecordingEmitter()

    await StreamExecutionClient(local_stream_process).dispatch(
        ExecutionRequest(task_id=101, subtask_id=102),
        emitter,
    )

    chunks = [event for event in emitter.events if event.type == "chunk"]
    assert "".join(event.content for event in chunks) == "x" * 30
    assert len(chunks) == 30
    assert [event.offset for event in chunks] == list(range(30))
    assert emitter.events[-1].type == "done"


@pytest.mark.asyncio
async def test_hundred_local_streams_serve_probes_before_completion(
    local_forwarding_runtime: str,
) -> None:
    limits = httpx.Limits(max_connections=128, max_keepalive_connections=128)
    async with httpx.AsyncClient(
        base_url=local_forwarding_runtime,
        timeout=10,
        limits=limits,
    ) as client:

        async def consume_stream(index: int) -> None:
            async with client.stream("GET", f"/stream/{index}") as response:
                if response.status_code != 200:
                    body = await response.aread()
                    raise AssertionError(
                        "stream request failed: "
                        f"index={index}, status={response.status_code}, "
                        f"headers={dict(response.headers)}, body={body!r}"
                    )
                async for _ in response.aiter_lines():
                    pass

        streams = [asyncio.create_task(consume_stream(index)) for index in range(100)]
        probes_while_streaming = 0
        while any(not task.done() for task in streams):
            response = await client.get("/probe")
            assert response.status_code == 200
            if any(not task.done() for task in streams):
                probes_while_streaming += 1
        await asyncio.gather(*streams)

    assert probes_while_streaming >= 10


@pytest.mark.asyncio
async def test_blocked_stream_process_does_not_block_single_uvicorn_worker(
    blocking_forwarding_runtime: str,
) -> None:
    async with httpx.AsyncClient(
        base_url=blocking_forwarding_runtime,
        timeout=5,
    ) as client:
        stream_started = asyncio.Event()

        async def consume_stream() -> None:
            async with client.stream("GET", "/stream/301") as response:
                assert response.status_code == 200
                async for line in response.aiter_lines():
                    if line:
                        stream_started.set()

        stream_task = asyncio.create_task(consume_stream())
        await asyncio.wait_for(stream_started.wait(), timeout=2)

        probes_while_blocked = 0
        while not stream_task.done():
            response = await client.get("/probe")
            assert response.status_code == 200
            if not stream_task.done():
                probes_while_blocked += 1
        await stream_task

    assert probes_while_blocked >= 5
