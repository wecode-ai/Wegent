"""Regression tests for slow card delivery and authoritative completion."""

import asyncio
import threading
import time
from unittest.mock import AsyncMock

import pytest

from app.services.channels.dingtalk import emitter as emitter_module
from app.services.channels.dingtalk.emitter import StreamingResponseEmitter
from shared.models import EventType, ExecutionEvent
from tests.services.channels.dingtalk.test_emitter import FakeCache, card_factory


def block_update(card, loop, content):
    started = asyncio.Event()
    release = threading.Event()
    original = card.ai_streaming

    def streaming(value, append=False):
        if value == content:
            loop.call_soon_threadsafe(started.set)
            if not release.wait(5):
                raise AssertionError("test did not release blocked card request")
        original(value, append=append)

    card.ai_streaming = streaming
    return started, release


@pytest.mark.asyncio
async def test_slow_card_does_not_block_ingestion_and_done_replaces_pending(
    card_factory,
):
    emitter = StreamingResponseEmitter(object(), object())
    emitter.MIN_UPDATE_INTERVAL = 0
    await emitter.emit_start(1, 2)
    card = card_factory[0]
    started, release = block_update(card, asyncio.get_running_loop(), "first")
    try:
        await emitter.emit_chunk(1, 2, "first", 0)
        await asyncio.wait_for(started.wait(), 1)

        async def consume_remaining():
            for offset in range(100):
                await emitter.emit_chunk(1, 2, "pending", offset)

        await asyncio.wait_for(consume_remaining(), 1)
        done = asyncio.create_task(emitter.emit_done(1, 2, {"value": "final"}))
        await asyncio.sleep(0)
        assert not done.done()
        release.set()
        await asyncio.wait_for(done, 2)
        await emitter.emit_chunk(1, 2, "late", 100)
        await emitter.emit_done(1, 2, {"value": "duplicate"})

        assert card.updates[1:] == ["first", "final"]
        assert card.finished == ["final"]
        assert emitter._flush_task is None
    finally:
        release.set()
        await emitter.close()


@pytest.mark.asyncio
async def test_burst_is_persisted_and_sent_once(monkeypatch, card_factory):
    cache = FakeCache()
    cache.get = AsyncMock(wraps=cache.get)
    cache.set = AsyncMock(wraps=cache.set)
    monkeypatch.setattr(emitter_module, "cache_manager", cache)
    emitter = StreamingResponseEmitter(object(), object())
    emitter.set_shared_content_key("card-burst")
    emitter.MIN_UPDATE_INTERVAL = 3600
    await emitter.emit_start(1, 2)
    before = (cache.get.await_count, cache.set.await_count)
    for offset in range(100):
        await emitter.emit_chunk(1, 2, "文", offset)
    assert (cache.get.await_count, cache.set.await_count) == before
    await emitter.flush()
    assert card_factory[0].updates[1:] == ["文" * 100]
    assert cache.raw["card-burst:card-1"] == ("文" * 100).encode()
    await emitter.close()


@pytest.mark.asyncio
async def test_default_window_coalesces_chunks_without_early_card_updates(card_factory):
    emitter = StreamingResponseEmitter(object(), object(), "card-1")
    await emitter.emit_start(1, 2)
    card = card_factory[0]
    loop = asyncio.get_running_loop()
    first_sent, second_sent = asyncio.Event(), asyncio.Event()
    sent_at = []
    original = card.ai_streaming

    def streaming(content, append=False):
        original(content, append=append)
        sent_at.append(time.monotonic())
        event = first_sent if len(sent_at) == 1 else second_sent
        loop.call_soon_threadsafe(event.set)

    card.ai_streaming = streaming
    try:
        await emitter.emit_chunk(1, 2, "first", 0)
        await asyncio.wait_for(first_sent.wait(), timeout=5)
        for offset in range(100):
            await emitter.emit_chunk(1, 2, "文", offset)
        await asyncio.wait_for(second_sent.wait(), timeout=5)
        assert card.updates == ["first", "first" + "文" * 100]
        assert sent_at[1] - sent_at[0] >= 0.5
    finally:
        await emitter.close()


@pytest.mark.asyncio
async def test_cancel_keeps_unflushed_answer(card_factory):
    emitter = StreamingResponseEmitter(object(), object())
    emitter.MIN_UPDATE_INTERVAL = 3600
    await emitter.emit_start(1, 2)
    await emitter.emit_chunk(1, 2, "已生成的内容", 0)
    await emitter.emit_cancelled(1, 2)
    assert card_factory[0].finished == ["已生成的内容\n\n⚠️ 任务已取消"]
    assert emitter._flush_task is None


@pytest.mark.asyncio
async def test_terminal_on_reconstructed_worker_fences_old_pending_updates(
    monkeypatch, card_factory
):
    cache = FakeCache()
    monkeypatch.setattr(emitter_module, "cache_manager", cache)
    first = StreamingResponseEmitter(object(), object())
    first.set_shared_content_key("shared-card")
    first.MIN_UPDATE_INTERVAL = 0
    await first.emit_start(1, 2)
    started, release = block_update(
        card_factory[0], asyncio.get_running_loop(), "first"
    )
    second = StreamingResponseEmitter(object(), object(), "card-1")
    second.set_shared_content_key("shared-card")
    try:
        await first.emit_chunk(1, 2, "first", 0)
        await asyncio.wait_for(started.wait(), 1)
        await first.emit_chunk(1, 2, "pending", 1)
        done = asyncio.create_task(second.emit_done(1, 2, {"value": "final"}))
        await asyncio.sleep(0)
        assert not done.done()
        release.set()
        await asyncio.wait_for(done, 2)
        await first.flush()
        assert card_factory[0].updates[1:] == ["first"]
        assert card_factory[1].finished == ["final"]

        recovered = StreamingResponseEmitter(object(), object(), "card-1")
        recovered.set_shared_content_key("shared-card")
        await recovered.emit_done(1, 2, {"value": "duplicate"})
        assert card_factory[2].updates == []
        assert card_factory[2].finished == []
    finally:
        release.set()
        await first.close()
        await second.close()


@pytest.mark.asyncio
async def test_next_turn_card_is_not_blocked_by_previous_terminal(
    monkeypatch, card_factory
):
    cache = FakeCache()
    monkeypatch.setattr(emitter_module, "cache_manager", cache)
    first = StreamingResponseEmitter(object(), object(), "card-1")
    first.set_shared_content_key("same-task")
    await first.emit_done(1, 2, {"value": "first"})
    second = StreamingResponseEmitter(object(), object(), "card-2")
    second.set_shared_content_key("same-task")
    await second.emit_done(1, 3, {"value": "second"})
    assert card_factory[1].finished == ["second"]


@pytest.mark.asyncio
async def test_resident_workers_merge_progress_from_the_latest_shared_state(
    monkeypatch, card_factory
):
    cache = FakeCache()
    monkeypatch.setattr(emitter_module, "cache_manager", cache)
    workers = [StreamingResponseEmitter(object(), object(), "card-1") for _ in range(2)]
    for worker in workers:
        worker.set_shared_content_key("shared-progress")
        await worker.emit_start(1, 2)
    for worker, tool in zip(workers, ("Read", "Bash")):
        await worker.emit(
            ExecutionEvent.create(
                EventType.TOOL_RESULT,
                task_id=1,
                subtask_id=2,
                tool_name=tool,
                data={"status": "completed"},
            )
        )
        await worker.flush()
    assert cache.structured["shared-progress:card-1:progress"]["recent"] == [
        "工具完成：Read",
        "工具完成：Bash",
    ]
    for worker in workers:
        await worker.close()
