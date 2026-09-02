# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Tests for loop-local asynchronous token-bucket admission."""

import asyncio

import pytest

from app.core.loop_rate_admission import LoopLocalTokenBucket


@pytest.mark.parametrize(
    ("rate_per_second", "burst", "message"),
    [
        (0, 1, "rate_per_second must be positive"),
        (-1, 1, "rate_per_second must be positive"),
        (1, 0, "burst must be positive"),
        (1, -1, "burst must be positive"),
    ],
)
def test_token_bucket_rejects_invalid_limits(
    rate_per_second: float,
    burst: int,
    message: str,
) -> None:
    with pytest.raises(ValueError, match=message):
        LoopLocalTokenBucket(
            rate_per_second=rate_per_second,
            burst=burst,
        )


@pytest.mark.asyncio
async def test_token_bucket_enforces_burst_and_sustained_rate() -> None:
    bucket = LoopLocalTokenBucket(rate_per_second=20, burst=2)
    loop = asyncio.get_running_loop()
    acquired_at: list[float] = []
    admitted: list[int] = []

    async def acquire(index: int) -> None:
        await bucket.acquire()
        acquired_at.append(loop.time())
        admitted.append(index)

    await asyncio.gather(*(acquire(index) for index in range(5)))

    assert len(acquired_at) == 5
    assert admitted == [0, 1, 2, 3, 4]
    assert acquired_at[1] - acquired_at[0] < 0.02
    assert acquired_at[2] - acquired_at[0] >= 0.04
    assert acquired_at[4] - acquired_at[0] >= 0.14


@pytest.mark.asyncio
async def test_cancelled_waiter_does_not_consume_future_token() -> None:
    bucket = LoopLocalTokenBucket(rate_per_second=20, burst=1)
    await bucket.acquire()

    cancelled_waiter = asyncio.create_task(bucket.acquire())
    successor = asyncio.create_task(bucket.acquire())
    await asyncio.sleep(0)
    cancelled_waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await cancelled_waiter

    await asyncio.wait_for(successor, timeout=0.08)


@pytest.mark.asyncio
async def test_waiting_for_rate_capacity_keeps_loop_responsive() -> None:
    bucket = LoopLocalTokenBucket(rate_per_second=1, burst=1)
    await bucket.acquire()
    waiting = asyncio.create_task(bucket.acquire())
    await asyncio.sleep(0)

    progressed = asyncio.Event()
    asyncio.get_running_loop().call_soon(progressed.set)
    await asyncio.wait_for(progressed.wait(), timeout=0.05)

    assert not waiting.done()
    waiting.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiting


@pytest.mark.asyncio
async def test_maximum_web_event_sources_wait_without_blocking_loop() -> None:
    bucket = LoopLocalTokenBucket(rate_per_second=0.001, burst=1)
    await bucket.acquire()
    waiting = [asyncio.create_task(bucket.acquire()) for _ in range(512)]
    await asyncio.sleep(0)

    progressed = asyncio.Event()
    asyncio.get_running_loop().call_soon(progressed.set)
    await asyncio.wait_for(progressed.wait(), timeout=0.1)

    assert not any(task.done() for task in waiting)
    for task in waiting:
        task.cancel()
    results = await asyncio.gather(*waiting, return_exceptions=True)
    assert all(isinstance(result, asyncio.CancelledError) for result in results)


def test_one_bucket_has_independent_capacity_per_event_loop() -> None:
    bucket = LoopLocalTokenBucket(rate_per_second=0.001, burst=1)

    asyncio.run(bucket.acquire())
    asyncio.run(bucket.acquire())
