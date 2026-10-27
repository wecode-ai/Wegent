# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for task queue consumer failure handling."""

from unittest.mock import AsyncMock, MagicMock, patch

from executor_manager.services.task_queue_consumer import TaskQueueConsumer

TASK_ID = 10000000000001
SUBTASK_ID = 10000000000002


def _build_consumer() -> TaskQueueConsumer:
    with (
        patch("executor_manager.services.task_queue_consumer.TaskQueueService"),
        patch("executor_manager.services.task_queue_consumer.TaskProcessor"),
    ):
        return TaskQueueConsumer(service_pool="online", queue_type="online")


def _task() -> dict:
    return {"metadata": {"task_id": TASK_ID, "subtask_id": SUBTASK_ID}}


def test_failed_result_with_executor_name_is_requeued():
    """A failed k8s result keeps executor_name; it must not count as success."""
    consumer = _build_consumer()
    consumer.task_processor = MagicMock()
    consumer.task_processor.process_tasks.return_value = {
        TASK_ID: {
            "status": "failed",
            "executor_name": "wegent-task-example-000000000000000",
            "error_msg": "Executor is deleted. Please create a new session.",
        }
    }
    consumer.queue_service = MagicMock()
    consumer.queue_service.requeue_task.return_value = (True, 1)

    consumer._process_task_with_retry(_task())

    consumer.queue_service.requeue_task.assert_called_once()


def test_failed_result_without_executor_name_is_requeued():
    """Failures before an executor exists still go through retry handling."""
    consumer = _build_consumer()
    consumer.task_processor = MagicMock()
    consumer.task_processor.process_tasks.return_value = {
        TASK_ID: {"status": "failed", "error_msg": "pod pending"}
    }
    consumer.queue_service = MagicMock()
    consumer.queue_service.requeue_task.return_value = (True, 1)

    consumer._process_task_with_retry(_task())

    consumer.queue_service.requeue_task.assert_called_once()


def test_successful_result_is_not_requeued():
    """Successful submissions keep the current no-retry behavior."""
    consumer = _build_consumer()
    consumer.task_processor = MagicMock()
    consumer.task_processor.process_tasks.return_value = {
        TASK_ID: {"status": "success", "executor_name": "wegent-task-ok"}
    }
    consumer.queue_service = MagicMock()

    consumer._process_task_with_retry(_task())

    consumer.queue_service.requeue_task.assert_not_called()


def test_exhausted_retries_report_failure_to_backend():
    """The final retry must emit an error callback so the task leaves RUNNING."""
    consumer = _build_consumer()
    consumer.task_processor = MagicMock()
    consumer.task_processor.process_tasks.return_value = {
        TASK_ID: {
            "status": "failed",
            "executor_name": "wegent-task-example-000000000000000",
            "error_msg": "Executor is deleted. Please create a new session.",
        }
    }
    consumer.queue_service = MagicMock()
    consumer.queue_service.requeue_task.return_value = (False, 4)

    with patch(
        "executor_manager.clients.callback_client.get_callback_client"
    ) as get_client:
        callback_client = MagicMock()
        callback_client.send_error = AsyncMock(return_value=True)
        get_client.return_value = callback_client

        consumer._process_task_with_retry(_task())

    callback_client.send_error.assert_awaited_once()
    assert callback_client.send_error.await_args.kwargs["task_id"] == TASK_ID
    assert callback_client.send_error.await_args.kwargs["subtask_id"] == SUBTASK_ID
