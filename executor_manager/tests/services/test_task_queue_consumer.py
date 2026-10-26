# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Submission failures must reach the queue's retry and terminal callback path."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from executor_manager.services.task_queue_consumer import TaskQueueConsumer


@pytest.fixture
def consumer():
    consumer = object.__new__(TaskQueueConsumer)
    consumer.queue_type = "online"
    consumer.task_processor = MagicMock()
    consumer.queue_service = MagicMock()
    return consumer


@pytest.fixture
def task():
    return {"metadata": {"task_id": 42, "subtask_id": 43}}


def test_failed_named_executor_is_requeued(consumer, task):
    consumer.task_processor.process_tasks.return_value = {
        42: {
            "status": "failed",
            "executor_name": "deleted-executor",
            "error_msg": "Executor is deleted. Please create a new session.",
        }
    }
    consumer.queue_service.requeue_task.return_value = (True, 1)

    consumer._process_task_with_retry(task)

    consumer.queue_service.requeue_task.assert_called_once_with(task)


def test_failed_named_executor_sends_terminal_error_after_retries(consumer, task):
    consumer.task_processor.process_tasks.return_value = {
        42: {
            "status": "failed",
            "executor_name": "deleted-executor",
            "error_msg": "Executor is deleted. Please create a new session.",
        }
    }
    consumer.queue_service.requeue_task.return_value = (False, 3)
    callback = MagicMock()
    callback.send_error = AsyncMock(return_value=True)

    with patch(
        "executor_manager.clients.callback_client.get_callback_client",
        return_value=callback,
    ):
        consumer._process_task_with_retry(task)

    callback.send_error.assert_awaited_once_with(
        task_id=42,
        subtask_id=43,
        error_message=(
            "Task failed after 3 retries: "
            "Executor is deleted. Please create a new session."
        ),
        error_code="task_queue_failure",
    )


@pytest.mark.parametrize(
    "result",
    [None, {}, {"status": "success"}, {"executor_name": "executor-1"}],
)
def test_incomplete_submission_result_is_not_success(consumer, task, result):
    consumer.task_processor.process_tasks.return_value = {42: result}
    consumer.queue_service.requeue_task.return_value = (True, 1)

    consumer._process_task_with_retry(task)

    consumer.queue_service.requeue_task.assert_called_once_with(task)


def test_successful_submission_does_not_retry_or_callback(consumer, task):
    consumer.task_processor.process_tasks.return_value = {
        42: {"status": "success", "executor_name": "executor-1"}
    }

    consumer._process_task_with_retry(task)

    consumer.queue_service.requeue_task.assert_not_called()
