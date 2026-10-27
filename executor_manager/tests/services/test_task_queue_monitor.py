# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the task queue stall monitor."""

import json
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from executor_manager.services.task_queue_monitor import (
    TaskQueueMonitor,
    run_queue_stall_check,
)

QUEUE_KEY = "wegent:task_queue:online:online"


def _pending(
    *,
    age_seconds: float,
    dequeued: bool,
    task_id: str = "13869",
) -> str:
    now = time.time()
    return json.dumps(
        {
            "task_id": task_id,
            "subtask_id": "13890",
            "queue_key": QUEUE_KEY,
            "enqueued_at": now - age_seconds,
            "dequeued_at": now - age_seconds if dequeued else None,
        }
    )


@pytest.fixture
def redis_client():
    client = MagicMock()
    client.scan_iter.return_value = []
    client.llen.return_value = 0
    client.lrange.return_value = []
    return client


def _monitor(redis_client) -> TaskQueueMonitor:
    service = MagicMock()
    service.redis_client = redis_client
    return TaskQueueMonitor(stall_timeout_seconds=600, queue_service=service)


@pytest.mark.asyncio
async def test_sweep_fails_dequeued_task_that_never_started(redis_client):
    """A dequeued task with no Pod after the grace period is failed."""
    redis_client.scan_iter.return_value = ["wegent:task_queue:pending:13869"]
    redis_client.get.return_value = _pending(age_seconds=900, dequeued=True)
    callback = MagicMock()
    callback.send_error = AsyncMock(return_value=True)

    with patch(
        "executor_manager.clients.callback_client.get_callback_client",
        return_value=callback,
    ):
        stalled = await _monitor(redis_client).sweep()

    assert stalled == ["13869"]
    callback.send_error.assert_awaited_once()
    assert callback.send_error.await_args.kwargs["error_code"] == "task_queue_stalled"
    redis_client.delete.assert_called_once_with("wegent:task_queue:pending:13869")


@pytest.mark.asyncio
async def test_sweep_skips_task_still_waiting_in_queue(redis_client):
    """Backpressure is not a stall: an item still in the queue is left alone."""
    redis_client.scan_iter.return_value = ["wegent:task_queue:pending:13869"]
    redis_client.get.return_value = _pending(age_seconds=900, dequeued=False)
    redis_client.llen.return_value = 1
    redis_client.lrange.return_value = [json.dumps({"metadata": {"task_id": 13869}})]
    callback = MagicMock()
    callback.send_error = AsyncMock(return_value=True)

    with patch(
        "executor_manager.clients.callback_client.get_callback_client",
        return_value=callback,
    ):
        stalled = await _monitor(redis_client).sweep()

    assert stalled == []
    callback.send_error.assert_not_awaited()
    redis_client.delete.assert_not_called()


@pytest.mark.asyncio
async def test_sweep_measures_from_dequeue_not_enqueue(redis_client):
    """Time spent waiting behind backpressure does not count as a stall."""
    redis_client.scan_iter.return_value = ["wegent:task_queue:pending:13869"]
    redis_client.get.return_value = _pending(age_seconds=900, dequeued=False)
    payload = json.loads(redis_client.get.return_value)
    payload["dequeued_at"] = time.time() - 60
    redis_client.get.return_value = json.dumps(payload)
    callback = MagicMock()
    callback.send_error = AsyncMock(return_value=True)

    stalled = await _monitor(redis_client).sweep()

    assert stalled == []
    callback.send_error.assert_not_awaited()


@pytest.mark.asyncio
async def test_sweep_skips_fresh_pending_record(redis_client):
    """A recently enqueued task is still within the grace period."""
    redis_client.scan_iter.return_value = ["wegent:task_queue:pending:13869"]
    redis_client.get.return_value = _pending(age_seconds=10, dequeued=False)
    callback = MagicMock()
    callback.send_error = AsyncMock(return_value=True)

    stalled = await _monitor(redis_client).sweep()

    assert stalled == []
    callback.send_error.assert_not_awaited()


@pytest.mark.asyncio
async def test_sweep_keeps_record_when_callback_fails(redis_client):
    """A failed error report is retried on the next sweep."""
    redis_client.scan_iter.return_value = ["wegent:task_queue:pending:13869"]
    redis_client.get.return_value = _pending(age_seconds=900, dequeued=True)
    callback = MagicMock()
    callback.send_error = AsyncMock(return_value=False)

    with patch(
        "executor_manager.clients.callback_client.get_callback_client",
        return_value=callback,
    ):
        stalled = await _monitor(redis_client).sweep()

    assert stalled == []
    redis_client.delete.assert_not_called()


@pytest.mark.asyncio
async def test_stall_check_skips_when_another_replica_holds_the_lock():
    """Only one executor_manager replica scans per interval."""
    lock = MagicMock()
    lock.acquire.return_value = False
    with (
        patch(
            "executor_manager.common.distributed_lock.get_distributed_lock",
            return_value=lock,
        ),
        patch.object(TaskQueueMonitor, "sweep", new_callable=AsyncMock) as sweep,
    ):
        await run_queue_stall_check()

    sweep.assert_not_awaited()
    lock.release.assert_not_called()


@pytest.mark.asyncio
async def test_stall_check_sweeps_and_releases_the_lock():
    """The lock holder runs the sweep and always releases the lock."""
    lock = MagicMock()
    lock.acquire.return_value = True
    with (
        patch(
            "executor_manager.common.distributed_lock.get_distributed_lock",
            return_value=lock,
        ),
        patch.object(
            TaskQueueMonitor, "sweep", new_callable=AsyncMock, return_value=["13869"]
        ) as sweep,
    ):
        await run_queue_stall_check()

    sweep.assert_awaited_once()
    lock.acquire.assert_called_once_with("task_queue_stall_check", expire_seconds=300)
    lock.release.assert_called_once_with("task_queue_stall_check")
