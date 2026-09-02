# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

import asyncio
import json
import threading
from unittest.mock import AsyncMock

import pytest

from app.services.simple_chat import service as simple_chat_module
from app.services.simple_chat.providers import base as provider_base
from app.services.simple_chat.providers.base import (
    ChunkType,
    LLMProvider,
    ProviderConfig,
    StreamChunk,
)


@pytest.mark.asyncio
async def test_simple_chat_preparation_is_nonblocking_and_frames_stay_ordered(
    monkeypatch,
) -> None:
    started = threading.Event()
    release = threading.Event()
    worker_thread_ids: list[int] = []

    class Provider:
        async def stream_chat(self, messages, cancel_event):
            yield StreamChunk(type=ChunkType.CONTENT, content="first")
            yield StreamChunk(type=ChunkType.CONTENT, content="second")

    def blocking_prepare(*args):
        worker_thread_ids.append(threading.get_ident())
        started.set()
        release.wait(timeout=5)
        return ([{"role": "user", "content": "hello"}], Provider())

    monkeypatch.setattr(simple_chat_module, "_prepare_chat_request", blocking_prepare)
    monkeypatch.setattr(
        simple_chat_module,
        "get_http_client",
        AsyncMock(return_value=object()),
    )
    service = simple_chat_module.SimpleChatService()
    response = await service.chat_stream(
        message="hello",
        model_config={"model": "openai"},
        system_prompt="system",
    )

    async def collect() -> list[str]:
        return [chunk async for chunk in response.body_iterator]

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
    payloads = [json.loads(frame.removeprefix("data: ")) for frame in frames]
    assert [payload.get("content") for payload in payloads] == [
        "first",
        "second",
        "",
    ]


@pytest.mark.asyncio
async def test_provider_sse_decode_is_nonblocking_and_ordered(monkeypatch) -> None:
    started = threading.Event()
    release = threading.Event()
    worker_thread_ids: list[int] = []
    original = provider_base._decode_sse_json

    def blocking_first(data):
        worker_thread_ids.append(threading.get_ident())
        if not started.is_set():
            started.set()
            release.wait(timeout=5)
        return original(data)

    class Response:
        status_code = 200

        def raise_for_status(self):
            return None

        async def aiter_lines(self):
            yield 'data: {"sequence":1}'
            yield 'data: {"sequence":2}'
            yield "data: [DONE]"

    class StreamContext:
        async def __aenter__(self):
            return Response()

        async def __aexit__(self, exc_type, exc, traceback):
            return None

    class Client:
        def stream(self, *args, **kwargs):
            return StreamContext()

    class Provider(LLMProvider):
        @property
        def provider_name(self):
            return "test"

        async def stream_chat(self, messages, cancel_event):
            if False:
                yield None

        def format_messages(self, messages):
            return messages

    monkeypatch.setattr(provider_base, "_decode_sse_json", blocking_first)
    provider = Provider(
        ProviderConfig(api_key="", base_url="", model_id="model"),
        Client(),
    )

    async def collect():
        return [
            event
            async for event in provider._stream_sse(
                "https://example.com",
                {"input": "hello"},
                {"Content-Type": "application/json"},
                asyncio.Event(),
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

    assert await task == [{"sequence": 1}, {"sequence": 2}]
