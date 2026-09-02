# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Runtime invariants for bounded Web-owned detached work."""

import asyncio
import gc

import pytest

from app.core.web_background_tasks import (
    WebBackgroundTaskAdmissionClosed,
    WebBackgroundTaskCapacityError,
    WebBackgroundTaskManager,
)


def test_capacity_configuration_must_be_finite_and_consistent() -> None:
    with pytest.raises(ValueError, match="max_concurrency"):
        WebBackgroundTaskManager(max_concurrency=0, max_outstanding=1)
    with pytest.raises(ValueError, match="max_outstanding"):
        WebBackgroundTaskManager(max_concurrency=2, max_outstanding=1)


@pytest.mark.asyncio
async def test_async_submission_backpressures_at_outstanding_limit() -> None:
    manager = WebBackgroundTaskManager(max_concurrency=1, max_outstanding=2)
    manager.start()
    release = asyncio.Event()
    first_started = asyncio.Event()
    active = 0
    max_active = 0

    async def work(started: asyncio.Event | None = None) -> None:
        nonlocal active, max_active
        active += 1
        max_active = max(max_active, active)
        if started is not None:
            started.set()
        try:
            await release.wait()
        finally:
            active -= 1

    await manager.submit(lambda: work(first_started), name="first")
    await manager.submit(work, name="second")
    await asyncio.wait_for(first_started.wait(), timeout=0.1)

    third_submission = asyncio.create_task(manager.submit(work, name="third"))
    await asyncio.sleep(0)

    assert manager.active_count == 1
    assert manager.outstanding_count == 2
    assert not third_submission.done()

    release.set()
    await asyncio.wait_for(third_submission, timeout=0.1)
    await asyncio.wait_for(manager.drain(), timeout=0.1)

    assert max_active == 1
    assert manager.outstanding_count == 0


@pytest.mark.asyncio
async def test_manager_strongly_owns_task_until_completion() -> None:
    manager = WebBackgroundTaskManager(max_concurrency=1, max_outstanding=1)
    manager.start()
    started = asyncio.Event()
    release = asyncio.Event()
    completed = asyncio.Event()

    async def work() -> None:
        started.set()
        await release.wait()
        completed.set()

    task = await manager.submit(work, name="owned")
    await asyncio.wait_for(started.wait(), timeout=0.1)
    del task
    gc.collect()

    assert manager.outstanding_count == 1
    release.set()
    await asyncio.wait_for(manager.drain(), timeout=0.1)

    assert completed.is_set()


@pytest.mark.asyncio
async def test_nowait_rejection_does_not_construct_coroutine() -> None:
    manager = WebBackgroundTaskManager(max_concurrency=1, max_outstanding=1)
    manager.start()
    release = asyncio.Event()
    rejected_factory_called = False

    async def pending() -> None:
        await release.wait()

    def rejected_factory():
        nonlocal rejected_factory_called
        rejected_factory_called = True
        return pending()

    manager.submit_nowait(pending, name="pending")

    with pytest.raises(WebBackgroundTaskCapacityError):
        manager.submit_nowait(rejected_factory, name="rejected")

    assert not rejected_factory_called
    release.set()
    await asyncio.wait_for(manager.drain(), timeout=0.1)


@pytest.mark.asyncio
async def test_task_exception_is_recovered_and_capacity_is_released(caplog) -> None:
    manager = WebBackgroundTaskManager(max_concurrency=1, max_outstanding=1)
    manager.start()

    async def fail() -> None:
        raise RuntimeError("broken background job")

    task = await manager.submit(fail, name="failure")
    await asyncio.wait_for(task, timeout=0.1)
    await asyncio.wait_for(manager.drain(), timeout=0.1)

    assert manager.outstanding_count == 0
    assert "Web background task failed: failure" in caplog.text
    assert "broken background job" in caplog.text


@pytest.mark.asyncio
async def test_shutdown_closes_admission_and_joins_without_cancelling() -> None:
    manager = WebBackgroundTaskManager(max_concurrency=1, max_outstanding=1)
    manager.start()
    started = asyncio.Event()
    release = asyncio.Event()
    cancelled = False

    async def work() -> None:
        nonlocal cancelled
        started.set()
        try:
            await release.wait()
        except asyncio.CancelledError:
            cancelled = True
            raise

    await manager.submit(work, name="shutdown-owned")
    await asyncio.wait_for(started.wait(), timeout=0.1)

    shutdown = asyncio.create_task(manager.shutdown())
    await asyncio.sleep(0)

    assert not manager.is_accepting
    assert not shutdown.done()
    with pytest.raises(WebBackgroundTaskAdmissionClosed):
        await manager.submit(work, name="late")

    release.set()
    await asyncio.wait_for(shutdown, timeout=0.1)

    assert not cancelled
    assert manager.outstanding_count == 0


@pytest.mark.asyncio
async def test_manager_can_start_again_after_complete_shutdown() -> None:
    manager = WebBackgroundTaskManager(max_concurrency=1, max_outstanding=1)
    first_completed = asyncio.Event()
    second_completed = asyncio.Event()

    async def complete_first() -> None:
        first_completed.set()

    async def complete_second() -> None:
        second_completed.set()

    manager.start()
    await manager.submit(complete_first, name="first-lifespan")
    await asyncio.wait_for(manager.shutdown(), timeout=0.1)

    manager.start()
    await manager.submit(complete_second, name="second-lifespan")
    await asyncio.wait_for(manager.shutdown(), timeout=0.1)

    assert first_completed.is_set()
    assert second_completed.is_set()


@pytest.mark.asyncio
async def test_sync_thread_submission_uses_bound_loop_and_is_joined() -> None:
    manager = WebBackgroundTaskManager(max_concurrency=1, max_outstanding=1)
    manager.start()
    completed = asyncio.Event()

    async def work() -> None:
        completed.set()

    await asyncio.to_thread(
        manager.submit_threadsafe,
        work,
        name="thread-submission",
    )
    await asyncio.wait_for(manager.drain(), timeout=0.1)

    assert completed.is_set()


@pytest.mark.asyncio
async def test_sync_thread_submission_backpressures_without_dropping_work() -> None:
    manager = WebBackgroundTaskManager(max_concurrency=1, max_outstanding=1)
    manager.start()
    first_started = asyncio.Event()
    release_first = asyncio.Event()
    second_completed = asyncio.Event()

    async def first() -> None:
        first_started.set()
        await release_first.wait()

    async def second() -> None:
        second_completed.set()

    await manager.submit(first, name="first")
    await asyncio.wait_for(first_started.wait(), timeout=0.1)
    blocked_submission = asyncio.create_task(
        asyncio.to_thread(
            manager.submit_threadsafe,
            second,
            name="second",
        )
    )
    await asyncio.sleep(0)

    assert not blocked_submission.done()
    assert not second_completed.is_set()

    release_first.set()
    await asyncio.wait_for(blocked_submission, timeout=0.1)
    await asyncio.wait_for(manager.drain(), timeout=0.1)

    assert second_completed.is_set()


@pytest.mark.asyncio
async def test_sync_callback_on_bound_loop_uses_nonblocking_admission() -> None:
    manager = WebBackgroundTaskManager(max_concurrency=1, max_outstanding=1)
    manager.start()
    completed = asyncio.Event()

    async def work() -> None:
        completed.set()

    manager.submit_from_sync(work, name="loop-sync-callback")
    await asyncio.wait_for(manager.drain(), timeout=0.1)

    assert completed.is_set()
