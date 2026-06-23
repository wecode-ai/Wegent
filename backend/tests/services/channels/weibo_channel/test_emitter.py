# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock

import pytest

from app.services.channels.weibo.emitter import WeiboStreamingResponseEmitter


class FakeCache:
    def __init__(self):
        self.redis = FakeRedis()

    async def _get_client(self):
        return self.redis


class FakeRedis:
    def __init__(self):
        self.values = {}

    async def incr(self, key):
        self.values[key] = self.values.get(key, 0) + 1
        return self.values[key]

    async def expire(self, key, seconds):
        return True

    async def aclose(self):
        return None


@pytest.mark.asyncio
async def test_emit_chunk_sends_incrementing_chunk_ids():
    sender = AsyncMock()
    cache = FakeCache()
    emitter = WeiboStreamingResponseEmitter(
        channel_id=7,
        to_user_id="10001",
        sender=sender,
        cache=cache,
    )

    await emitter.emit_start(task_id=11, subtask_id=13)
    await emitter.emit_chunk(task_id=11, subtask_id=13, content="hello", offset=0)
    await emitter.emit_chunk(task_id=11, subtask_id=13, content=" world", offset=5)

    assert sender.send_stream_chunk.await_args_list[0].kwargs["message_id"] == (
        "weibo_7_11_13"
    )
    assert sender.send_stream_chunk.await_args_list[0].kwargs["chunk_id"] == 0
    assert sender.send_stream_chunk.await_args_list[0].kwargs["done"] is False
    assert sender.send_stream_chunk.await_args_list[1].kwargs["chunk_id"] == 1


@pytest.mark.asyncio
async def test_emit_done_sends_empty_done_marker_when_no_tail():
    sender = AsyncMock()
    cache = FakeCache()
    emitter = WeiboStreamingResponseEmitter(
        channel_id=7,
        to_user_id="10001",
        sender=sender,
        cache=cache,
    )

    await emitter.emit_start(task_id=11, subtask_id=13)
    await emitter.emit_chunk(task_id=11, subtask_id=13, content="hello", offset=0)
    await emitter.emit_done(task_id=11, subtask_id=13, result={"value": "hello"})

    assert sender.send_stream_chunk.await_args_list[-1].kwargs == {
        "to_user_id": "10001",
        "text": "",
        "message_id": "weibo_7_11_13",
        "chunk_id": 1,
        "done": True,
    }


@pytest.mark.asyncio
async def test_emit_done_sends_unsent_tail_from_final_result():
    sender = AsyncMock()
    cache = FakeCache()
    emitter = WeiboStreamingResponseEmitter(
        channel_id=7,
        to_user_id="10001",
        sender=sender,
        cache=cache,
    )

    await emitter.emit_start(task_id=11, subtask_id=13)
    await emitter.emit_chunk(task_id=11, subtask_id=13, content="hello", offset=0)
    await emitter.emit_done(task_id=11, subtask_id=13, result={"value": "hello world"})

    assert sender.send_stream_chunk.await_args_list[-1].kwargs["text"] == " world"
    assert sender.send_stream_chunk.await_args_list[-1].kwargs["done"] is True
