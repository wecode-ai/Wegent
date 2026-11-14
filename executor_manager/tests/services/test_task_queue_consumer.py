# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for task queue consumer failure handling."""

from unittest.mock import AsyncMock, MagicMock, patch

import httpx

from executor_manager.clients import executor_binding
from executor_manager.executors.docker.executor import DockerExecutor
from executor_manager.services.task_queue_consumer import TaskQueueConsumer
from executor_manager.tasks.task_processor import TaskProcessor

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


def test_deleted_executor_is_not_requeued():
    """A deleted executor is terminal and must not consume retry attempts."""
    consumer = _build_consumer()
    consumer.task_processor = MagicMock()
    consumer.task_processor.process_tasks.return_value = {
        TASK_ID: {
            "status": "failed",
            "executor_name": "wegent-task-example-000000000000000",
            "error_code": "executor_deleted",
            "error_msg": "Executor is deleted. Please create a new session.",
        }
    }
    consumer.queue_service = MagicMock()
    consumer.queue_service.requeue_task.return_value = (True, 1)
    consumer.queue_service.get_retry_count = MagicMock(return_value=2)

    consumer._process_task_with_retry(_task())

    consumer.queue_service.requeue_task.assert_not_called()
    consumer.queue_service.clear_pending.assert_not_called()


def test_other_failed_result_with_executor_name_is_requeued():
    """A failed runtime result keeps executor_name without becoming success."""
    consumer = _build_consumer()
    consumer.task_processor = MagicMock()
    consumer.task_processor.process_tasks.return_value = {
        TASK_ID: {
            "status": "failed",
            "executor_name": "wegent-task-example-000000000000000",
            "error_msg": "runtime pending",
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


def test_obsolete_binding_is_dropped_without_runtime_dispatch_or_failure_callback(
    mocker,
):
    consumer = _build_consumer()
    consumer.task_processor = TaskProcessor()
    executor = DockerExecutor.__new__(DockerExecutor)
    mocker.patch.object(executor, "_should_recreate_container", return_value=False)
    mocker.patch.object(executor, "wait_instance_ready", return_value={"port": 8080})
    dispatch = mocker.patch.object(executor, "_dispatch_initial_task_to_new_container")
    mocker.patch(
        "executor_manager.tasks.task_processor.ExecutorDispatcher.get_executor",
        return_value=executor,
    )
    mocker.patch.object(
        executor_binding,
        "traced_sync_client",
        return_value=httpx.Client(
            transport=httpx.MockTransport(lambda _: httpx.Response(410))
        ),
    )
    callback = mocker.patch(
        "executor_manager.clients.callback_client.get_callback_client"
    )
    task = _task()
    task["metadata"].update(
        executor_name="wegent-task-existing",
        executor_binding_token="dispatch-token",
    )

    consumer._process_task_with_retry(task)

    dispatch.assert_not_called()
    consumer.queue_service.clear_pending.assert_called_once_with(TASK_ID, SUBTASK_ID)
    consumer.queue_service.requeue_task.assert_not_called()
    callback.assert_not_called()


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
    consumer.queue_service.clear_pending.assert_called_once_with(TASK_ID, SUBTASK_ID)


def test_deleted_executor_reports_terminal_failure_immediately():
    """A deleted executor callback carries its stable code without retry text."""
    consumer = _build_consumer()
    consumer.task_processor = MagicMock()
    consumer.task_processor.process_tasks.return_value = {
        TASK_ID: {
            "status": "failed",
            "executor_name": "wegent-task-example-000000000000000",
            "error_code": "executor_deleted",
            "error_msg": "Executor is deleted. Please create a new session.",
        }
    }
    consumer.queue_service = MagicMock()
    consumer.queue_service.get_retry_count = MagicMock(return_value=2)

    with patch(
        "executor_manager.clients.callback_client.get_callback_client"
    ) as get_client:
        callback_client = MagicMock()
        callback_client.send_error = AsyncMock(return_value=True)
        get_client.return_value = callback_client

        consumer._process_task_with_retry(_task())

    callback_client.send_error.assert_awaited_once()
    assert callback_client.send_error.await_args.kwargs["error_message"] == (
        "Executor is deleted. Please create a new session."
    )
    assert callback_client.send_error.await_args.kwargs["error_code"] == (
        "executor_deleted"
    )
    consumer.queue_service.clear_pending.assert_called_once_with(TASK_ID, SUBTASK_ID)


def test_exhausted_retries_report_failure_to_backend():
    """The final retry must emit an error callback so the task leaves RUNNING."""
    consumer = _build_consumer()
    consumer.task_processor = MagicMock()
    consumer.task_processor.process_tasks.return_value = {
        TASK_ID: {
            "status": "failed",
            "executor_name": "wegent-task-example-000000000000000",
            "error_msg": "runtime pending",
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
    consumer.queue_service.clear_pending.assert_called_once_with(TASK_ID, SUBTASK_ID)


def test_failed_failure_callback_keeps_pending_record():
    """A failed error report is retried by the queue monitor."""
    consumer = _build_consumer()
    consumer.task_processor = MagicMock()
    consumer.task_processor.process_tasks.return_value = {
        TASK_ID: {
            "status": "failed",
            "executor_name": "wegent-task-example-000000000000000",
            "error_code": "executor_deleted",
            "error_msg": "Executor is deleted. Please create a new session.",
        }
    }
    consumer.queue_service = MagicMock()
    consumer.queue_service.requeue_task.return_value = (False, 4)

    with patch(
        "executor_manager.clients.callback_client.get_callback_client"
    ) as get_client:
        callback_client = MagicMock()
        callback_client.send_error = AsyncMock(return_value=False)
        get_client.return_value = callback_client

        consumer._process_task_with_retry(_task())

    callback_client.send_error.assert_awaited_once()
    consumer.queue_service.clear_pending.assert_not_called()
