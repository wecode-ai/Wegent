# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

import ast
import asyncio
import inspect
import json
import threading
import time
from collections.abc import AsyncIterator, Callable, Iterator
from typing import Annotated, Any

import httpx
import pytest
from fastapi import BackgroundTasks, Depends, FastAPI, Request, Response
from fastapi.exceptions import ResponseValidationError
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, BeforeValidator, field_validator

from app.core import fastapi_route_isolation, payload_codec
from app.core.bounded_executor import BoundedExecutor, BoundedExecutorOverloaded
from app.core.fastapi_route_isolation import (
    IsolatedAPIRoute,
    assert_fastapi_route_isolation_contract,
    install_fastapi_route_isolation,
    route_has_payload_isolation,
)


async def _request(
    app: FastAPI, method: str, path: str, **kwargs: Any
) -> httpx.Response:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        return await client.request(method, path, **kwargs)


async def _wait_for_worker(started: threading.Event) -> None:
    for _ in range(500):
        if started.is_set():
            return
        await asyncio.sleep(0.002)
    raise AssertionError("codec worker did not start")


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
async def test_json_decode_runs_off_loop_and_preserves_request_json_cache(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    started = threading.Event()
    release = threading.Event()
    worker_threads: list[int] = []
    decode_calls = 0

    def blocking_decode(body: bytes) -> Any:
        nonlocal decode_calls
        decode_calls += 1
        worker_threads.append(threading.get_ident())
        started.set()
        assert release.wait(timeout=3)
        return json.loads(body)

    monkeypatch.setattr(fastapi_route_isolation, "_decode_json_sync", blocking_decode)

    class Payload(BaseModel):
        value: int

    app = FastAPI()

    @app.post("/decode")
    async def decode(payload: Payload, request: Request) -> dict[str, int]:
        cached = await request.json()
        return {"value": payload.value, "cached": cached["value"]}

    install_fastapi_route_isolation(app)
    loop_thread = threading.get_ident()
    timer = _safety_release(release)
    task = asyncio.create_task(_request(app, "POST", "/decode", json={"value": 7}))
    try:
        await _assert_loop_responsive(task, started, release)
    finally:
        release.set()
        timer.cancel()

    response = await task
    assert response.status_code == 200
    assert response.json() == {"value": 7, "cached": 7}
    assert decode_calls == 1
    assert worker_threads == [worker_threads[0]]
    assert worker_threads[0] != loop_thread


@pytest.mark.asyncio
async def test_request_model_validation_runs_off_loop() -> None:
    started = threading.Event()
    release = threading.Event()
    worker_threads: list[int] = []

    class Payload(BaseModel):
        value: int

        @field_validator("value")
        @classmethod
        def block_validation(cls, value: int) -> int:
            worker_threads.append(threading.get_ident())
            started.set()
            assert release.wait(timeout=3)
            return value

    app = FastAPI()

    @app.post("/validate")
    async def validate(payload: Payload) -> dict[str, int]:
        return {"value": payload.value}

    install_fastapi_route_isolation(app)
    loop_thread = threading.get_ident()
    timer = _safety_release(release)
    task = asyncio.create_task(_request(app, "POST", "/validate", json={"value": 1}))
    try:
        await _assert_loop_responsive(task, started, release)
    finally:
        release.set()
        timer.cancel()

    assert (await task).status_code == 200
    assert worker_threads[0] != loop_thread


@pytest.mark.asyncio
async def test_query_parameter_validation_runs_off_loop() -> None:
    started = threading.Event()
    release = threading.Event()
    worker_threads: list[int] = []

    def block_validation(value: Any) -> Any:
        worker_threads.append(threading.get_ident())
        started.set()
        assert release.wait(timeout=3)
        return value

    app = FastAPI()

    @app.get("/query")
    async def query(
        value: Annotated[int, BeforeValidator(block_validation)],
    ) -> dict[str, int]:
        return {"value": value}

    install_fastapi_route_isolation(app)
    loop_thread = threading.get_ident()
    timer = _safety_release(release)
    task = asyncio.create_task(_request(app, "GET", "/query?value=1"))
    try:
        await _assert_loop_responsive(task, started, release)
    finally:
        release.set()
        timer.cancel()

    assert (await task).json() == {"value": 1}
    assert worker_threads[0] != loop_thread


@pytest.mark.asyncio
async def test_response_model_validation_runs_off_loop() -> None:
    started = threading.Event()
    release = threading.Event()
    worker_threads: list[int] = []

    class Result(BaseModel):
        value: int

        @field_validator("value")
        @classmethod
        def block_validation(cls, value: int) -> int:
            worker_threads.append(threading.get_ident())
            started.set()
            assert release.wait(timeout=3)
            return value

    app = FastAPI()

    @app.get("/result", response_model=Result)
    async def result() -> dict[str, int]:
        return {"value": 1}

    install_fastapi_route_isolation(app)
    loop_thread = threading.get_ident()
    timer = _safety_release(release)
    task = asyncio.create_task(_request(app, "GET", "/result"))
    try:
        await _assert_loop_responsive(task, started, release)
    finally:
        release.set()
        timer.cancel()

    assert (await task).json() == {"value": 1}
    assert worker_threads[0] != loop_thread


@pytest.mark.asyncio
async def test_response_render_runs_off_loop() -> None:
    started = threading.Event()
    release = threading.Event()
    worker_threads: list[int] = []

    class BlockingJSONResponse(JSONResponse):
        def render(self, content: Any) -> bytes:
            worker_threads.append(threading.get_ident())
            started.set()
            assert release.wait(timeout=3)
            return super().render(content)

    app = FastAPI()

    @app.get("/render", response_class=BlockingJSONResponse)
    async def render() -> dict[str, int]:
        return {"value": 1}

    install_fastapi_route_isolation(app)
    loop_thread = threading.get_ident()
    timer = _safety_release(release)
    task = asyncio.create_task(_request(app, "GET", "/render"))
    try:
        await _assert_loop_responsive(task, started, release)
    finally:
        release.set()
        timer.cancel()

    assert (await task).json() == {"value": 1}
    assert worker_threads[0] != loop_thread


@pytest.mark.asyncio
async def test_payload_codec_overload_rejects_without_waiting(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    executor = BoundedExecutor(
        max_workers=1,
        max_in_flight=1,
        max_waiters=0,
        thread_name_prefix="test-route-codec-overload",
    )
    monkeypatch.setattr(payload_codec, "_payload_codec_executor", executor)
    started = threading.Event()
    release = threading.Event()

    class Payload(BaseModel):
        value: int

        @field_validator("value")
        @classmethod
        def block_validation(cls, value: int) -> int:
            started.set()
            assert release.wait(timeout=3)
            return value

    app = FastAPI()

    @app.exception_handler(BoundedExecutorOverloaded)
    async def overloaded(_request: Request, _exc: Exception) -> JSONResponse:
        return JSONResponse(status_code=503, content={"detail": "overloaded"})

    @app.post("/bounded")
    async def bounded(payload: Payload) -> dict[str, int]:
        return {"value": payload.value}

    install_fastapi_route_isolation(app)
    timer = _safety_release(release)
    first = asyncio.create_task(_request(app, "POST", "/bounded", json={"value": 1}))
    try:
        await _wait_for_worker(started)
        started_at = time.monotonic()
        second = await asyncio.wait_for(
            _request(app, "POST", "/bounded", json={"value": 2}),
            timeout=0.2,
        )
        elapsed = time.monotonic() - started_at
        assert second.status_code == 503
        assert elapsed < 0.2
        assert not first.done()
    finally:
        release.set()
        timer.cancel()

    assert (await first).status_code == 200


@pytest.mark.asyncio
async def test_sync_dependency_runs_off_loop_without_blocking_it() -> None:
    started = threading.Event()
    release = threading.Event()
    worker_threads: list[int] = []

    def dependency() -> str:
        worker_threads.append(threading.get_ident())
        started.set()
        assert release.wait(timeout=3)
        return "ready"

    app = FastAPI()

    @app.get("/sync-dependency")
    async def sync_dependency(ready: str = Depends(dependency)) -> dict[str, str]:
        return {"state": ready}

    install_fastapi_route_isolation(app)
    loop_thread = threading.get_ident()
    timer = _safety_release(release)
    task = asyncio.create_task(_request(app, "GET", "/sync-dependency"))
    try:
        await _assert_loop_responsive(task, started, release)
    finally:
        release.set()
        timer.cancel()

    assert (await task).json() == {"state": "ready"}
    assert worker_threads[0] != loop_thread


@pytest.mark.asyncio
async def test_sync_endpoint_runs_off_loop_without_blocking_it() -> None:
    started = threading.Event()
    release = threading.Event()
    worker_threads: list[int] = []
    app = FastAPI()

    @app.get("/sync-endpoint")
    def sync_endpoint() -> dict[str, bool]:
        worker_threads.append(threading.get_ident())
        started.set()
        assert release.wait(timeout=3)
        return {"ok": True}

    install_fastapi_route_isolation(app)
    loop_thread = threading.get_ident()
    timer = _safety_release(release)
    task = asyncio.create_task(_request(app, "GET", "/sync-endpoint"))
    try:
        await _assert_loop_responsive(task, started, release)
    finally:
        release.set()
        timer.cancel()

    assert (await task).json() == {"ok": True}
    assert worker_threads[0] != loop_thread


@pytest.mark.asyncio
@pytest.mark.parametrize("blocking_phase", ["dependency", "endpoint"])
async def test_sync_web_executor_overload_rejects_without_waiting(
    monkeypatch: pytest.MonkeyPatch,
    blocking_phase: str,
) -> None:
    executor = BoundedExecutor(
        max_workers=1,
        max_in_flight=1,
        max_waiters=0,
        thread_name_prefix=f"test-sync-{blocking_phase}-overload",
    )
    monkeypatch.setattr(fastapi_route_isolation, "_sync_web_executor", executor)
    started = threading.Event()
    release = threading.Event()

    def blocker() -> str:
        started.set()
        assert release.wait(timeout=3)
        return "ready"

    app = FastAPI()

    @app.exception_handler(BoundedExecutorOverloaded)
    async def overloaded(_request: Request, _exc: Exception) -> JSONResponse:
        return JSONResponse(status_code=503, content={"detail": "overloaded"})

    if blocking_phase == "dependency":

        @app.get("/bounded-sync")
        async def bounded_dependency(
            ready: str = Depends(blocker),
        ) -> dict[str, str]:
            return {"state": ready}

    else:

        @app.get("/bounded-sync")
        def bounded_endpoint() -> dict[str, str]:
            return {"state": blocker()}

    install_fastapi_route_isolation(app)
    timer = _safety_release(release)
    first = asyncio.create_task(_request(app, "GET", "/bounded-sync"))
    try:
        await _wait_for_worker(started)
        started_at = time.monotonic()
        second = await asyncio.wait_for(
            _request(app, "GET", "/bounded-sync"),
            timeout=0.2,
        )
        elapsed = time.monotonic() - started_at
        assert second.status_code == 503
        assert elapsed < 0.2
        assert not first.done()
    finally:
        release.set()
        timer.cancel()

    assert (await first).status_code == 200


@pytest.mark.asyncio
async def test_sync_generator_enter_and_exit_run_off_loop() -> None:
    enter_started = threading.Event()
    enter_release = threading.Event()
    exit_started = threading.Event()
    exit_release = threading.Event()
    enter_threads: list[int] = []
    exit_threads: list[int] = []
    worker_names: list[str] = []

    def dependency() -> Iterator[str]:
        enter_threads.append(threading.get_ident())
        worker_names.append(threading.current_thread().name)
        enter_started.set()
        assert enter_release.wait(timeout=3)
        try:
            yield "ready"
        finally:
            exit_threads.append(threading.get_ident())
            worker_names.append(threading.current_thread().name)
            exit_started.set()
            assert exit_release.wait(timeout=3)

    app = FastAPI()

    @app.get("/sync-context")
    async def sync_context(ready: str = Depends(dependency)) -> dict[str, str]:
        return {"state": ready}

    install_fastapi_route_isolation(app)
    loop_thread = threading.get_ident()
    enter_timer = _safety_release(enter_release)
    exit_timer = _safety_release(exit_release)
    task = asyncio.create_task(_request(app, "GET", "/sync-context"))
    try:
        await _assert_loop_responsive(task, enter_started, enter_release)
        enter_release.set()
        await _assert_loop_responsive(task, exit_started, exit_release)
    finally:
        enter_release.set()
        exit_release.set()
        enter_timer.cancel()
        exit_timer.cancel()

    assert (await task).json() == {"state": "ready"}
    assert enter_threads[0] != loop_thread
    assert exit_threads[0] != loop_thread
    assert worker_names[0].startswith("wegent-fastapi-sync")
    assert worker_names[1].startswith("wegent-fastapi-dependency-cleanup")


@pytest.mark.asyncio
async def test_sync_generator_cleans_up_when_endpoint_raises() -> None:
    events: list[str] = []
    cleanup_threads: list[int] = []

    def dependency() -> Iterator[None]:
        events.append("enter")
        try:
            yield
        finally:
            cleanup_threads.append(threading.get_ident())
            events.append("exit")

    app = FastAPI()

    @app.get("/failure")
    async def failure(_value: None = Depends(dependency)) -> None:
        events.append("endpoint")
        raise RuntimeError("endpoint failed")

    install_fastapi_route_isolation(app)
    loop_thread = threading.get_ident()
    with pytest.raises(RuntimeError, match="endpoint failed"):
        await _request(app, "GET", "/failure")

    assert events == ["enter", "endpoint", "exit"]
    assert cleanup_threads[0] != loop_thread


@pytest.mark.asyncio
async def test_sync_generator_enter_cancellation_does_not_leak_context() -> None:
    enter_started = threading.Event()
    enter_release = threading.Event()
    cleanup_finished = threading.Event()

    def dependency() -> Iterator[None]:
        enter_started.set()
        assert enter_release.wait(timeout=3)
        try:
            yield
        finally:
            cleanup_finished.set()

    app = FastAPI()

    @app.get("/cancel-enter")
    async def cancel_enter(_value: None = Depends(dependency)) -> None:
        raise AssertionError("cancelled request reached its endpoint")

    install_fastapi_route_isolation(app)
    timer = _safety_release(enter_release)
    task = asyncio.create_task(_request(app, "GET", "/cancel-enter"))
    await _wait_for_worker(enter_started)
    task.cancel()
    await asyncio.sleep(0)
    assert not task.done()
    enter_release.set()
    try:
        with pytest.raises(asyncio.CancelledError):
            await task
    finally:
        enter_release.set()
        timer.cancel()

    assert cleanup_finished.is_set()


@pytest.mark.asyncio
async def test_sync_dependency_cache_semantics_are_preserved() -> None:
    calls = 0

    def dependency() -> int:
        nonlocal calls
        calls += 1
        return calls

    app = FastAPI()

    @app.get("/cache")
    async def cache(
        first: int = Depends(dependency),
        second: int = Depends(dependency),
        uncached: int = Depends(dependency, use_cache=False),
    ) -> list[int]:
        return [first, second, uncached]

    install_fastapi_route_isolation(app)
    response = await _request(app, "GET", "/cache")

    assert response.json() == [1, 1, 2]
    assert calls == 2


@pytest.mark.asyncio
async def test_sync_context_capacity_overload_is_fail_fast(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        fastapi_route_isolation,
        "_sync_dependency_context_leases",
        fastapi_route_isolation._BoundedContextLeases(1),
    )
    endpoint_started = asyncio.Event()
    endpoint_release = asyncio.Event()

    def dependency() -> Iterator[None]:
        yield

    app = FastAPI()

    @app.exception_handler(BoundedExecutorOverloaded)
    async def overloaded(_request: Request, _exc: Exception) -> JSONResponse:
        return JSONResponse(status_code=503, content={"detail": "overloaded"})

    @app.get("/context-capacity")
    async def context_capacity(_value: None = Depends(dependency)) -> None:
        endpoint_started.set()
        await endpoint_release.wait()

    install_fastapi_route_isolation(app)
    first = asyncio.create_task(_request(app, "GET", "/context-capacity"))
    await asyncio.wait_for(endpoint_started.wait(), timeout=0.2)
    started_at = time.monotonic()
    second = await asyncio.wait_for(
        _request(app, "GET", "/context-capacity"),
        timeout=0.2,
    )
    elapsed = time.monotonic() - started_at
    assert second.status_code == 503
    assert elapsed < 0.2
    endpoint_release.set()
    assert (await first).status_code == 200


@pytest.mark.asyncio
async def test_fastapi_response_and_dependency_lifecycle_semantics_are_preserved() -> (
    None
):
    events: list[str] = []

    async def dependency() -> AsyncIterator[str]:
        events.append("dependency-enter")
        try:
            yield "ready"
        finally:
            events.append("dependency-exit")

    async def stream() -> AsyncIterator[bytes]:
        events.append("stream")
        yield b"payload"

    def background() -> None:
        events.append("background")

    app = FastAPI()

    @app.get("/stream")
    async def stream_response(
        background_tasks: BackgroundTasks,
        ready: str = Depends(dependency),
    ) -> StreamingResponse:
        assert ready == "ready"
        background_tasks.add_task(background)
        return StreamingResponse(
            stream(),
            status_code=207,
            headers={"X-Route": "stream"},
        )

    install_fastapi_route_isolation(app)
    response = await _request(app, "GET", "/stream")

    assert response.status_code == 207
    assert response.headers["x-route"] == "stream"
    assert response.content == b"payload"
    assert events == [
        "dependency-enter",
        "stream",
        "background",
        "dependency-exit",
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("dependency_scope", "expected_events"),
    [
        (
            None,
            ["dependency-enter", "stream", "background", "dependency-exit"],
        ),
        (
            "function",
            ["dependency-enter", "dependency-exit", "stream", "background"],
        ),
    ],
)
async def test_sync_generator_dependency_scope_semantics_are_preserved(
    dependency_scope: str | None,
    expected_events: list[str],
) -> None:
    events: list[str] = []

    def dependency() -> Iterator[str]:
        events.append("dependency-enter")
        try:
            yield "ready"
        finally:
            events.append("dependency-exit")

    async def stream() -> AsyncIterator[bytes]:
        events.append("stream")
        yield b"payload"

    def background() -> None:
        events.append("background")

    app = FastAPI()
    dependency_spec = Depends(dependency, scope=dependency_scope)

    @app.get("/sync-scope")
    async def sync_scope(
        background_tasks: BackgroundTasks,
        ready: str = dependency_spec,
    ) -> StreamingResponse:
        assert ready == "ready"
        background_tasks.add_task(background)
        return StreamingResponse(stream())

    install_fastapi_route_isolation(app)
    response = await _request(app, "GET", "/sync-scope")

    assert response.status_code == 200
    assert response.content == b"payload"
    assert events == expected_events


@pytest.mark.asyncio
async def test_automatic_response_status_headers_and_background_are_preserved() -> None:
    events: list[str] = []

    class Result(BaseModel):
        value: int

    app = FastAPI()

    @app.post("/automatic", response_model=Result)
    async def automatic(
        response: Response,
        background_tasks: BackgroundTasks,
    ) -> dict[str, int]:
        response.status_code = 201
        response.headers["X-Route"] = "automatic"
        background_tasks.add_task(events.append, "background")
        return {"value": 1}

    install_fastapi_route_isolation(app)
    response = await _request(app, "POST", "/automatic")

    assert response.status_code == 201
    assert response.headers["x-route"] == "automatic"
    assert response.json() == {"value": 1}
    assert events == ["background"]


@pytest.mark.asyncio
async def test_validation_error_semantics_match_fastapi() -> None:
    class Payload(BaseModel):
        value: int

    def build_app(installer: Callable[[FastAPI], None] | None) -> FastAPI:
        app = FastAPI()

        @app.post("/payload")
        async def payload(_payload: Payload) -> None:
            return None

        if installer:
            installer(app)
        return app

    baseline = build_app(None)
    isolated = build_app(install_fastapi_route_isolation)
    for content in (b'{"value":', b'{"value":"bad"}'):
        baseline_response = await _request(
            baseline,
            "POST",
            "/payload",
            content=content,
            headers={"content-type": "application/json"},
        )
        isolated_response = await _request(
            isolated,
            "POST",
            "/payload",
            content=content,
            headers={"content-type": "application/json"},
        )
        assert isolated_response.status_code == baseline_response.status_code
        assert isolated_response.json() == baseline_response.json()


@pytest.mark.asyncio
async def test_response_validation_error_semantics_match_fastapi() -> None:
    class Result(BaseModel):
        value: int

    def build_app(installer: Callable[[FastAPI], None] | None) -> FastAPI:
        app = FastAPI()

        @app.get("/result", response_model=Result)
        async def result() -> dict[str, str]:
            return {"value": "bad"}

        if installer:
            installer(app)
        return app

    baseline = build_app(None)
    isolated = build_app(install_fastapi_route_isolation)
    with pytest.raises(ResponseValidationError) as baseline_exc:
        await _request(baseline, "GET", "/result")
    with pytest.raises(ResponseValidationError) as isolated_exc:
        await _request(isolated, "GET", "/result")

    assert isolated_exc.value.errors() == baseline_exc.value.errors()


def test_installer_covers_existing_and_future_routes() -> None:
    app = FastAPI()

    @app.get("/before")
    async def before() -> dict[str, bool]:
        return {"ok": True}

    install_fastapi_route_isolation(app)

    @app.get("/after")
    async def after() -> dict[str, bool]:
        return {"ok": True}

    routes = {route.path: route for route in app.routes if isinstance(route, APIRoute)}
    assert route_has_payload_isolation(routes["/before"])
    assert route_has_payload_isolation(routes["/after"])
    assert isinstance(routes["/after"], IsolatedAPIRoute)
    assert app.state.fastapi_route_isolation_installed is True


@pytest.mark.asyncio
async def test_installer_is_idempotent() -> None:
    app = FastAPI()

    @app.get("/before")
    async def before() -> dict[str, bool]:
        return {"ok": True}

    install_fastapi_route_isolation(app)
    route = next(
        route
        for route in app.routes
        if isinstance(route, APIRoute) and route.path == "/before"
    )
    installed_app = route.app

    install_fastapi_route_isolation(app)

    assert route.app is installed_app
    response = await _request(app, "GET", "/before")
    assert response.status_code == 200
    assert response.json() == {"ok": True}


def test_installer_covers_mounted_fastapi_routes() -> None:
    mounted = FastAPI()

    @mounted.get("/before")
    async def before() -> dict[str, bool]:
        return {"ok": True}

    app = FastAPI()
    app.mount("/mounted", mounted)
    install_fastapi_route_isolation(app)

    @mounted.get("/after")
    async def after() -> dict[str, bool]:
        return {"ok": True}

    routes = [route for route in mounted.routes if isinstance(route, APIRoute)]
    assert routes
    assert all(route_has_payload_isolation(route) for route in routes)


def test_main_application_has_no_unisolated_api_routes() -> None:
    from app.main import _fastapi_app

    routes = [route for route in _fastapi_app.routes if isinstance(route, APIRoute)]
    assert routes
    assert all(route_has_payload_isolation(route) for route in routes)
    root_route = next(route for route in routes if route.path == "/")
    assert isinstance(root_route, IsolatedAPIRoute)


def test_fastapi_private_adapter_contract_matches_locked_runtime() -> None:
    assert_fastapi_route_isolation_contract()


def test_adapter_does_not_call_implicit_executor_paths() -> None:
    source = inspect.getsource(fastapi_route_isolation)
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
    assert "run_endpoint_function" not in called_names
    assert "fastapi_run_endpoint_function" not in called_names
    assert "fastapi_solve_generator" not in called_names
    assert ("asyncio", "to_thread") not in called_attributes


def test_fastapi_private_adapter_rejects_unknown_runtime(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert_fastapi_route_isolation_contract.cache_clear()
    monkeypatch.setattr(fastapi_route_isolation.fastapi, "__version__", "999.0.0")
    try:
        with pytest.raises(RuntimeError, match="supports exactly"):
            assert_fastapi_route_isolation_contract()
    finally:
        assert_fastapi_route_isolation_contract.cache_clear()
