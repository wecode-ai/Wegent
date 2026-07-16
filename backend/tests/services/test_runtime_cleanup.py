# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime, timedelta
from unittest.mock import AsyncMock, Mock, patch

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.subtask import Subtask, SubtaskStatus
from app.models.task import TaskResource
from app.services.adapters.executor_job import JobService


class RuntimeCleanupHelpers:
    def _task(
        self,
        task_id: int,
        updated_at: datetime,
        preserve: bool = False,
        deleted: bool = False,
    ):
        task = Mock(spec=TaskResource)
        task.id = task_id
        task.updated_at = updated_at
        task.is_active = (
            TaskResource.STATE_DELETED if deleted else TaskResource.STATE_ACTIVE
        )
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
            AsyncMock(spec=AsyncSession), inactive_hours=24
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
            AsyncMock(spec=AsyncSession), inactive_hours=24
        )

    assert result["skipped"] == []
    assert result["deleted"][0]["executor_name"] == "executor-stale"
    executor_service.delete_executor_task_async.assert_awaited_once_with(
        "executor-stale", "default"
    )
    mark_deleted.assert_awaited_once_with([1])


@pytest.mark.unit
@pytest.mark.asyncio
async def test_cleanup_releases_read_transaction_before_external_delete():
    job_service = JobService(Mock())
    now = datetime.now()
    stale_subtask = RuntimeCleanupHelpers()._subtask(
        1, 100, now - timedelta(hours=25), "executor-stale"
    )
    stale_task = RuntimeCleanupHelpers()._task(100, now - timedelta(hours=26))
    call_order = []
    db = Mock()
    db.rollback = AsyncMock(side_effect=lambda: call_order.append("rollback"))

    async def delete_executor(*_args, **_kwargs):
        call_order.append("delete")
        return True

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
        patch.object(job_service, "_mark_executor_deleted", new_callable=AsyncMock),
        patch(
            "app.services.adapters.executor_job.executor_kinds_service"
        ) as executor_service,
    ):
        executor_service.delete_executor_task_async = AsyncMock(
            side_effect=delete_executor
        )

        await job_service.cleanup_stale_task_executors(db, inactive_hours=24)

    assert call_order == ["rollback", "delete"]


@pytest.mark.unit
@pytest.mark.asyncio
async def test_scheduled_cleanup_releases_read_transaction_before_external_delete():
    job_service = JobService(Mock())
    now = datetime.now()
    stale_subtask = RuntimeCleanupHelpers()._subtask(
        1, 100, now - timedelta(hours=25), "executor-stale"
    )
    stale_task = RuntimeCleanupHelpers()._task(100, now - timedelta(hours=26))
    call_order = []
    db = Mock()
    db.rollback = AsyncMock(side_effect=lambda: call_order.append("rollback"))
    db.commit = AsyncMock(side_effect=lambda: call_order.append("commit"))

    async def delete_executor(*_args, **_kwargs):
        call_order.append("delete")
        return True

    with (
        patch(
            "app.services.adapters.executor_job.CLEANUP_TARGET_DELETED_EXECUTORS_PER_RUN",
            1,
        ),
        patch(
            "app.services.adapters.executor_job.executor_cleanup_cursor_service.get_cursor",
            new_callable=AsyncMock,
            return_value=Mock(last_scanned_subtask_id=0),
        ),
        patch.object(
            job_service,
            "_scan_candidate_subtasks_batch",
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
            job_service,
            "_get_cleanup_subtasks_for_task",
            new_callable=AsyncMock,
            return_value=[stale_subtask],
        ),
        patch.object(job_service, "_mark_executor_deleted", new_callable=AsyncMock),
        patch(
            "app.services.adapters.executor_job.executor_kinds_service"
        ) as executor_service,
    ):
        executor_service.delete_executor_task_async = AsyncMock(
            side_effect=delete_executor
        )

        await job_service.cleanup_stale_executors(db)

    assert call_order == ["rollback", "delete", "commit"]


@pytest.mark.unit
@pytest.mark.asyncio
async def test_cleanup_stale_task_executor_works_for_deleted_task():
    """Soft-deleted tasks (is_active=STATE_DELETED) must still be cleanable."""
    job_service_instance = JobService(Mock())
    now = datetime.now()
    deleted_task = RuntimeCleanupHelpers()._task(
        200, now - timedelta(hours=48), deleted=True
    )
    stale_subtask = RuntimeCleanupHelpers()._subtask(
        10, 200, now - timedelta(hours=25), "executor-deleted-task"
    )

    with (
        patch.object(
            job_service_instance,
            "_get_task_resource_any_state",
            new_callable=AsyncMock,
            return_value=deleted_task,
        ),
        patch.object(
            job_service_instance,
            "_get_cleanup_subtasks_for_task",
            new_callable=AsyncMock,
            return_value=[stale_subtask],
        ),
        patch.object(
            job_service_instance, "_mark_executor_deleted", new_callable=AsyncMock
        ) as mark_deleted,
        patch(
            "app.services.adapters.executor_job.executor_kinds_service"
        ) as executor_service,
    ):
        executor_service.delete_executor_task_async = AsyncMock(return_value=True)

        result = await job_service_instance.cleanup_stale_task_executor(
            AsyncMock(), task_id=200, inactive_hours=24, dry_run=False
        )

    assert result["deleted"] is True
    executor_service.delete_executor_task_async.assert_awaited_once_with(
        "executor-deleted-task", "default"
    )
    mark_deleted.assert_awaited_once_with([10])


@pytest.mark.unit
@pytest.mark.asyncio
async def test_cleanup_stale_task_executor_works_for_stuck_running_task():
    """RUNNING tasks with stale pods must be cleanable — inactive_hours is the gate."""
    job_service_instance = JobService(Mock())
    now = datetime.now()

    running_task = Mock(spec=TaskResource)
    running_task.id = 300
    running_task.updated_at = now - timedelta(hours=140)
    running_task.is_active = TaskResource.STATE_ACTIVE
    running_task.json = {
        "kind": "Task",
        "apiVersion": "agent.wecode.io/v1",
        "metadata": {
            "name": "task-300",
            "namespace": "default",
            "labels": {"taskType": "chat"},
        },
        "spec": {
            "title": "Stuck Task",
            "prompt": "test",
            "teamRef": {"name": "team", "namespace": "default"},
            "workspaceRef": {"name": "ws", "namespace": "default"},
        },
        "status": {"status": "RUNNING", "progress": 0},
    }
    stale_subtask = RuntimeCleanupHelpers()._subtask(
        20, 300, now - timedelta(hours=140), "executor-stuck"
    )

    with (
        patch.object(
            job_service_instance,
            "_get_task_resource_any_state",
            new_callable=AsyncMock,
            return_value=running_task,
        ),
        patch.object(
            job_service_instance,
            "_get_cleanup_subtasks_for_task",
            new_callable=AsyncMock,
            return_value=[stale_subtask],
        ),
        patch.object(
            job_service_instance, "_mark_executor_deleted", new_callable=AsyncMock
        ) as mark_deleted,
        patch(
            "app.services.adapters.executor_job.executor_kinds_service"
        ) as executor_service,
    ):
        executor_service.delete_executor_task_async = AsyncMock(return_value=True)

        result = await job_service_instance.cleanup_stale_task_executor(
            AsyncMock(), task_id=300, inactive_hours=24, dry_run=False
        )

    assert result["deleted"] is True
    executor_service.delete_executor_task_async.assert_awaited_once_with(
        "executor-stuck", "default"
    )
    mark_deleted.assert_awaited_once_with([20])
