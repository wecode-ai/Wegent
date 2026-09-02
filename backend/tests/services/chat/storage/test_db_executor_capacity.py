# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

import asyncio
import threading
import time

import pytest

from app.core.bounded_executor import BoundedExecutor
from app.services.chat.storage import db as db_module


async def _wait_until_set(event: threading.Event) -> None:
    for _ in range(200):
        if event.is_set():
            return
        await asyncio.sleep(0.005)
    raise TimeoutError("worker did not start")


@pytest.mark.asyncio
async def test_db_executor_submission_is_bounded_without_blocking_loop(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        db_module,
        "_db_executor",
        BoundedExecutor(
            max_workers=1,
            max_in_flight=1,
            thread_name_prefix="test-db-capacity",
        ),
    )
    first_started = threading.Event()
    release_first = threading.Event()
    second_started = threading.Event()

    def first() -> None:
        first_started.set()
        release_first.wait(timeout=5)

    def second() -> None:
        second_started.set()

    first_task = asyncio.create_task(db_module.run_sync_in_executor(first))
    await _wait_until_set(first_started)
    second_task = asyncio.create_task(db_module.run_sync_in_executor(second))

    await asyncio.sleep(0.02)
    assert not second_started.is_set()
    assert not second_task.done()

    release_first.set()
    await asyncio.gather(first_task, second_task)
    assert second_started.is_set()


@pytest.mark.asyncio
async def test_cancelled_request_holds_capacity_until_sync_call_finishes(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        db_module,
        "_db_executor",
        BoundedExecutor(
            max_workers=1,
            max_in_flight=1,
            thread_name_prefix="test-db-cancellation",
        ),
    )
    first_started = threading.Event()
    release_first = threading.Event()
    second_started = threading.Event()

    def first() -> None:
        first_started.set()
        release_first.wait(timeout=5)

    def second() -> None:
        second_started.set()

    first_task = asyncio.create_task(db_module.run_sync_in_executor(first))
    await _wait_until_set(first_started)
    first_task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first_task

    second_task = asyncio.create_task(db_module.run_sync_in_executor(second))
    await asyncio.sleep(0.02)
    assert not second_started.is_set()

    release_first.set()
    await second_task
    assert second_started.is_set()


@pytest.mark.asyncio
async def test_session_decorator_uses_bounded_executor_capacity(monkeypatch) -> None:
    monkeypatch.setattr(
        db_module,
        "_db_executor",
        BoundedExecutor(
            max_workers=1,
            max_in_flight=1,
            thread_name_prefix="test-db-session-capacity",
        ),
    )
    first_started = threading.Event()
    release_first = threading.Event()
    decorated_started = threading.Event()

    def first() -> None:
        first_started.set()
        release_first.wait(timeout=5)

    class _SessionContext:
        def __enter__(self) -> object:
            return object()

        def __exit__(self, exc_type, exc, traceback) -> None:
            return None

    monkeypatch.setattr(db_module, "_db_session", _SessionContext)

    @db_module.with_session_in_executor
    def decorated(db: object) -> None:
        decorated_started.set()

    first_task = asyncio.create_task(db_module.run_sync_in_executor(first))
    await _wait_until_set(first_started)
    decorated_task = asyncio.create_task(decorated())

    await asyncio.sleep(0.02)
    assert not decorated_started.is_set()
    assert not decorated_task.done()

    release_first.set()
    await asyncio.gather(first_task, decorated_task)
    assert decorated_started.is_set()


def test_executor_capacity_is_shared_across_event_loops() -> None:
    executor = BoundedExecutor(
        max_workers=1,
        max_in_flight=1,
        thread_name_prefix="test-cross-loop-capacity",
    )
    first_started = threading.Event()
    release_first = threading.Event()
    second_started = threading.Event()
    submission_lock = threading.Lock()
    submission_count = 0
    original_submit = executor._executor.submit

    def counted_submit(*args, **kwargs):
        nonlocal submission_count
        with submission_lock:
            submission_count += 1
        return original_submit(*args, **kwargs)

    executor._executor.submit = counted_submit

    def first() -> None:
        first_started.set()
        release_first.wait(timeout=5)

    def second() -> None:
        second_started.set()

    first_thread = threading.Thread(
        target=lambda: asyncio.run(executor.run(first)),
        daemon=True,
    )
    second_thread = threading.Thread(
        target=lambda: asyncio.run(executor.run(second)),
        daemon=True,
    )
    first_thread.start()
    assert first_started.wait(timeout=2)
    second_thread.start()
    time.sleep(0.05)

    with submission_lock:
        assert submission_count == 1
    assert not second_started.is_set()

    release_first.set()
    first_thread.join(timeout=2)
    second_thread.join(timeout=2)

    assert not first_thread.is_alive()
    assert not second_thread.is_alive()
    with submission_lock:
        assert submission_count == 2
    assert second_started.is_set()
