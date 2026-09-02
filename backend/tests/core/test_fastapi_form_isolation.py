# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

import ast
import asyncio
import inspect
import threading
import time
from collections.abc import AsyncIterator
from tempfile import SpooledTemporaryFile
from typing import Annotated, Any

import httpx
import pytest
import starlette.formparsers
from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel, field_validator

from app.core import fastapi_form_isolation, fastapi_route_isolation
from app.core.bounded_executor import BoundedExecutor, BoundedExecutorOverloaded
from app.core.fastapi_form_isolation import (
    IsolatedRequest,
    IsolatedUploadFile,
    assert_fastapi_form_isolation_contract,
)
from app.core.fastapi_route_isolation import install_fastapi_route_isolation


async def _request(
    app: FastAPI,
    method: str,
    path: str,
    **kwargs: Any,
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
    raise AssertionError("form worker did not start")


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
async def test_multipart_parser_write_runs_off_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    started = threading.Event()
    release = threading.Event()
    worker_names: list[str] = []
    original_write = fastapi_form_isolation.PythonMultipartParser.write

    def blocking_write(parser: Any, data: bytes) -> int:
        worker_names.append(threading.current_thread().name)
        started.set()
        assert release.wait(timeout=3)
        return original_write(parser, data)

    monkeypatch.setattr(
        fastapi_form_isolation.PythonMultipartParser,
        "write",
        blocking_write,
    )
    app = FastAPI()

    @app.post("/upload")
    async def upload(file: UploadFile = File(...)) -> dict[str, int]:
        return {"size": len(await file.read())}

    install_fastapi_route_isolation(app)
    timer = _safety_release(release)
    task = asyncio.create_task(
        _request(
            app,
            "POST",
            "/upload",
            files={"file": ("data.bin", b"payload")},
        )
    )
    try:
        await _assert_loop_responsive(task, started, release)
    finally:
        release.set()
        timer.cancel()

    assert (await task).json() == {"size": 7}
    assert worker_names[0].startswith("wegent-fastapi-form")


@pytest.mark.asyncio
async def test_urlencoded_parser_write_runs_off_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    started = threading.Event()
    release = threading.Event()
    worker_names: list[str] = []
    original_write = fastapi_form_isolation.QuerystringParser.write

    def blocking_write(parser: Any, data: bytes) -> int:
        worker_names.append(threading.current_thread().name)
        started.set()
        assert release.wait(timeout=3)
        return original_write(parser, data)

    monkeypatch.setattr(
        fastapi_form_isolation.QuerystringParser,
        "write",
        blocking_write,
    )
    app = FastAPI()

    @app.post("/form")
    async def form(name: Annotated[str, Form()]) -> dict[str, str]:
        return {"name": name}

    install_fastapi_route_isolation(app)
    timer = _safety_release(release)
    task = asyncio.create_task(_request(app, "POST", "/form", data={"name": "wegent"}))
    try:
        await _assert_loop_responsive(task, started, release)
    finally:
        release.set()
        timer.cancel()

    assert (await task).json() == {"name": "wegent"}
    assert worker_names[0].startswith("wegent-fastapi-form")


@pytest.mark.asyncio
async def test_form_model_validation_runs_off_loop() -> None:
    started = threading.Event()
    release = threading.Event()
    worker_names: list[str] = []

    class Payload(BaseModel):
        name: str

        @field_validator("name")
        @classmethod
        def block_validation(cls, value: str) -> str:
            worker_names.append(threading.current_thread().name)
            started.set()
            assert release.wait(timeout=3)
            return value

    app = FastAPI()

    @app.post("/validate")
    async def validate(payload: Annotated[Payload, Form()]) -> dict[str, str]:
        return {"name": payload.name}

    install_fastapi_route_isolation(app)
    timer = _safety_release(release)
    task = asyncio.create_task(
        _request(app, "POST", "/validate", data={"name": "wegent"})
    )
    try:
        await _assert_loop_responsive(task, started, release)
    finally:
        release.set()
        timer.cancel()

    assert (await task).json() == {"name": "wegent"}
    assert worker_names[0].startswith("wegent-fastapi-form")


@pytest.mark.asyncio
async def test_upload_file_io_and_cleanup_use_named_executors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    operations: list[tuple[str, str]] = []

    class TrackingSpooledFile(SpooledTemporaryFile[bytes]):
        def write(self, data: bytes) -> int:
            operations.append(("write", threading.current_thread().name))
            return super().write(data)

        def read(self, size: int = -1) -> bytes:
            operations.append(("read", threading.current_thread().name))
            return super().read(size)

        def seek(self, offset: int, whence: int = 0) -> int:
            operations.append(("seek", threading.current_thread().name))
            return super().seek(offset, whence)

        def close(self) -> None:
            operations.append(("close", threading.current_thread().name))
            super().close()

    monkeypatch.setattr(
        starlette.formparsers,
        "SpooledTemporaryFile",
        TrackingSpooledFile,
    )
    app = FastAPI()

    @app.post("/upload")
    async def upload(file: UploadFile = File(...)) -> dict[str, str]:
        assert isinstance(file, IsolatedUploadFile)
        content = await file.read()
        await file.seek(0)
        await file.write(content)
        return {"content": content.decode()}

    install_fastapi_route_isolation(app)
    response = await _request(
        app,
        "POST",
        "/upload",
        files={"file": ("data.txt", b"payload")},
    )

    assert response.json() == {"content": "payload"}
    operation_threads: dict[str, list[str]] = {}
    for operation, thread_name in operations:
        operation_threads.setdefault(operation, []).append(thread_name)
    assert all(
        name.startswith("wegent-fastapi-form") for name in operation_threads["write"]
    )
    assert all(
        name.startswith("wegent-fastapi-form") for name in operation_threads["read"]
    )
    assert all(
        name.startswith("wegent-fastapi-form") for name in operation_threads["seek"]
    )
    assert operation_threads["close"][0].startswith("wegent-fastapi-form-cleanup")


@pytest.mark.asyncio
async def test_bytes_file_extraction_reads_off_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    read_threads: list[str] = []
    original_read = IsolatedUploadFile._read_sync

    def tracked_read(file: IsolatedUploadFile, size: int) -> bytes:
        read_threads.append(threading.current_thread().name)
        return original_read(file, size)

    monkeypatch.setattr(IsolatedUploadFile, "_read_sync", tracked_read)
    app = FastAPI()

    @app.post("/bytes")
    async def byte_upload(file: Annotated[bytes, File()]) -> dict[str, int]:
        return {"size": len(file)}

    install_fastapi_route_isolation(app)
    response = await _request(
        app,
        "POST",
        "/bytes",
        files={"file": ("data.bin", b"payload")},
    )

    assert response.json() == {"size": 7}
    assert read_threads
    assert all(name.startswith("wegent-fastapi-form") for name in read_threads)


@pytest.mark.asyncio
async def test_explicit_request_form_uses_isolated_request_and_file() -> None:
    app = FastAPI()

    @app.post("/raw")
    async def raw(request: Request) -> dict[str, str]:
        form = await request.form()
        file = form["file"]
        assert isinstance(request, IsolatedRequest)
        assert isinstance(file, IsolatedUploadFile)
        return {"content": (await file.read()).decode()}

    install_fastapi_route_isolation(app)
    response = await _request(
        app,
        "POST",
        "/raw",
        files={"file": ("data.txt", b"payload")},
    )

    assert response.status_code == 200
    assert response.json() == {"content": "payload"}


@pytest.mark.asyncio
async def test_form_executor_overload_fails_fast(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        fastapi_form_isolation,
        "_form_executor",
        BoundedExecutor(
            max_workers=1,
            max_in_flight=1,
            max_waiters=0,
            thread_name_prefix="test-form-overload",
        ),
    )
    started = threading.Event()
    release = threading.Event()
    original_write = fastapi_form_isolation.PythonMultipartParser.write

    def blocking_write(parser: Any, data: bytes) -> int:
        started.set()
        assert release.wait(timeout=3)
        return original_write(parser, data)

    monkeypatch.setattr(
        fastapi_form_isolation.PythonMultipartParser,
        "write",
        blocking_write,
    )
    app = FastAPI()

    @app.exception_handler(BoundedExecutorOverloaded)
    async def overloaded(_request: Request, _exc: Exception) -> JSONResponse:
        return JSONResponse(status_code=503, content={"detail": "overloaded"})

    @app.post("/upload")
    async def upload(file: UploadFile = File(...)) -> dict[str, int]:
        return {"size": len(await file.read())}

    install_fastapi_route_isolation(app)
    timer = _safety_release(release)
    first = asyncio.create_task(
        _request(
            app,
            "POST",
            "/upload",
            files={"file": ("first.bin", b"first")},
        )
    )
    try:
        await _wait_for_worker(started)
        started_at = time.monotonic()
        second = await asyncio.wait_for(
            _request(
                app,
                "POST",
                "/upload",
                files={"file": ("second.bin", b"second")},
            ),
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
async def test_multipart_live_form_capacity_fails_fast(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        fastapi_form_isolation,
        "_multipart_form_leases",
        fastapi_form_isolation._BoundedFormLeases(1),
    )
    endpoint_started = asyncio.Event()
    endpoint_release = asyncio.Event()
    app = FastAPI()

    @app.exception_handler(BoundedExecutorOverloaded)
    async def overloaded(_request: Request, _exc: Exception) -> JSONResponse:
        return JSONResponse(status_code=503, content={"detail": "overloaded"})

    @app.post("/upload")
    async def upload(file: UploadFile = File()) -> dict[str, bool]:
        assert file.filename
        endpoint_started.set()
        await endpoint_release.wait()
        return {"ok": True}

    install_fastapi_route_isolation(app)
    first = asyncio.create_task(
        _request(
            app,
            "POST",
            "/upload",
            files={"file": ("first.bin", b"first")},
        )
    )
    await asyncio.wait_for(endpoint_started.wait(), timeout=0.2)
    started_at = time.monotonic()
    second = await asyncio.wait_for(
        _request(
            app,
            "POST",
            "/upload",
            files={"file": ("second.bin", b"second")},
        ),
        timeout=0.2,
    )

    assert second.status_code == 503
    assert time.monotonic() - started_at < 0.2
    endpoint_release.set()
    assert (await first).status_code == 200


@pytest.mark.asyncio
async def test_cancelled_request_closes_form_files_off_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cleanup_finished = threading.Event()
    cleanup_threads: list[str] = []
    original_close = fastapi_form_isolation._close_files_sync

    def tracked_close(files: tuple[Any, ...]) -> None:
        cleanup_threads.append(threading.current_thread().name)
        original_close(files)
        cleanup_finished.set()

    monkeypatch.setattr(fastapi_form_isolation, "_close_files_sync", tracked_close)
    endpoint_started = asyncio.Event()
    app = FastAPI()

    @app.post("/cancel")
    async def cancel(file: UploadFile = File()) -> None:
        assert file.filename
        endpoint_started.set()
        await asyncio.Event().wait()

    install_fastapi_route_isolation(app)
    task = asyncio.create_task(
        _request(
            app,
            "POST",
            "/cancel",
            files={"file": ("data.bin", b"payload")},
        )
    )
    await asyncio.wait_for(endpoint_started.wait(), timeout=0.2)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert cleanup_finished.is_set()
    assert cleanup_threads[0].startswith("wegent-fastapi-form-cleanup")


@pytest.mark.asyncio
async def test_large_multipart_file_stays_streamed_and_spools_to_disk(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def body_must_not_be_buffered(_request: IsolatedRequest) -> bytes:
        raise AssertionError("multipart parser called request.body()")

    monkeypatch.setattr(IsolatedRequest, "body", body_must_not_be_buffered)
    app = FastAPI()

    @app.post("/large")
    async def large(file: UploadFile = File(...)) -> dict[str, int | bool]:
        return {
            "size": file.size or 0,
            "rolled": bool(getattr(file.file, "_rolled", False)),
        }

    install_fastapi_route_isolation(app)
    boundary = "wegent-boundary"
    payload_size = 1024 * 1024 + 256 * 1024

    async def content() -> AsyncIterator[bytes]:
        yield (
            f"--{boundary}\r\n"
            'Content-Disposition: form-data; name="file"; '
            'filename="large.bin"\r\n'
            "Content-Type: application/octet-stream\r\n\r\n"
        ).encode()
        chunk = b"x" * (64 * 1024)
        for _ in range(payload_size // len(chunk)):
            yield chunk
        yield f"\r\n--{boundary}--\r\n".encode()

    response = await _request(
        app,
        "POST",
        "/large",
        content=content(),
        headers={"content-type": f"multipart/form-data; boundary={boundary}"},
    )

    assert response.status_code == 200
    assert response.json() == {"size": payload_size, "rolled": True}


@pytest.mark.asyncio
async def test_form_error_semantics_match_fastapi() -> None:
    def build_app(isolated: bool) -> FastAPI:
        app = FastAPI()

        @app.post("/upload")
        async def upload(file: UploadFile = File()) -> None:
            assert file.filename
            return None

        if isolated:
            install_fastapi_route_isolation(app)
        return app

    baseline = build_app(False)
    isolated = build_app(True)
    kwargs = {
        "content": b"invalid",
        "headers": {"content-type": "multipart/form-data"},
    }
    baseline_response = await _request(baseline, "POST", "/upload", **kwargs)
    isolated_response = await _request(isolated, "POST", "/upload", **kwargs)

    assert isolated_response.status_code == baseline_response.status_code
    assert isolated_response.json() == baseline_response.json()


def test_form_private_adapter_contract_matches_locked_runtime() -> None:
    assert_fastapi_form_isolation_contract()


def test_form_adapter_has_no_implicit_executor_or_buffering_paths() -> None:
    source = inspect.getsource(fastapi_form_isolation)
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
    assert ("request", "body") not in called_attributes


def test_route_adapter_uses_isolated_form_conversion() -> None:
    source = inspect.getsource(fastapi_route_isolation._isolated_solve_dependencies)
    tree = ast.parse(source)
    called_names = {
        node.func.id
        for node in ast.walk(tree)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
    }

    assert "run_form_body_to_args" in called_names
