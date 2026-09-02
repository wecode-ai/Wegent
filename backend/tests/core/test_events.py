# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""EventBus event-loop isolation tests."""

import asyncio
import threading
from dataclasses import dataclass

import pytest

from app.core import events as events_module
from app.core.events import EventBus
from app.core.web_background_tasks import (
    WebBackgroundTaskCapacityError,
    WebBackgroundTaskManager,
)


@dataclass
class _TestEvent:
    value: str


@pytest.mark.asyncio
async def test_sync_handler_runs_outside_event_loop_thread() -> None:
    bus = EventBus()
    event_loop_thread = threading.get_ident()
    handler_threads: list[int] = []

    def handle(event: _TestEvent) -> None:
        assert event.value == "complete"
        handler_threads.append(threading.get_ident())

    bus.subscribe(_TestEvent, handle)

    await bus.publish(_TestEvent(value="complete"))

    assert handler_threads
    assert handler_threads[0] != event_loop_thread


@pytest.mark.asyncio
async def test_sync_wrapper_returning_coroutine_is_awaited_on_event_loop() -> None:
    bus = EventBus()
    handled = asyncio.Event()

    def handle(event: _TestEvent):
        async def finish() -> None:
            assert event.value == "complete"
            handled.set()

        return finish()

    bus.subscribe(_TestEvent, handle)

    await bus.publish(_TestEvent(value="complete"))

    assert handled.is_set()


@pytest.mark.asyncio
async def test_cross_loop_publish_waits_for_main_loop_handlers() -> None:
    bus = EventBus()
    bus._main_loop = asyncio.get_running_loop()
    handler_started = asyncio.Event()
    release_handler = asyncio.Event()
    thread_finished = threading.Event()

    async def handle(event: _TestEvent) -> None:
        assert event.value == "cross-loop"
        handler_started.set()
        await release_handler.wait()

    bus.subscribe(_TestEvent, handle)

    def publish_from_thread() -> None:
        asyncio.run(bus.publish(_TestEvent(value="cross-loop")))
        thread_finished.set()

    publisher = threading.Thread(target=publish_from_thread, daemon=True)
    publisher.start()
    await asyncio.wait_for(handler_started.wait(), timeout=1)
    assert not thread_finished.is_set()

    release_handler.set()
    for _ in range(200):
        if thread_finished.is_set():
            break
        await asyncio.sleep(0.005)
    else:
        pytest.fail("cross-loop publisher did not receive handler completion")
    publisher.join(timeout=1)


@pytest.mark.asyncio
async def test_sync_publish_uses_web_owner_and_rejects_at_global_capacity(
    monkeypatch,
) -> None:
    owner = WebBackgroundTaskManager(max_concurrency=1, max_outstanding=1)
    owner.start()
    monkeypatch.setattr(events_module, "web_background_task_manager", owner)
    bus = EventBus()
    bus._main_loop = asyncio.get_running_loop()
    handler_started = asyncio.Event()
    release_handler = asyncio.Event()

    async def handle(event: _TestEvent) -> None:
        assert event.value == "first"
        handler_started.set()
        await release_handler.wait()

    bus.subscribe(_TestEvent, handle)
    bus.publish_sync(_TestEvent(value="first"))
    await asyncio.wait_for(handler_started.wait(), timeout=1)

    with pytest.raises(WebBackgroundTaskCapacityError):
        bus.publish_sync(_TestEvent(value="second"))

    release_handler.set()
    await owner.drain()


@pytest.mark.asyncio
async def test_handler_failure_propagates_to_async_publisher() -> None:
    bus = EventBus()

    async def fail(event: _TestEvent) -> None:
        raise ValueError(event.value)

    bus.subscribe(_TestEvent, fail)

    with pytest.raises(ValueError, match="broken"):
        await bus.publish(_TestEvent(value="broken"))
