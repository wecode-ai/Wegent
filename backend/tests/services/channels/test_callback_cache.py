# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

import asyncio
import threading
from unittest.mock import AsyncMock

import pytest

from app.services.channels import callback as callback_module
from app.services.channels.callback import (
    BaseCallbackInfo,
    BaseChannelCallbackService,
    ChannelType,
)
from shared.models import ExecutionEvent


class _CallbackService(BaseChannelCallbackService[BaseCallbackInfo]):
    async def _create_emitter(self, task_id, subtask_id, callback_info):
        return None

    def _parse_callback_info(self, data):
        return BaseCallbackInfo.from_dict(data)


@pytest.mark.asyncio
async def test_missing_callback_info_is_not_queried_for_every_frame(
    monkeypatch,
) -> None:
    cache_get = AsyncMock(return_value=None)
    monkeypatch.setattr(callback_module.cache_manager, "get", cache_get)
    service = _CallbackService(ChannelType.DINGTALK)
    event = ExecutionEvent(type="chunk", task_id=1, subtask_id=2, content="x")

    assert await service.emit_event(1, 2, event) is False
    assert await service.emit_event(1, 2, event) is False

    cache_get.assert_awaited_once()


@pytest.mark.asyncio
async def test_active_emitter_skips_callback_info_redis_lookup(monkeypatch) -> None:
    cache_get = AsyncMock(side_effect=AssertionError("unexpected Redis lookup"))
    monkeypatch.setattr(callback_module.cache_manager, "get", cache_get)
    service = _CallbackService(ChannelType.DINGTALK)
    emitter = AsyncMock()
    service._active_emitters[1] = emitter
    event = ExecutionEvent(type="chunk", task_id=1, subtask_id=2, content="x")

    assert await service.emit_event(1, 2, event) is True

    emitter.emit.assert_awaited_once_with(event)
    cache_get.assert_not_awaited()


def test_callback_info_cache_has_a_hard_capacity() -> None:
    service = _CallbackService(ChannelType.DINGTALK)
    service._callback_info_cache_max_items = 2
    info = BaseCallbackInfo(ChannelType.DINGTALK, 1, "conversation")

    service._cache_callback_info(1, info, 60)
    service._cache_callback_info(2, info, 60)
    service._cache_callback_info(3, info, 60)

    assert list(service._callback_info_cache) == [2, 3]


@pytest.mark.asyncio
async def test_callback_info_serialization_runs_outside_event_loop(
    monkeypatch,
) -> None:
    cache_set = AsyncMock(return_value=True)
    monkeypatch.setattr(callback_module.cache_manager, "set", cache_set)
    service = _CallbackService(ChannelType.DINGTALK)
    info = BaseCallbackInfo(ChannelType.DINGTALK, 1, "conversation")
    loop_thread = threading.get_ident()
    worker_threads: list[int] = []
    started = threading.Event()
    release = threading.Event()

    def blocking_to_dict():
        worker_threads.append(threading.get_ident())
        started.set()
        assert release.wait(timeout=1)
        return {
            "channel_type": "dingtalk",
            "channel_id": 1,
            "conversation_id": "conversation",
        }

    monkeypatch.setattr(info, "to_dict", blocking_to_dict)
    save_task = asyncio.create_task(service.save_callback_info(1, info))
    while not started.is_set():
        await asyncio.sleep(0)
    await asyncio.sleep(0)
    release.set()
    await asyncio.wait_for(save_task, timeout=1)

    assert worker_threads == [worker_threads[0]]
    assert worker_threads[0] != loop_thread
    cache_set.assert_awaited_once()


@pytest.mark.asyncio
async def test_callback_info_parse_runs_outside_event_loop(monkeypatch) -> None:
    monkeypatch.setattr(
        callback_module.cache_manager,
        "get",
        AsyncMock(
            return_value=(
                '{"channel_type":"dingtalk","channel_id":1,'
                '"conversation_id":"conversation"}'
            )
        ),
    )
    service = _CallbackService(ChannelType.DINGTALK)
    loop_thread = threading.get_ident()
    parser_threads: list[int] = []

    def parse(data):
        parser_threads.append(threading.get_ident())
        return BaseCallbackInfo.from_dict(data)

    monkeypatch.setattr(service, "_parse_callback_info", parse)

    result = await service.get_callback_info(1)

    assert result is not None
    assert parser_threads == [parser_threads[0]]
    assert parser_threads[0] != loop_thread


@pytest.mark.asyncio
async def test_callback_info_has_a_hard_payload_limit(monkeypatch) -> None:
    cache_set = AsyncMock(return_value=True)
    monkeypatch.setattr(callback_module.cache_manager, "set", cache_set)
    service = _CallbackService(ChannelType.DINGTALK)
    info = BaseCallbackInfo(
        ChannelType.DINGTALK,
        1,
        "x" * callback_module.CALLBACK_INFO_MAX_BYTES,
    )

    with pytest.raises(ValueError, match="exceeds"):
        await service.save_callback_info(1, info)

    cache_set.assert_not_awaited()


@pytest.mark.asyncio
async def test_emitter_locks_have_fixed_process_capacity() -> None:
    service = _CallbackService(ChannelType.DINGTALK)

    for task_id in range(10_000):
        service._emitter_locks.for_task(task_id)

    loop = asyncio.get_running_loop()
    assert (
        len(service._emitter_locks._by_loop[loop])
        == callback_module.EMITTER_LOCK_STRIPES
    )


@pytest.mark.asyncio
async def test_emitter_creation_never_exceeds_active_capacity() -> None:
    service = _CallbackService(ChannelType.DINGTALK)
    service._active_emitter_max_items = 2
    callback_info = BaseCallbackInfo(ChannelType.DINGTALK, 1, "conversation")
    release_creations = asyncio.Event()
    two_creations_started = asyncio.Event()
    creation_count = 0

    async def create_emitter(task_id, subtask_id, info):
        nonlocal creation_count
        creation_count += 1
        if creation_count == 2:
            two_creations_started.set()
        await release_creations.wait()
        return AsyncMock()

    service._create_emitter = AsyncMock(side_effect=create_emitter)
    for task_id in range(10):
        service._cache_callback_info(task_id, callback_info, 60)

    tasks = [
        asyncio.create_task(service._get_or_create_emitter(task_id, 1))
        for task_id in range(10)
    ]
    await asyncio.wait_for(two_creations_started.wait(), timeout=1)
    await asyncio.sleep(0)

    assert service._create_emitter.await_count == 2
    assert len(service._emitter_reservations) == 2

    release_creations.set()
    results = await asyncio.gather(*tasks)

    assert sum(result is not None for result in results) == 2
    assert len(service._active_emitters) == 2
    assert service._emitter_reservations == set()


@pytest.mark.asyncio
async def test_external_emitter_is_not_retained_when_capacity_is_full() -> None:
    service = _CallbackService(ChannelType.DINGTALK)
    service._active_emitter_max_items = 1
    service._active_emitters[1] = AsyncMock()
    service._emitter_created_at[1] = callback_module.time.time()
    new_emitter = AsyncMock()

    await service.register_emitter(2, new_emitter)

    assert set(service._active_emitters) == {1}
    assert service._emitter_reservations == set()


@pytest.mark.asyncio
async def test_expired_emitter_cleanup_is_cadenced_and_batched(monkeypatch) -> None:
    cache_delete = AsyncMock()
    monkeypatch.setattr(callback_module.cache_manager, "delete", cache_delete)
    service = _CallbackService(ChannelType.DINGTALK)
    service._emitter_cleanup_batch_size = 2
    service._emitter_ttl = 10
    for task_id in range(5):
        service._active_emitters[task_id] = AsyncMock()
        service._emitter_created_at[task_id] = 0

    monkeypatch.setattr(callback_module.time, "time", lambda: 100)
    await service._cleanup_expired_emitters(force=True)
    assert len(service._active_emitters) == 3

    await service._cleanup_expired_emitters()
    assert len(service._active_emitters) == 3

    await service._cleanup_expired_emitters(force=True)
    assert len(service._active_emitters) == 1
    assert cache_delete.await_count == 4
