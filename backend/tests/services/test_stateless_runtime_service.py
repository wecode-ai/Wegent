# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
import threading
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest

from app.services.model_runtime import stateless_runtime_service as runtime_service
from app.services.model_runtime.stateless_runtime_service import (
    normalize_input_messages,
    serialize_stream_event,
)


def test_normalize_input_messages_wraps_string_as_user_message():
    result = normalize_input_messages("hello runtime")

    assert result == [{"role": "user", "content": "hello runtime"}]


def test_serialize_stream_event_prefers_model_dump_payload():
    event = SimpleNamespace(
        model_dump=lambda: {"type": "response.completed", "done": True}
    )

    result = serialize_stream_event(event)

    assert result == 'data: {"type": "response.completed", "done": true}\n\n'


@pytest.mark.asyncio
async def test_stream_event_codec_is_nonblocking_and_ordered(monkeypatch) -> None:
    started = threading.Event()
    release = threading.Event()
    worker_thread_ids: list[int] = []
    original = runtime_service.serialize_stream_event

    def blocking_first(event):
        worker_thread_ids.append(threading.get_ident())
        if not started.is_set():
            started.set()
            release.wait(timeout=5)
        return original(event)

    class Stream:
        def __aiter__(self):
            async def events():
                yield {"type": "first"}
                yield {"type": "second"}

            return events()

    @asynccontextmanager
    async def create_streaming_response(**kwargs):
        yield Stream()

    monkeypatch.setattr(runtime_service, "serialize_stream_event", blocking_first)
    monkeypatch.setattr(
        runtime_service.chat_shell_model_service,
        "create_streaming_response",
        create_streaming_response,
    )

    async def collect() -> list[str]:
        return [
            frame
            async for frame in runtime_service.stream_response(
                model="model",
                input_data="hello",
            )
        ]

    loop_thread_id = threading.get_ident()
    task = asyncio.create_task(collect())
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
        assert worker_thread_ids[0] != loop_thread_id
    finally:
        release.set()

    frames = await task
    assert ['"type": "first"' in frames[0], '"type": "second"' in frames[1]] == [
        True,
        True,
    ]
