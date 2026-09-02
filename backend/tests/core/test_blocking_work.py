# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

import asyncio
import threading

import pytest

from app.core import blocking_work
from app.core.bounded_executor import BoundedExecutor, BoundedExecutorOverloaded


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("executor_name", "runner_name"),
    [
        ("_repository_io_executor", "run_repository_io"),
        ("_knowledge_io_executor", "run_knowledge_io"),
        ("_device_io_executor", "run_device_io"),
        ("_mcp_tool_executor", "run_mcp_tool"),
        ("_execution_io_executor", "run_execution_io"),
        ("_rate_limit_io_executor", "run_rate_limit_io"),
    ],
)
async def test_blocking_work_is_loop_responsive_and_capacity_bounded(
    monkeypatch: pytest.MonkeyPatch,
    executor_name: str,
    runner_name: str,
) -> None:
    executor = BoundedExecutor(
        max_workers=1,
        max_in_flight=1,
        thread_name_prefix=f"test-{runner_name}",
    )
    monkeypatch.setattr(blocking_work, executor_name, executor)
    runner = getattr(blocking_work, runner_name)
    first_started = threading.Event()
    release_first = threading.Event()
    calls: list[int] = []

    def blocking_call(value: int) -> int:
        calls.append(value)
        if value == 1:
            first_started.set()
            assert release_first.wait(timeout=1)
        return value

    first = asyncio.create_task(runner(blocking_call, 1))
    for _ in range(100):
        if first_started.is_set():
            break
        await asyncio.sleep(0.001)
    assert first_started.is_set()

    second = asyncio.create_task(runner(blocking_call, 2))
    loop_ticked = asyncio.Event()
    asyncio.get_running_loop().call_soon(loop_ticked.set)
    await asyncio.wait_for(loop_ticked.wait(), timeout=0.1)
    await asyncio.sleep(0.01)

    assert calls == [1]
    assert not second.done()

    release_first.set()
    assert await asyncio.gather(first, second) == [1, 2]
    assert calls == [1, 2]


@pytest.mark.asyncio
async def test_bounded_executor_rejects_beyond_finite_waiter_capacity() -> None:
    executor = BoundedExecutor(
        max_workers=1,
        max_in_flight=1,
        max_waiters=1,
        thread_name_prefix="test-finite-waiters",
    )
    first_started = threading.Event()
    release_first = threading.Event()

    def first_call() -> int:
        first_started.set()
        assert release_first.wait(timeout=1)
        return 1

    first = asyncio.create_task(executor.run(first_call))
    for _ in range(100):
        if first_started.is_set():
            break
        await asyncio.sleep(0.001)
    assert first_started.is_set()

    second = asyncio.create_task(executor.run(lambda: 2))
    await asyncio.sleep(0)
    with pytest.raises(BoundedExecutorOverloaded):
        await executor.run(lambda: 3)

    release_first.set()
    assert await asyncio.gather(first, second) == [1, 2]


@pytest.mark.asyncio
async def test_bounded_executor_replaces_thread_state_after_process_change() -> None:
    executor = BoundedExecutor(
        max_workers=1,
        max_in_flight=1,
        thread_name_prefix="test-prefork-reset",
    )
    await executor.run(threading.get_ident)
    inherited_executor = executor._executor

    executor._owner_pid = -1

    worker_thread = await asyncio.wait_for(
        executor.run(threading.get_ident),
        timeout=1,
    )

    assert executor._executor is not inherited_executor
    assert worker_thread != threading.get_ident()


@pytest.mark.asyncio
async def test_cancelled_waiter_immediately_returns_waiter_capacity() -> None:
    executor = BoundedExecutor(
        max_workers=1,
        max_in_flight=1,
        max_waiters=1,
        thread_name_prefix="test-cancelled-waiter",
    )
    first_started = threading.Event()
    release_first = threading.Event()

    def first_call() -> int:
        first_started.set()
        assert release_first.wait(timeout=1)
        return 1

    first = asyncio.create_task(executor.run(first_call))
    for _ in range(100):
        if first_started.is_set():
            break
        await asyncio.sleep(0.001)
    assert first_started.is_set()

    cancelled = asyncio.create_task(executor.run(lambda: 2))
    await asyncio.sleep(0)
    cancelled.cancel()
    with pytest.raises(asyncio.CancelledError):
        await cancelled

    replacement = asyncio.create_task(executor.run(lambda: 3))
    await asyncio.sleep(0)
    assert not replacement.done()

    release_first.set()
    assert await asyncio.gather(first, replacement) == [1, 3]
