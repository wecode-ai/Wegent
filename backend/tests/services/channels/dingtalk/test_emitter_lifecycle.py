"""Boundary tests for buffered card updates and terminal delivery."""

import asyncio
from unittest.mock import AsyncMock, Mock

import pytest

from app.services.channels.dingtalk import emitter as emitter_module
from app.services.channels.dingtalk.emitter import StreamingResponseEmitter
from shared.models import EventType, ExecutionEvent
from tests.services.channels.dingtalk.test_emitter import FakeCache, card_factory
from tests.services.channels.dingtalk.test_streaming_backpressure import block_update
from tests.services.channels.test_terminal_result_delivery import FakeCallbackService


@pytest.mark.asyncio
async def test_missing_shared_progress_preserves_local_projection(
    monkeypatch, card_factory
):
    cache = FakeCache()
    monkeypatch.setattr(emitter_module, "cache_manager", cache)
    emitter = StreamingResponseEmitter(object(), object(), "card-1")
    emitter.set_shared_content_key("shared-card")
    emitter.MIN_UPDATE_INTERVAL = 0
    await emitter.emit_start(1, 2)
    await emitter.emit(
        ExecutionEvent.create(
            EventType.TOOL_RESULT,
            task_id=1,
            subtask_id=2,
            tool_name="Read",
            data={"status": "completed"},
        )
    )
    await emitter.flush()
    del cache.structured[emitter._progress_state_key]
    await emitter.emit_thinking(1, 2, "检查配置", is_reasoning_summary=True)
    await emitter.flush()

    state = cache.structured[emitter._progress_state_key]
    assert state["recent"] == ["工具完成：Read"]
    assert card_factory[0].updates[-1].count("检查配置") == 1
    await emitter.close()


@pytest.mark.asyncio
async def test_cancellation_remains_visible_when_answer_is_truncated(card_factory):
    emitter = StreamingResponseEmitter(object(), object())
    emitter.MIN_UPDATE_INTERVAL = 3600
    await emitter.emit_start(1, 2)
    await emitter.emit_chunk(1, 2, "长文本" * 2000, 0)
    await emitter.emit_cancelled(1, 2)
    content = card_factory[0].finished[0]
    assert len(content) <= emitter.MAX_FINAL_CONTENT_LENGTH
    assert content.endswith("⚠️ 任务已取消")
    assert emitter.FINAL_TRUNCATION_SUFFIX in content


@pytest.mark.asyncio
async def test_callback_keeps_registration_and_recoverable_state_on_failure(
    monkeypatch, card_factory
):
    cache = FakeCache()
    monkeypatch.setattr(emitter_module, "cache_manager", cache)
    monkeypatch.setattr("app.services.channels.callback.cache_manager", cache)
    emitter = StreamingResponseEmitter(object(), object(), "card-1")
    emitter.set_shared_content_key("channel:streaming_content:1")
    emitter.MIN_UPDATE_INTERVAL = 3600
    await emitter.emit_start(1, 2)
    await emitter.emit_chunk(1, 2, "buffered", 0)
    card_factory[0].ai_finish = Mock(side_effect=RuntimeError("delivery failed"))
    service = FakeCallbackService(emitter)
    service._active_emitters[1] = emitter
    service.get_callback_info = AsyncMock(return_value=object())
    service.delete_callback_info = AsyncMock()

    sent = await service.send_task_result(1, 2, content="")

    assert sent is False
    service.delete_callback_info.assert_not_awaited()
    assert emitter._closed
    assert cache.raw["channel:streaming_content:1:card-1"] == b"buffered"


@pytest.mark.asyncio
@pytest.mark.parametrize("event", ["chunk", "thinking"])
async def test_close_rejects_event_that_was_waiting_for_initialization(
    card_factory, event
):
    emitter = StreamingResponseEmitter(object(), object())
    await emitter.emit_start(1, 2)
    entered, release = asyncio.Event(), asyncio.Event()

    async def initialize():
        entered.set()
        await release.wait()
        return True

    emitter._initialize = initialize
    emit = (
        emitter.emit_chunk(1, 2, "late", 0)
        if event == "chunk"
        else emitter.emit_thinking(1, 2)
    )
    pending = asyncio.create_task(emit)
    await entered.wait()
    await emitter.close()
    release.set()
    await pending
    assert emitter._pending_content == ""
    assert emitter._pending_progress == []
    assert emitter._flush_task is None


@pytest.mark.asyncio
async def test_failed_terminal_preserves_answer_for_retry(monkeypatch, card_factory):
    cache = FakeCache()
    monkeypatch.setattr(emitter_module, "cache_manager", cache)
    emitter = StreamingResponseEmitter(object(), object())
    emitter.set_shared_content_key("shared-card")
    emitter.MIN_UPDATE_INTERVAL = 3600
    await emitter.emit_start(1, 2)
    await emitter.emit_chunk(1, 2, "buffered", 0)
    card = card_factory[0]
    finish = card.ai_finish
    card.ai_finish = Mock(side_effect=RuntimeError("delivery failed"))

    with pytest.raises(RuntimeError, match="delivery failed"):
        await emitter.emit_done(1, 2)
    assert not emitter._finished
    assert await emitter._current_answer() == "buffered"
    assert await cache.get(emitter._progress_state_key) is not None

    card.ai_finish = finish
    await emitter.emit_done(1, 2)
    assert card.finished == ["buffered"]


@pytest.mark.asyncio
async def test_close_preserves_flushed_state_for_reconstructed_worker(
    monkeypatch, card_factory
):
    cache = FakeCache()
    monkeypatch.setattr(emitter_module, "cache_manager", cache)
    first = StreamingResponseEmitter(object(), object(), "card-1")
    first.set_shared_content_key("shared-card")
    await first.emit_start(1, 2)
    await first.emit_chunk(1, 2, "kept for recovery", 0)
    await first.close()

    second = StreamingResponseEmitter(object(), object(), "card-1")
    second.set_shared_content_key("shared-card")
    await second.emit_done(1, 2)
    assert card_factory[1].finished == ["kept for recovery"]


@pytest.mark.asyncio
async def test_old_card_completion_does_not_clear_next_turn_state(
    monkeypatch, card_factory
):
    cache = FakeCache()
    monkeypatch.setattr(emitter_module, "cache_manager", cache)
    first = StreamingResponseEmitter(object(), object(), "card-1")
    second = StreamingResponseEmitter(object(), object(), "card-2")
    for worker in (first, second):
        worker.set_shared_content_key("same-task")
        await worker.emit_start(1, 2)
    await second.emit_chunk(1, 3, "next turn", 0)
    await second.flush()
    await first.emit_done(1, 2, {"value": "old turn"})
    await second.emit_done(1, 3)
    assert card_factory[1].finished == ["next turn"]


@pytest.mark.asyncio
async def test_terminal_marker_failure_is_not_reported_as_success(
    monkeypatch, card_factory
):
    cache = FakeCache()
    monkeypatch.setattr(emitter_module, "cache_manager", cache)
    emitter = StreamingResponseEmitter(object(), object(), "card-1")
    emitter.set_shared_content_key("shared-card")
    await emitter.emit_start(1, 2)
    cache.set = AsyncMock(return_value=False)
    with pytest.raises(RuntimeError, match="terminal"):
        await emitter.emit_done(1, 2, {"value": "final"})
    assert not emitter._finished
    assert await cache.get(emitter._progress_state_key) is not None


@pytest.mark.asyncio
@pytest.mark.parametrize("persisted", [False, True])
async def test_ambiguous_persistence_requires_authoritative_completion(
    monkeypatch, card_factory, persisted
):
    cache = FakeCache()
    monkeypatch.setattr(emitter_module, "cache_manager", cache)
    emitter = StreamingResponseEmitter(object(), object(), "card-1")
    emitter.set_shared_content_key("shared-card")
    await emitter.emit_start(1, 2)
    append = emitter._redis_append_answer

    async def fail(content):
        if persisted:
            await append(content)
        raise TimeoutError("ambiguous Redis write")

    emitter._redis_append_answer = fail
    await emitter.emit_chunk(1, 2, "partial", 0)
    await emitter.flush()
    with pytest.raises(RuntimeError, match="persist"):
        await emitter.emit_done(1, 2)
    assert card_factory[0].finished == []
    await emitter.emit_done(1, 2, {"value": "authoritative answer"})
    assert card_factory[0].finished == ["authoritative answer"]


@pytest.mark.asyncio
async def test_repeated_cancellation_keeps_lock_until_sdk_request_finishes(
    card_factory,
):
    emitter = StreamingResponseEmitter(object(), object())
    await emitter.emit_start(1, 2)
    card = card_factory[0]
    started, release = block_update(card, asyncio.get_running_loop(), "in flight")

    async def write():
        async with emitter._update_lock:
            await emitter._call_card("ai_streaming", "in flight", append=False)

    pending = asyncio.create_task(write())
    terminal = None
    try:
        await asyncio.wait_for(started.wait(), 1)
        pending.cancel()
        await asyncio.sleep(0)
        pending.cancel()
        await asyncio.sleep(0)
        assert not pending.done()
        terminal = asyncio.create_task(emitter.emit_done(1, 2, {"value": "final"}))
        await asyncio.sleep(0)
        assert not terminal.done()
        release.set()
        results = await asyncio.gather(pending, terminal, return_exceptions=True)
        assert isinstance(results[0], asyncio.CancelledError)
        assert results[1] is None
        assert card.updates[1:] == ["in flight", "final"]
    finally:
        release.set()
        await asyncio.gather(
            *(task for task in (pending, terminal) if task), return_exceptions=True
        )
        await emitter.close()


@pytest.mark.asyncio
async def test_lost_writer_lease_stops_remaining_terminal_requests(
    monkeypatch, card_factory
):
    cache = FakeCache()
    monkeypatch.setattr(emitter_module, "cache_manager", cache)
    emitter = StreamingResponseEmitter(object(), object(), "card-1")
    emitter.set_shared_content_key("shared-card")
    await emitter.emit_start(1, 2)
    lost, renewal_failed = asyncio.Event(), asyncio.Event()

    async def renew(_lock):
        await lost.wait()
        renewal_failed.set()
        raise RuntimeError("writer lease lost")

    emitter._renew_writer_lock = renew
    card = card_factory[0]
    started, release = block_update(card, asyncio.get_running_loop(), "final")
    terminal = asyncio.create_task(emitter.emit_done(1, 2, {"value": "final"}))
    try:
        await asyncio.wait_for(started.wait(), 1)
        lost.set()
        await renewal_failed.wait()
        release.set()
        with pytest.raises(RuntimeError, match="writer lease lost"):
            await terminal
        assert card.finished == []
        assert not emitter._finished
        assert await cache.get(emitter._terminal_key) is None
    finally:
        release.set()
        await asyncio.gather(terminal, return_exceptions=True)
        await emitter.close()
