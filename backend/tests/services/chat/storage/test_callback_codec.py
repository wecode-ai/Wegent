# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

import asyncio
import json
import threading

import pytest

from app.core.bounded_executor import BoundedExecutor
from app.services.chat.storage import session as session_module


class _Event:
    def __init__(self, sequence: int) -> None:
        self.sequence = sequence

    def to_dict(self) -> dict[str, int]:
        return {"sequence": self.sequence}


class _RedisClient:
    def __init__(self) -> None:
        self.published: list[tuple[str, str]] = []

    async def publish(self, channel: str, payload: str) -> None:
        self.published.append((channel, payload))

    async def aclose(self) -> None:
        return None


class _Cache:
    def __init__(self, redis_client: _RedisClient) -> None:
        self._redis_client = redis_client

    async def _get_client(self) -> _RedisClient:
        return self._redis_client


async def _wait_until_set(event: threading.Event) -> None:
    for _ in range(200):
        if event.is_set():
            return
        await asyncio.sleep(0.005)
    pytest.fail("codec worker did not start")


def _manager(redis_client: _RedisClient) -> session_module.SessionManager:
    manager = session_module.SessionManager()
    manager._cache = _Cache(redis_client)
    return manager


@pytest.mark.asyncio
async def test_callback_serialization_does_not_block_event_loop(monkeypatch) -> None:
    monkeypatch.setattr(
        session_module,
        "_callback_codec_executor",
        BoundedExecutor(
            max_workers=1,
            max_in_flight=1,
            thread_name_prefix="test-callback-codec-loop",
        ),
    )
    codec_started = threading.Event()
    release_codec = threading.Event()
    codec_thread_ids: list[int] = []

    def blocking_serialize(event: _Event) -> str:
        codec_thread_ids.append(threading.get_ident())
        codec_started.set()
        release_codec.wait(timeout=5)
        return json.dumps(event.to_dict())

    monkeypatch.setattr(
        session_module,
        "_serialize_callback_event",
        blocking_serialize,
    )
    redis_client = _RedisClient()
    manager = _manager(redis_client)
    loop_thread_id = threading.get_ident()
    publish_task = asyncio.create_task(manager.publish_callback_event(7, _Event(1)))
    try:
        await _wait_until_set(codec_started)
        loop_progressed = asyncio.Event()
        asyncio.get_running_loop().call_soon(loop_progressed.set)
        await asyncio.wait_for(loop_progressed.wait(), timeout=0.1)
        assert not publish_task.done()
        assert codec_thread_ids[0] != loop_thread_id
    finally:
        release_codec.set()

    assert await publish_task is True
    assert redis_client.published == [("callback:channel:7", '{"sequence": 1}')]


@pytest.mark.asyncio
async def test_callback_codec_capacity_waits_without_dropping_events(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        session_module,
        "_callback_codec_executor",
        BoundedExecutor(
            max_workers=1,
            max_in_flight=1,
            thread_name_prefix="test-callback-codec-capacity",
        ),
    )
    first_started = threading.Event()
    release_first = threading.Event()
    serialized: list[int] = []

    def blocking_first(event: _Event) -> str:
        serialized.append(event.sequence)
        if event.sequence == 1:
            first_started.set()
            release_first.wait(timeout=5)
        return json.dumps(event.to_dict())

    monkeypatch.setattr(
        session_module,
        "_serialize_callback_event",
        blocking_first,
    )
    redis_client = _RedisClient()
    manager = _manager(redis_client)
    first_task = asyncio.create_task(manager.publish_callback_event(7, _Event(1)))
    await _wait_until_set(first_started)
    second_task = asyncio.create_task(manager.publish_callback_event(7, _Event(2)))
    try:
        await asyncio.sleep(0.02)
        assert serialized == [1]
        assert not second_task.done()
    finally:
        release_first.set()

    assert await asyncio.gather(first_task, second_task) == [True, True]
    assert serialized == [1, 2]
    assert [
        json.loads(payload)["sequence"] for _, payload in redis_client.published
    ] == [
        1,
        2,
    ]
