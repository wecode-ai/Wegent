# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime, timedelta
from unittest.mock import AsyncMock, Mock, patch

import pytest

from app.models.subtask import Subtask, SubtaskStatus
from app.models.task import TaskResource
from app.services.adapters.executor_job import JobService


class RuntimeCleanupHelpers:
    def _task(self, task_id: int, updated_at: datetime, preserve: bool = False):
        task = Mock(spec=TaskResource)
        task.id = task_id
        task.updated_at = updated_at
        labels = {"taskType": "chat"}
        if preserve:
            labels["preserveExecutor"] = "true"
        task.json = {
            "kind": "Task",
            "apiVersion": "agent.wecode.io/v1",
            "metadata": {
                "name": f"task-{task_id}",
                "namespace": "default",
                "labels": labels,
            },
            "spec": {
                "title": "Test Task",
                "prompt": "Test prompt",
                "teamRef": {"name": "test-team", "namespace": "default"},
                "workspaceRef": {"name": "test-workspace", "namespace": "default"},
            },
            "status": {"status": "COMPLETED", "progress": 100},
        }
        return task

    def _subtask(
        self,
        subtask_id: int,
        task_id: int,
        updated_at: datetime,
        executor_name: str = "executor-1",
    ):
        subtask = Mock(spec=Subtask)
        subtask.id = subtask_id
        subtask.task_id = task_id
        subtask.executor_name = executor_name
        subtask.executor_namespace = "default"
        subtask.executor_deleted_at = False
        subtask.status = SubtaskStatus.COMPLETED
        subtask.updated_at = updated_at
        return subtask


@pytest.mark.unit
@pytest.mark.asyncio
async def test_cleanup_stale_task_executors_skips_executor_before_24_hours():
    job_service = JobService(Mock())
    now = datetime.now()
    recent_subtask = RuntimeCleanupHelpers()._subtask(
        1, 100, now - timedelta(hours=2), "executor-recent"
    )
    old_task = RuntimeCleanupHelpers()._task(100, now - timedelta(hours=48))

    with (
        patch.object(
            job_service,
            "_list_runtime_cleanup_subtasks",
            new_callable=AsyncMock,
            return_value=[recent_subtask],
        ),
        patch.object(
            job_service,
            "_load_tasks_for_cleanup",
            new_callable=AsyncMock,
            return_value={100: old_task},
        ),
        patch(
            "app.services.adapters.executor_job.executor_kinds_service"
        ) as executor_service,
    ):
        result = await job_service.cleanup_stale_task_executors(
            Mock(), inactive_hours=24
        )

    assert result["deleted"] == []
    assert result["skipped"][0]["reason"] == "not_stale"
    assert result["skipped"][0]["executor_name"] == "executor-recent"
    assert "eligible_after" in result["skipped"][0]
    executor_service.delete_executor_task_async.assert_not_called()


@pytest.mark.unit
@pytest.mark.asyncio
async def test_cleanup_stale_task_executors_deletes_executor_after_24_hours():
    job_service = JobService(Mock())
    now = datetime.now()
    stale_subtask = RuntimeCleanupHelpers()._subtask(
        1, 100, now - timedelta(hours=25), "executor-stale"
    )
    stale_task = RuntimeCleanupHelpers()._task(100, now - timedelta(hours=26))

    with (
        patch.object(
            job_service,
            "_list_runtime_cleanup_subtasks",
            new_callable=AsyncMock,
            return_value=[stale_subtask],
        ),
        patch.object(
            job_service,
            "_load_tasks_for_cleanup",
            new_callable=AsyncMock,
            return_value={100: stale_task},
        ),
        patch.object(
            job_service, "_mark_executor_deleted", new_callable=AsyncMock
        ) as mark_deleted,
        patch(
            "app.services.adapters.executor_job.executor_kinds_service"
        ) as executor_service,
    ):
        executor_service.delete_executor_task_async = AsyncMock(return_value=True)

        result = await job_service.cleanup_stale_task_executors(
            Mock(), inactive_hours=24
        )

    assert result["skipped"] == []
    assert result["deleted"][0]["executor_name"] == "executor-stale"
    executor_service.delete_executor_task_async.assert_awaited_once_with(
        "executor-stale", "default"
    )
    mark_deleted.assert_awaited_once_with([1])
