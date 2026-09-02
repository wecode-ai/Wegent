# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Event-loop boundaries for Redis streaming payload codecs."""

import asyncio
import json
import threading
from typing import Any

import pytest

from app.services.chat.storage import session_codec
from app.services.chat.storage.session import SessionManager
from tests.services.chat.storage.fake_stream_redis import FakeCache as _Cache
from tests.services.chat.storage.fake_stream_redis import (
    FakeRedisClient as _RedisClient,
)
from tests.services.chat.storage.fake_stream_redis import (
    usage_for,
)

_LARGE_TEXT = "x" * (70 * 1024)


async def _wait_for_worker(started: threading.Event) -> None:
    for _ in range(200):
        if started.is_set():
            return
        await asyncio.sleep(0.005)
    pytest.fail("payload codec worker did not start")


async def _assert_loop_ticks_while_blocked(
    started: threading.Event,
    task: asyncio.Task[Any],
) -> None:
    await _wait_for_worker(started)
    progressed = asyncio.Event()
    asyncio.get_running_loop().call_soon(progressed.set)
    await asyncio.wait_for(progressed.wait(), timeout=0.1)
    assert not task.done()


def _manager(redis_client: _RedisClient) -> SessionManager:
    manager = SessionManager()
    manager._cache = _Cache(redis_client)
    return manager


@pytest.mark.asyncio
async def test_large_streaming_content_decode_does_not_block_loop(monkeypatch) -> None:
    started = threading.Event()
    release = threading.Event()
    original = session_codec.decode_redis_text

    def blocking_decode(value: Any) -> str:
        started.set()
        release.wait(timeout=5)
        return original(value)

    monkeypatch.setattr(session_codec, "decode_redis_text", blocking_decode)
    redis_client = _RedisClient(values={"chat:streaming:7": _LARGE_TEXT.encode()})
    task = asyncio.create_task(_manager(redis_client).get_streaming_content(7))
    try:
        await _assert_loop_ticks_while_blocked(started, task)
    finally:
        release.set()

    assert await task == _LARGE_TEXT


@pytest.mark.asyncio
async def test_stream_done_serialization_backpressures_before_publish(
    monkeypatch,
) -> None:
    started = threading.Event()
    release = threading.Event()
    original = session_codec.serialize_stream_done

    def blocking_serialize(result: Any) -> str:
        started.set()
        release.wait(timeout=5)
        return original(result)

    monkeypatch.setattr(session_codec, "serialize_stream_done", blocking_serialize)
    redis_client = _RedisClient()
    task = asyncio.create_task(
        _manager(redis_client).publish_streaming_done(8, {"value": _LARGE_TEXT})
    )
    try:
        await _assert_loop_ticks_while_blocked(started, task)
        assert redis_client.published == []
    finally:
        release.set()

    assert await task is True
    assert json.loads(redis_client.published[0][1])["result"]["value"] == _LARGE_TEXT


@pytest.mark.asyncio
async def test_large_block_list_decode_does_not_block_loop(monkeypatch) -> None:
    started = threading.Event()
    release = threading.Event()
    original = session_codec.decode_block_metadata

    def blocking_decode(blocks_raw: list[Any], content_key_field: str):
        started.set()
        release.wait(timeout=5)
        return original(blocks_raw, content_key_field)

    monkeypatch.setattr(session_codec, "decode_block_metadata", blocking_decode)
    blocks_key = "chat:streaming:blocks:9"
    blocks = [json.dumps({"id": "text-1", "type": "text", "content": _LARGE_TEXT})]
    redis_client = _RedisClient(
        lists={blocks_key: blocks},
        hashes={"chat:streaming:blocks_usage:9": usage_for(blocks)},
    )
    task = asyncio.create_task(_manager(redis_client).get_blocks(9))
    try:
        await _assert_loop_ticks_while_blocked(started, task)
    finally:
        release.set()

    assert (await task)[0]["content"] == _LARGE_TEXT


@pytest.mark.asyncio
async def test_large_block_content_hydration_does_not_block_loop(monkeypatch) -> None:
    started = threading.Event()
    release = threading.Event()
    original = session_codec.hydrate_block_content

    def blocking_hydrate(*args: Any):
        started.set()
        release.wait(timeout=5)
        return original(*args)

    monkeypatch.setattr(session_codec, "hydrate_block_content", blocking_hydrate)
    blocks_key = "chat:streaming:blocks:13"
    content_key = "chat:streaming:block_content:13:text-1"
    blocks = [
        json.dumps(
            {
                "id": "text-1",
                "type": "text",
                "content": "",
                "_content_key": content_key,
            }
        )
    ]
    redis_client = _RedisClient(
        values={content_key: _LARGE_TEXT.encode()},
        lists={blocks_key: blocks},
        hashes={
            "chat:streaming:blocks_usage:13": usage_for(
                blocks,
                content_bytes=len(_LARGE_TEXT.encode()),
            )
        },
    )
    task = asyncio.create_task(_manager(redis_client).get_blocks(13))
    try:
        await _assert_loop_ticks_while_blocked(started, task)
    finally:
        release.set()

    assert (await task)[0]["content"] == _LARGE_TEXT


@pytest.mark.asyncio
async def test_large_block_upsert_serialization_precedes_redis_write(
    monkeypatch,
) -> None:
    started = threading.Event()
    release = threading.Event()
    original = session_codec.prepare_block_upsert

    def blocking_prepare(*args: Any):
        started.set()
        release.wait(timeout=5)
        return original(*args)

    monkeypatch.setattr(session_codec, "prepare_block_upsert", blocking_prepare)
    redis_client = _RedisClient()
    task = asyncio.create_task(
        _manager(redis_client).add_block(
            10,
            {"id": "tool-1", "type": "tool", "tool_output": _LARGE_TEXT},
        )
    )
    try:
        await _assert_loop_ticks_while_blocked(started, task)
        assert redis_client.pipeline_commands == []
    finally:
        release.set()

    await task
    assert redis_client.pipeline_commands[0][0] == "rpush"


@pytest.mark.asyncio
async def test_large_current_block_finalize_precedes_redis_write(monkeypatch) -> None:
    started = threading.Event()
    release = threading.Event()
    original = session_codec.finalize_block

    def blocking_finalize(*args: Any):
        started.set()
        release.wait(timeout=5)
        return original(*args)

    monkeypatch.setattr(session_codec, "finalize_block", blocking_finalize)
    blocks_key = "chat:streaming:blocks:14"
    text_block_key = "chat:streaming:text_block:14"
    blocks = [json.dumps({"id": "text-1", "type": "text", "content": _LARGE_TEXT})]
    redis_client = _RedisClient(
        values={text_block_key: b"text-1"},
        lists={blocks_key: blocks},
        hashes={"chat:streaming:blocks_usage:14": usage_for(blocks)},
    )
    task = asyncio.create_task(_manager(redis_client)._finalize_current_text_block(14))
    try:
        await _assert_loop_ticks_while_blocked(started, task)
        assert redis_client.pipeline_commands == []
    finally:
        release.set()

    await task
    assert redis_client.pipeline_commands[0][0] == "lset"


@pytest.mark.asyncio
async def test_large_terminal_block_scan_does_not_block_loop(monkeypatch) -> None:
    started = threading.Event()
    release = threading.Event()
    original = SessionManager._finalize_unresolved_preview_tool_blocks

    def blocking_finalize(self: SessionManager, *args: Any):
        started.set()
        release.wait(timeout=5)
        return original(self, *args)

    monkeypatch.setattr(
        SessionManager,
        "_finalize_unresolved_preview_tool_blocks",
        blocking_finalize,
    )
    blocks_key = "chat:streaming:blocks:12"
    blocks = [
        json.dumps(
            {
                "id": "tool-1",
                "type": "tool",
                "status": "pending",
                "tool_input": {"value": _LARGE_TEXT},
            }
        )
    ]
    redis_client = _RedisClient(
        lists={blocks_key: blocks},
        hashes={"chat:streaming:blocks_usage:12": usage_for(blocks)},
    )
    task = asyncio.create_task(
        _manager(redis_client).finalize_and_get_blocks(
            12,
            terminal_status="COMPLETED",
        )
    )
    try:
        await _assert_loop_ticks_while_blocked(started, task)
    finally:
        release.set()

    assert (await task)[0]["status"] == "done"


@pytest.mark.asyncio
async def test_cleanup_block_scan_does_not_block_loop(monkeypatch) -> None:
    started = threading.Event()
    release = threading.Event()
    original = session_codec.decode_block_metadata

    def blocking_decode(*args: Any):
        started.set()
        release.wait(timeout=5)
        return original(*args)

    monkeypatch.setattr(session_codec, "decode_block_metadata", blocking_decode)
    content_key = "chat:streaming:block_content:11:text-1"
    blocks_key = "chat:streaming:blocks:11"
    blocks = [
        json.dumps(
            {
                "id": "text-1",
                "type": "text",
                "content": _LARGE_TEXT,
                "_content_key": content_key,
            }
        )
    ]
    redis_client = _RedisClient(
        lists={blocks_key: blocks},
        hashes={"chat:streaming:blocks_usage:11": usage_for(blocks)},
    )
    task = asyncio.create_task(_manager(redis_client).cleanup_streaming_state(11))
    try:
        await _assert_loop_ticks_while_blocked(started, task)
        assert redis_client.deleted == []
    finally:
        release.set()

    await task
    assert content_key in redis_client.deleted[0]
