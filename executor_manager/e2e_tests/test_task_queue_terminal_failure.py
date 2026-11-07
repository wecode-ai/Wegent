# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""End-to-end tests for terminal task queue failure reporting."""

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from executor_manager.common.errors import ExecutorErrorCode
from executor_manager.services.task_queue_consumer import TaskQueueConsumer


@pytest.mark.integration
def test_non_retryable_failure_reports_stable_error_code() -> None:
    """Terminal submissions report their original code and never requeue."""
    calls: list[tuple[str, Any]] = []
    consumer = TaskQueueConsumer(service_pool="e2e", queue_type="online")
    consumer.task_processor.process_tasks = lambda tasks: {  # type: ignore[method-assign]
        101: {
            "status": "failed",
            "error_msg": "quota reached",
            "error_code": ExecutorErrorCode.USER_TASK_LIMIT,
        }
        for _ in tasks
    }
    consumer.queue_service.requeue_task = lambda task: calls.append(("requeue", task)) or (True, 1)  # type: ignore[method-assign]
    consumer.queue_service.clear_pending = lambda task_id: calls.append(("clear", task_id))  # type: ignore[method-assign]

    callback_client = MagicMock()
    callback_client.send_error = AsyncMock(return_value=True)
    with patch(
        "executor_manager.clients.callback_client.get_callback_client",
        return_value=callback_client,
    ):
        consumer._process_task_with_retry(
            {"metadata": {"task_id": 101, "subtask_id": 102}}
        )

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
