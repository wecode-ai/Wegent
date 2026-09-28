# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import MagicMock, patch

from executor_manager.tasks.task_processor import TaskProcessor


def test_process_single_task_rejects_failed_executor_submission():
    """A generated executor name must not hide a failed Docker submission."""
    executor = MagicMock()
    executor.submit_executor.return_value = {
        "status": "failed",
        "executor_name": "failed-executor",
        "error_msg": "Docker run error",
    }
    task = {
        "task_id": 123,
        "subtask_id": 456,
        "executor_type": "docker",
        "user": {"name": "test-user"},
    }

    with patch(
        "executor_manager.tasks.task_processor.ExecutorDispatcher.get_executor",
        return_value=executor,
    ):
        result, success = TaskProcessor()._process_single_task(task)

    assert success is False
    assert result["status"] == "failed"
    assert result["executor_name"] == "failed-executor"
