# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

import asyncio
import threading

import pytest

from app.services import chat_shell_model_service as service


class _Response:
    headers = {"content-type": "text/event-stream"}

    def raise_for_status(self) -> None:
        return None

    async def aiter_bytes(self):
        yield b'data: {"type":"first"}\n\n'
        yield b'data: {"type":"second"}\n\n'


class _StreamContext:
    async def __aenter__(self) -> _Response:
        return _Response()

    async def __aexit__(self, exc_type, exc, traceback) -> None:
        return None


class _Client:
    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, traceback) -> None:
        return None

    def stream(self, *args, **kwargs) -> _StreamContext:
        return _StreamContext()


async def _collect_stream() -> list[dict]:
    async with service.create_streaming_response(
        model="model",
        input_messages=[{"role": "user", "content": "hello"}],
    ) as stream:
        return [event async for event in stream]


async def _assert_blocking_call_does_not_block_loop(
    task: asyncio.Task,
    started: threading.Event,
    release: threading.Event,
    worker_threads: list[int],
) -> None:
    loop_thread = threading.get_ident()
    try:
        for _ in range(200):
            if started.is_set():
                break
            await asyncio.sleep(0.005)
        assert started.is_set()
        ticked = asyncio.Event()
        asyncio.get_running_loop().call_soon(ticked.set)
        await asyncio.wait_for(ticked.wait(), timeout=0.1)
        assert not task.done()
        assert worker_threads[0] != loop_thread
    finally:
        release.set()


@pytest.mark.asyncio
async def test_request_encoding_runs_off_loop(monkeypatch) -> None:
    started = threading.Event()
    release = threading.Event()
    worker_threads: list[int] = []
    original = service._encode_chat_shell_request

    def blocking_encode(**kwargs):
        worker_threads.append(threading.get_ident())
        started.set()
        release.wait(timeout=5)
        return original(**kwargs)

    monkeypatch.setattr(service, "_encode_chat_shell_request", blocking_encode)
    monkeypatch.setattr(service, "_build_client", lambda timeout=300.0: _Client())

    task = asyncio.create_task(_collect_stream())
    await _assert_blocking_call_does_not_block_loop(
        task,
        started,
        release,
        worker_threads,
    )

    assert [event["type"] for event in await task] == ["first", "second"]


@pytest.mark.asyncio
async def test_sse_decoding_runs_off_loop_and_preserves_order(monkeypatch) -> None:
    started = threading.Event()
    release = threading.Event()
    worker_threads: list[int] = []
    original = service._decode_sse_records

    def blocking_decode(pending: bytes, chunk: bytes, final: bool = False):
        worker_threads.append(threading.get_ident())
        if not started.is_set():
            started.set()
            release.wait(timeout=5)
        return original(pending, chunk, final)

    monkeypatch.setattr(service, "_decode_sse_records", blocking_decode)
    monkeypatch.setattr(service, "_build_client", lambda timeout=300.0: _Client())

    task = asyncio.create_task(_collect_stream())
    await _assert_blocking_call_does_not_block_loop(
        task,
        started,
        release,
        worker_threads,
    )

    assert [event["type"] for event in await task] == ["first", "second"]


@pytest.mark.asyncio
async def test_non_streaming_response_projection_runs_off_loop(monkeypatch) -> None:
    started = threading.Event()
    release = threading.Event()
    worker_threads: list[int] = []

    async def create_response(**kwargs):
        del kwargs
        return 'data: {"type":"response.output_text.done","text":"hello"}\n\n'

    def blocking_extract(response):
        del response
        worker_threads.append(threading.get_ident())
        started.set()
        release.wait(timeout=5)
        return "hello"

    monkeypatch.setattr(service, "create_response", create_response)
    monkeypatch.setattr(service, "extract_response_text", blocking_extract)

    task = asyncio.create_task(
        service.complete_text(
            model="model",
            input_messages=[{"role": "user", "content": "hello"}],
        )
    )
    await _assert_blocking_call_does_not_block_loop(
        task,
        started,
        release,
        worker_threads,
    )

    assert await task == "hello"
