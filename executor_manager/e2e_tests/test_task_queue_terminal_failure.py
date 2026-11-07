# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""End-to-end tests for terminal task queue failure reporting.

These tests use the real Redis-backed queue and the real task processor. The
executor dispatcher is replaced with a deterministic in-process executor
because this environment cannot start a Kubernetes cluster; the test still
drives the production TaskProcessor and TaskQueueConsumer paths that translate
executor failure results into terminal callbacks.
"""

import os
from collections.abc import Iterator
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from executor_manager.common.config import reset_config
from executor_manager.common.errors import ExecutorErrorCode
from executor_manager.common.redis_factory import RedisClientFactory
from executor_manager.executors.dispatcher import ExecutorDispatcher
from executor_manager.services.task_queue_consumer import TaskQueueConsumer
from executor_manager.services.task_queue_service import TaskQueueService


@pytest.fixture
def real_queue(monkeypatch: pytest.MonkeyPatch) -> Iterator[TaskQueueService]:
    """Provide a real Redis queue and reset the process-wide executor cache."""
    redis_url = os.getenv("E2E_REDIS_URL")
    if not redis_url:
        pytest.fail("E2E_REDIS_URL must point to a dedicated real Redis database")
    monkeypatch.setenv("REDIS_URL", redis_url)
    reset_config()
    RedisClientFactory.reset()
    original_executors = ExecutorDispatcher._executors
    service = TaskQueueService("e2e-terminal", "online")
    try:
        yield service
    finally:
        client = service.redis_client
        if client is not None:
            client.delete(service.queue_key)
            task_id = 101
            client.delete(f"wegen:task_queue:pending:{task_id}")
            client.zrem("wegent:task_queue:pending_index", str(task_id))
            client.delete("wegent:task_queue:pending_index")
        RedisClientFactory.reset()
        reset_config()
        ExecutorDispatcher._executors = original_executors


@pytest.mark.integration
def test_non_retryable_failure_reports_stable_error_code(
    real_queue: TaskQueueService,
) -> None:
    """Terminal submissions report their original code and never requeue."""
    calls: list[tuple[str, Any]] = []

    class TerminalExecutor:
        def submit_executor(self, task, callback=None):
            return {
                "status": "failed",
                "error_msg": "quota reached",
                "error_code": ExecutorErrorCode.USER_TASK_LIMIT,
            }

    consumer = TaskQueueConsumer(
        service_pool=real_queue.service_pool,
        queue_type=real_queue.queue_type,
    )
    ExecutorDispatcher._executors = {"docker": TerminalExecutor()}

    consumer.queue_service.requeue_task = lambda task: calls.append(("requeue", task)) or (True, 1)  # type: ignore[method-assign]
    consumer.queue_service.clear_pending = lambda task_id: calls.append(("clear", task_id))  # type: ignore[method-assign]

    callback_client = MagicMock()
    callback_client.send_error = AsyncMock(return_value=True)
    task = {"metadata": {"task_id": 101, "subtask_id": 102, "executor_type": "docker"}}
    assert real_queue.enqueue_task(task)
    with patch(
        "executor_manager.clients.callback_client.get_callback_client",
        return_value=callback_client,
    ):
        consumer._process_task_with_retry(real_queue.dequeue_task(timeout=1))

    assert calls == [("clear", 101)]
    callback_client.send_error.assert_called_once_with(
        task_id=101,
        subtask_id=102,
        error_message="quota reached",
        error_code=ExecutorErrorCode.USER_TASK_LIMIT,
    )


@pytest.mark.integration
def test_retryable_failure_still_requeues() -> None:
    """Failures without a terminal code retain the historical retry path."""
    calls: list[tuple[str, Any]] = []
    consumer = TaskQueueConsumer(service_pool="e2e", queue_type="online")
    consumer.task_processor.process_tasks = lambda tasks: {  # type: ignore[method-assign]
        101: {"status": "failed", "error_msg": "connection reset", "error_code": ""}
        for _ in tasks
    }
    consumer.queue_service.requeue_task = lambda task: calls.append(("requeue", task)) or (True, 1)  # type: ignore[method-assign]
    consumer.queue_service.clear_pending = lambda task_id: calls.append(("clear", task_id))  # type: ignore[method-assign]

    consumer._process_task_with_retry({"metadata": {"task_id": 101, "subtask_id": 102}})

    assert calls == [("requeue", {"metadata": {"task_id": 101, "subtask_id": 102}})]
