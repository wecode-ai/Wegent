# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

import ast
import asyncio
import inspect
import threading
import time
from collections.abc import AsyncIterator, Iterator

import httpx
import pytest
from fastapi import BackgroundTasks, FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

from app.core import fastapi_response_isolation
from app.core.bounded_executor import BoundedExecutor, BoundedExecutorOverloaded
from app.core.fastapi_response_isolation import (
    assert_fastapi_response_isolation_contract,
)
from app.core.fastapi_route_isolation import install_fastapi_route_isolation


async def _request(app: FastAPI, path: str) -> httpx.Response:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        return await client.get(path)


async def _wait_for_worker(started: threading.Event) -> None:
    for _ in range(500):
        if started.is_set():
            return
        await asyncio.sleep(0.002)
    raise AssertionError("response worker did not start")


async def _assert_loop_responsive(
    task: asyncio.Task[httpx.Response],
    started: threading.Event,
    release: threading.Event,
) -> None:
    await _wait_for_worker(started)
    assert not task.done()
    assert not release.is_set()
    ticked = asyncio.Event()
    asyncio.get_running_loop().call_soon(ticked.set)
    await asyncio.wait_for(ticked.wait(), timeout=0.1)


def _safety_release(release: threading.Event) -> threading.Timer:
    timer = threading.Timer(2, release.set)
    timer.start()
    return timer


@pytest.mark.asyncio
async def test_sync_background_tasks_run_off_loop_in_order() -> None:
    started = threading.Event()
    release = threading.Event()
    events: list[tuple[str, str]] = []

    def first(value: str) -> None:
        events.append((value, threading.current_thread().name))
        started.set()
        assert release.wait(timeout=3)

    async def second() -> None:
        events.append(("second", threading.current_thread().name))

    app = FastAPI()

    @app.get("/background")
    async def background(tasks: BackgroundTasks) -> dict[str, bool]:
        tasks.add_task(first, "first")
        tasks.add_task(second)
        tasks.add_task(events.append, ("third", "sync"))
        return {"ok": True}

    install_fastapi_route_isolation(app)
    timer = _safety_release(release)
    task = asyncio.create_task(_request(app, "/background"))
    try:
        await _assert_loop_responsive(task, started, release)
    finally:
        release.set()
        timer.cancel()

    assert (await task).json() == {"ok": True}
    assert [event[0] for event in events] == ["first", "second", "third"]
    assert events[0][1].startswith("wegent-fastapi-background")


@pytest.mark.asyncio
async def test_background_capacity_overload_fails_before_response_start(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        fastapi_response_isolation,
        "_background_executor",
        BoundedExecutor(
            max_workers=1,
            max_in_flight=1,
            max_waiters=0,
            thread_name_prefix="test-background-overload",
        ),
    )
    monkeypatch.setattr(
        fastapi_response_isolation,
        "_background_leases",
        fastapi_response_isolation._BoundedResponseLeases(1, "background"),
    )
    started = threading.Event()
    release = threading.Event()

    def blocking_background() -> None:
        started.set()
        assert release.wait(timeout=3)

    app = FastAPI()

    @app.exception_handler(BoundedExecutorOverloaded)
    async def overloaded(_request: Request, _exc: Exception) -> JSONResponse:
        return JSONResponse(status_code=503, content={"detail": "overloaded"})

    @app.get("/background")
    async def background(tasks: BackgroundTasks) -> dict[str, bool]:
        tasks.add_task(blocking_background)
        return {"ok": True}

    install_fastapi_route_isolation(app)
    timer = _safety_release(release)
    first = asyncio.create_task(_request(app, "/background"))
    try:
        await _wait_for_worker(started)
        started_at = time.monotonic()
        second = await asyncio.wait_for(
            _request(app, "/background"),
            timeout=0.2,
        )
        assert second.status_code == 503
        assert time.monotonic() - started_at < 0.2
        assert not first.done()
    finally:
        release.set()
        timer.cancel()

    assert (await first).status_code == 200


@pytest.mark.asyncio
async def test_cancelled_sync_background_is_not_abandoned(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        fastapi_response_isolation,
        "_background_executor",
        BoundedExecutor(
            max_workers=1,
            max_in_flight=1,
            max_waiters=0,
            thread_name_prefix="test-background-cancel",
        ),
    )
    monkeypatch.setattr(
        fastapi_response_isolation,
        "_background_leases",
        fastapi_response_isolation._BoundedResponseLeases(1, "background"),
    )
    started = threading.Event()
    release = threading.Event()
    finished = threading.Event()

    def blocking_background() -> None:
        started.set()
        assert release.wait(timeout=3)
        finished.set()

    app = FastAPI()

    @app.get("/background")
    async def background(tasks: BackgroundTasks) -> dict[str, bool]:
        tasks.add_task(blocking_background)
        return {"ok": True}

    install_fastapi_route_isolation(app)
    timer = _safety_release(release)
    task = asyncio.create_task(_request(app, "/background"))
    await _wait_for_worker(started)
    task.cancel()
    await asyncio.sleep(0)
    assert not task.done()
    release.set()
    try:
        with pytest.raises(asyncio.CancelledError):
            await task
    finally:
        release.set()
        timer.cancel()

    assert finished.is_set()
    assert (await _request(app, "/background")).status_code == 200


class _BlockingIterator(Iterator[bytes]):
    def __init__(
        self,
        started: threading.Event,
        release: threading.Event,
        operations: list[tuple[str, str]],
    ) -> None:
        self._started = started
        self._release = release
        self._operations = operations
        self._yielded = False

    def __iter__(self) -> "_BlockingIterator":
        self._operations.append(("iter", threading.current_thread().name))
        return self

    def __next__(self) -> bytes:
        self._operations.append(("next", threading.current_thread().name))
        if self._yielded:
            raise StopIteration
        self._started.set()
        assert self._release.wait(timeout=3)
        self._yielded = True
        return b"payload"

    def close(self) -> None:
        self._operations.append(("close", threading.current_thread().name))


@pytest.mark.asyncio
async def test_sync_stream_iteration_and_cleanup_run_off_loop() -> None:
    started = threading.Event()
    release = threading.Event()
    operations: list[tuple[str, str]] = []
    stream = _BlockingIterator(started, release, operations)
    app = FastAPI()

    @app.get("/stream")
    async def streamed() -> StreamingResponse:
        return StreamingResponse(stream)

    install_fastapi_route_isolation(app)
    timer = _safety_release(release)
    task = asyncio.create_task(_request(app, "/stream"))
    try:
        await _assert_loop_responsive(task, started, release)
    finally:
        release.set()
        timer.cancel()

    assert (await task).content == b"payload"
    operation_threads: dict[str, list[str]] = {}
    for operation, thread_name in operations:
        operation_threads.setdefault(operation, []).append(thread_name)
    assert operation_threads["iter"][0].startswith("wegent-fastapi-stream-iterator")
    assert all(
        name.startswith("wegent-fastapi-stream-iterator")
        for name in operation_threads["next"]
    )
    assert operation_threads["close"][0].startswith("wegent-fastapi-stream-cleanup")


@pytest.mark.asyncio
async def test_sync_stream_capacity_overload_fails_before_response_start(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        fastapi_response_isolation,
        "_stream_iterator_executor",
        BoundedExecutor(
            max_workers=1,
            max_in_flight=1,
            max_waiters=0,
            thread_name_prefix="test-stream-overload",
        ),
    )
    monkeypatch.setattr(
        fastapi_response_isolation,
        "_stream_leases",
        fastapi_response_isolation._BoundedResponseLeases(1, "stream"),
    )
    started = threading.Event()
    release = threading.Event()
    streams: list[_BlockingIterator] = []
    app = FastAPI()

    @app.exception_handler(BoundedExecutorOverloaded)
    async def overloaded(_request: Request, _exc: Exception) -> JSONResponse:
        return JSONResponse(status_code=503, content={"detail": "overloaded"})

    @app.get("/stream")
    async def streamed() -> StreamingResponse:
        stream = _BlockingIterator(started, release, [])
        streams.append(stream)
        return StreamingResponse(stream)

    install_fastapi_route_isolation(app)
    timer = _safety_release(release)
    first = asyncio.create_task(_request(app, "/stream"))
    try:
        await _wait_for_worker(started)
        started_at = time.monotonic()
        second = await asyncio.wait_for(_request(app, "/stream"), timeout=0.2)
        assert second.status_code == 503
        assert time.monotonic() - started_at < 0.2
        assert not first.done()
    finally:
        release.set()
        timer.cancel()

    assert (await first).content == b"payload"


@pytest.mark.asyncio
async def test_cancelled_sync_stream_waits_for_next_and_closes_resource() -> None:
    started = threading.Event()
    release = threading.Event()
    operations: list[tuple[str, str]] = []
    stream = _BlockingIterator(started, release, operations)
    app = FastAPI()

    @app.get("/stream")
    async def streamed() -> StreamingResponse:
        return StreamingResponse(stream)

    install_fastapi_route_isolation(app)
    timer = _safety_release(release)
    task = asyncio.create_task(_request(app, "/stream"))
    await _wait_for_worker(started)
    task.cancel()
    await asyncio.sleep(0)
    assert not task.done()
    release.set()
    try:
        with pytest.raises(asyncio.CancelledError):
            await task
    finally:
        release.set()
        timer.cancel()

    closes = [thread for operation, thread in operations if operation == "close"]
    assert closes == [closes[0]]
    assert closes[0].startswith("wegent-fastapi-stream-cleanup")


@pytest.mark.asyncio
async def test_async_stream_keeps_event_loop_semantics() -> None:
    loop_thread = threading.get_ident()
    stream_threads: list[int] = []
    app = FastAPI()

    async def content() -> AsyncIterator[bytes]:
        stream_threads.append(threading.get_ident())
        yield b"async"

    @app.get("/stream")
    async def streamed() -> StreamingResponse:
        return StreamingResponse(content())

    install_fastapi_route_isolation(app)
    response = await _request(app, "/stream")

    assert response.content == b"async"
    assert stream_threads == [loop_thread]


def test_response_private_adapter_contract_matches_locked_runtime() -> None:
    assert_fastapi_response_isolation_contract()


def test_response_adapter_has_no_implicit_executor_paths() -> None:
    source = inspect.getsource(fastapi_response_isolation)
    tree = ast.parse(source)
    called_names = {
        node.func.id
        for node in ast.walk(tree)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
    }
    called_attributes = {
        (node.func.value.id, node.func.attr)
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and isinstance(node.func.value, ast.Name)
    }

    assert "run_in_threadpool" not in called_names
    assert "iterate_in_threadpool" not in called_names
    assert ("asyncio", "to_thread") not in called_attributes
