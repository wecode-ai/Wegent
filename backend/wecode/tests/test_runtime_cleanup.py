# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import time
from datetime import datetime, timedelta
from unittest.mock import ANY, AsyncMock, Mock, patch

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

import wecode.service.executor_job_patch  # noqa: F401  ensure orphan pod methods are patched onto JobService
from app.models.subtask import Subtask, SubtaskStatus
from app.models.task import TaskResource
from app.services.adapters.executor_job import JobService
from wecode.service.executor_job_patch import _pod_is_abnormal


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
            job_service,
            "_archive_workspace",
            new_callable=AsyncMock,
            return_value=True,
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
        patch.object(
            job_service,
            "_archive_workspace",
            new_callable=AsyncMock,
            return_value=True,
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
        patch.object(
            job_service,
            "_get_cleanup_subtasks_for_executors",
            new_callable=AsyncMock,
            return_value=[stale_subtask],
        ),
        patch.object(
            job_service,
            "_archive_workspace",
            new_callable=AsyncMock,
            return_value=True,
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
            job_service_instance,
            "_archive_workspace",
            new_callable=AsyncMock,
            return_value=True,
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
            job_service_instance,
            "_archive_workspace",
            new_callable=AsyncMock,
            return_value=True,
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


@pytest.mark.unit
@pytest.mark.asyncio
async def test_cleanup_archives_workspace_for_chat_task_type() -> None:
    """Non-code task types must also go through archive before deletion."""
    job_service = JobService(Mock())
    now = datetime.now()
    stale_subtask = RuntimeCleanupHelpers()._subtask(
        1, 100, now - timedelta(hours=25), "executor-chat"
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
            job_service,
            "_filter_cleanup_candidates",
            return_value=([stale_subtask], Mock()),
        ),
        patch.object(
            job_service,
            "_archive_workspace",
            new_callable=AsyncMock,
            return_value=True,
        ) as archive_workspace,
        patch.object(job_service, "_mark_executor_deleted", new_callable=AsyncMock),
        patch(
            "app.services.adapters.executor_job.executor_kinds_service"
        ) as executor_service,
    ):
        executor_service.delete_executor_task_async = AsyncMock(return_value=True)

        await job_service.cleanup_stale_task_executors(
            AsyncMock(spec=AsyncSession), inactive_hours=24
        )

    archive_workspace.assert_awaited_once()
    executor_service.delete_executor_task_async.assert_awaited_once_with(
        "executor-chat", "default"
    )


@pytest.mark.unit
@pytest.mark.asyncio
async def test_cleanup_skips_deletion_when_archive_fails_for_chat_task() -> None:
    """Archive failure must block deletion regardless of task type."""
    job_service = JobService(Mock())
    now = datetime.now()
    stale_subtask = RuntimeCleanupHelpers()._subtask(
        1, 100, now - timedelta(hours=25), "executor-chat"
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
            job_service,
            "_filter_cleanup_candidates",
            return_value=([stale_subtask], Mock()),
        ),
        patch.object(
            job_service,
            "_archive_workspace",
            new_callable=AsyncMock,
            return_value=False,
        ) as archive_workspace,
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

    archive_workspace.assert_awaited_once()
    executor_service.delete_executor_task_async.assert_not_called()
    mark_deleted.assert_not_called()
    assert result["deleted"] == []
    assert result["skipped"][0]["executor_name"] == "executor-chat"
    assert result["skipped"][0]["reason"] == "archive_failed"


@pytest.mark.unit
@pytest.mark.asyncio
async def test_cleanup_archives_every_task_sharing_one_executor() -> None:
    """All tasks sharing an executor must be archived before deletion."""
    job_service = JobService(Mock())
    now = datetime.now()
    helpers = RuntimeCleanupHelpers()
    subtask_a = helpers._subtask(1, 100, now - timedelta(hours=25), "executor-shared")
    subtask_b = helpers._subtask(2, 101, now - timedelta(hours=25), "executor-shared")
    task_a = helpers._task(100, now - timedelta(hours=26))
    task_b = helpers._task(101, now - timedelta(hours=26))

    with (
        patch.object(
            job_service,
            "_list_runtime_cleanup_subtasks",
            new_callable=AsyncMock,
            return_value=[subtask_a, subtask_b],
        ),
        patch.object(
            job_service,
            "_load_tasks_for_cleanup",
            new_callable=AsyncMock,
            return_value={100: task_a, 101: task_b},
        ),
        patch.object(
            job_service,
            "_archive_workspace",
            new_callable=AsyncMock,
            return_value=True,
        ) as archive_workspace,
        patch.object(
            job_service, "_mark_executor_deleted", new_callable=AsyncMock
        ) as mark_deleted,
        patch(
            "app.services.adapters.executor_job.executor_kinds_service"
        ) as executor_service,
    ):
        executor_service.delete_executor_task_async = AsyncMock(return_value=True)

        await job_service.cleanup_stale_task_executors(
            AsyncMock(spec=AsyncSession), inactive_hours=24
        )

    assert archive_workspace.await_count == 2
    archived_tasks = {
        id(call.kwargs["task"]) for call in archive_workspace.await_args_list
    }
    assert archived_tasks == {id(task_a), id(task_b)}
    executor_service.delete_executor_task_async.assert_awaited_once_with(
        "executor-shared", "default"
    )
    mark_deleted.assert_awaited_once_with([1, 2])


@pytest.mark.unit
@pytest.mark.asyncio
async def test_cleanup_skips_deletion_when_second_shared_task_archive_fails() -> None:
    """A failed archive for any task in the group must block deletion."""
    job_service = JobService(Mock())
    now = datetime.now()
    helpers = RuntimeCleanupHelpers()
    subtask_a = helpers._subtask(1, 100, now - timedelta(hours=25), "executor-shared")
    subtask_b = helpers._subtask(2, 101, now - timedelta(hours=25), "executor-shared")
    task_a = helpers._task(100, now - timedelta(hours=26))
    task_b = helpers._task(101, now - timedelta(hours=26))

    with (
        patch.object(
            job_service,
            "_list_runtime_cleanup_subtasks",
            new_callable=AsyncMock,
            return_value=[subtask_a, subtask_b],
        ),
        patch.object(
            job_service,
            "_load_tasks_for_cleanup",
            new_callable=AsyncMock,
            return_value={100: task_a, 101: task_b},
        ),
        patch.object(
            job_service,
            "_archive_workspace",
            new_callable=AsyncMock,
            side_effect=[True, False],
        ) as archive_workspace,
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

    assert archive_workspace.await_count == 2
    executor_service.delete_executor_task_async.assert_not_called()
    mark_deleted.assert_not_called()
    assert result["deleted"] == []
    assert result["skipped"][0]["executor_name"] == "executor-shared"
    assert result["skipped"][0]["reason"] == "archive_failed"


@pytest.mark.unit
@pytest.mark.asyncio
async def test_cleanup_stale_task_executor_deletes_orphan_pod():
    """When no subtask records exist, the orphan K8s pod should be deleted."""
    job_service_instance = JobService(Mock())
    now = datetime.now()
    task = RuntimeCleanupHelpers()._task(400, now - timedelta(hours=50))

    with (
        patch.object(
            job_service_instance,
            "_get_task_resource_any_state",
            new_callable=AsyncMock,
            return_value=task,
        ),
        patch.object(
            job_service_instance,
            "_get_cleanup_subtasks_for_task",
            new_callable=AsyncMock,
            return_value=[],
        ),
        patch(
            "app.services.adapters.executor_job.executor_kinds_service"
        ) as executor_service,
    ):
        executor_service.delete_executor_by_task_id_async = AsyncMock(
            return_value={"status": "success", "deleted_pods": ["wegent-task-400-abc"]}
        )

        result = await job_service_instance.cleanup_stale_task_executor(
            AsyncMock(), task_id=400, inactive_hours=24, dry_run=False
        )

    assert result["deleted"] is True
    assert result["reason"] == "pod_deleted"
    assert result["deleted_pods"] == ["wegent-task-400-abc"]
    executor_service.delete_executor_by_task_id_async.assert_awaited_once_with(400)


@pytest.mark.unit
@pytest.mark.asyncio
async def test_cleanup_stale_task_executor_orphan_pod_not_found():
    """When no subtask records exist and no K8s pod found, returns executor_not_found."""
    job_service_instance = JobService(Mock())
    now = datetime.now()
    task = RuntimeCleanupHelpers()._task(401, now - timedelta(hours=50))

    with (
        patch.object(
            job_service_instance,
            "_get_task_resource_any_state",
            new_callable=AsyncMock,
            return_value=task,
        ),
        patch.object(
            job_service_instance,
            "_get_cleanup_subtasks_for_task",
            new_callable=AsyncMock,
            return_value=[],
        ),
        patch(
            "app.services.adapters.executor_job.executor_kinds_service"
        ) as executor_service,
    ):
        executor_service.delete_executor_by_task_id_async = AsyncMock(
            return_value={"status": "not_found", "error_msg": "No pod found"}
        )

        result = await job_service_instance.cleanup_stale_task_executor(
            AsyncMock(), task_id=401, inactive_hours=24, dry_run=False
        )

    assert result["deleted"] is False
    assert result["reason"] == "executor_not_found"
    executor_service.delete_executor_by_task_id_async.assert_awaited_once_with(401)


@pytest.mark.unit
@pytest.mark.asyncio
async def test_cleanup_stale_task_executor_orphan_pod_dry_run():
    """dry_run=True should skip pod deletion and return executor_not_found immediately."""
    job_service_instance = JobService(Mock())
    now = datetime.now()
    task = RuntimeCleanupHelpers()._task(402, now - timedelta(hours=50))

    with (
        patch.object(
            job_service_instance,
            "_get_task_resource_any_state",
            new_callable=AsyncMock,
            return_value=task,
        ),
        patch.object(
            job_service_instance,
            "_get_cleanup_subtasks_for_task",
            new_callable=AsyncMock,
            return_value=[],
        ),
        patch(
            "app.services.adapters.executor_job.executor_kinds_service"
        ) as executor_service,
    ):
        executor_service.delete_executor_by_task_id_async = AsyncMock()

        result = await job_service_instance.cleanup_stale_task_executor(
            AsyncMock(), task_id=402, inactive_hours=24, dry_run=True
        )

    assert result["deleted"] is False
    assert result["reason"] == "executor_not_found"
    assert result["dry_run"] is True
    executor_service.delete_executor_by_task_id_async.assert_not_called()


@pytest.mark.unit
@pytest.mark.asyncio
async def test_cleanup_stale_task_executor_orphan_pod_error_fallback():
    """When delete_executor_by_task_id_async raises, return executor_not_found gracefully."""
    job_service_instance = JobService(Mock())
    now = datetime.now()
    task = RuntimeCleanupHelpers()._task(403, now - timedelta(hours=50))

    with (
        patch.object(
            job_service_instance,
            "_get_task_resource_any_state",
            new_callable=AsyncMock,
            return_value=task,
        ),
        patch.object(
            job_service_instance,
            "_get_cleanup_subtasks_for_task",
            new_callable=AsyncMock,
            return_value=[],
        ),
        patch(
            "app.services.adapters.executor_job.executor_kinds_service"
        ) as executor_service,
    ):
        executor_service.delete_executor_by_task_id_async = AsyncMock(
            side_effect=Exception("executor_manager unreachable")
        )

        result = await job_service_instance.cleanup_stale_task_executor(
            AsyncMock(), task_id=403, inactive_hours=24, dry_run=False
        )

    assert result["deleted"] is False
    assert result["reason"] == "executor_not_found"


@pytest.mark.unit
@pytest.mark.asyncio
async def test_cleanup_stale_orphan_executors_delegates_each_pod_to_cleanup_stale_orphan_executor():
    """Every eligible old pod is delegated to _cleanup_stale_orphan_executor and aggregated.

    The subtask-record decision lives inside _cleanup_stale_orphan_executor (via
    cleanup_stale_task_executor), so cleanup_orphan_pods itself simply iterates
    all pods above the task_id threshold and aggregates the per-pod outcome.
    """
    job_service_instance = JobService(Mock())
    old_pods = [
        {"task_id": "1001", "pod_name": "wegent-task-1001-xyz"},
        {"task_id": "1002", "pod_name": "wegent-task-1002-abc"},
    ]

    with (
        patch(
            "wecode.service.executor_job_patch.get_executor_runtime_client"
        ) as mock_get_client,
        patch(
            "app.services.adapters.executor_job.executor_kinds_service"
        ) as executor_service,
        patch.object(
            job_service_instance,
            "_cleanup_stale_orphan_executor",
            new_callable=AsyncMock,
            side_effect=[
                {
                    "task_id": 1001,
                    "pod_name": "wegent-task-1001-xyz",
                    "deleted": True,
                    "skipped": False,
                    "reason": "pod_deleted",
                },
                {
                    "task_id": 1002,
                    "pod_name": "wegent-task-1002-abc",
                    "deleted": False,
                    "skipped": True,
                    "reason": "not_stale",
                },
            ],
        ) as mock_cleanup,
    ):
        executor_service.get_old_pods_async = AsyncMock(return_value=old_pods)

        mock_runtime_client = Mock()
        mock_runtime_client.get_sandbox = AsyncMock(return_value=(None, None))
        mock_get_client.return_value = mock_runtime_client

        result = await job_service_instance.cleanup_orphan_pods(
            AsyncMock(spec=AsyncSession), older_than_hours=48
        )

    assert result["total_scanned"] == 2
    assert len(result["deleted"]) == 1
    assert result["deleted"][0]["task_id"] == 1001
    assert len(result["skipped"]) == 1
    assert result["skipped"][0]["task_id"] == 1002
    assert result["skipped"][0]["reason"] == "not_stale"
    assert mock_cleanup.await_count == 2
    first_call_kwargs = mock_cleanup.call_args_list[0].kwargs
    assert first_call_kwargs["task_id"] == 1001
    assert first_call_kwargs["pod_name"] == "wegent-task-1001-xyz"
    assert first_call_kwargs["inactive_hours"] == 24  # inactive_hours default
    assert first_call_kwargs["max_inactive_hours"] == 24 * 7  # 7-day default


@pytest.mark.unit
@pytest.mark.asyncio
async def test_cleanup_stale_orphan_executors_dry_run_skips_deletion():
    """dry_run=True should skip all deletions and report them as dry_run skips."""
    job_service_instance = JobService(Mock())
    old_pods = [{"task_id": "1200", "pod_name": "wegent-task-1200-dry"}]

    with (
        patch(
            "app.services.adapters.executor_job.executor_kinds_service"
        ) as executor_service,
        patch.object(
            job_service_instance,
            "_get_cleanup_subtasks_for_task",
            new_callable=AsyncMock,
            return_value=[],
        ),
        patch.object(
            job_service_instance,
            "_cleanup_stale_orphan_executor",
            new_callable=AsyncMock,
        ) as mock_cleanup,
    ):
        executor_service.get_old_pods_async = AsyncMock(return_value=old_pods)

        result = await job_service_instance.cleanup_orphan_pods(
            AsyncMock(spec=AsyncSession), older_than_hours=48, dry_run=True
        )

    assert result["total_scanned"] == 1
    assert result["deleted"] == []
    assert result["skipped"][0]["task_id"] == 1200
    assert result["skipped"][0]["reason"] == "dry_run"
    mock_cleanup.assert_not_called()


@pytest.mark.unit
@pytest.mark.asyncio
async def test_cleanup_stale_orphan_executors_pod_already_gone():
    """When direct pod delete returns not_found, report as failed (delete_failed)."""
    job_service_instance = JobService(Mock())
    old_pods = [{"task_id": "1100", "pod_name": "wegent-task-1100-gone"}]

    with (
        patch(
            "wecode.service.executor_job_patch.get_executor_runtime_client"
        ) as mock_get_client,
        patch(
            "app.services.adapters.executor_job.executor_kinds_service"
        ) as executor_service,
        patch.object(
            job_service_instance,
            "_get_cleanup_subtasks_for_task",
            new_callable=AsyncMock,
            return_value=[],
        ),
        patch.object(
            job_service_instance,
            "_cleanup_stale_orphan_executor",
            new_callable=AsyncMock,
            return_value={
                "task_id": 1100,
                "pod_name": "wegent-task-1100-gone",
                "deleted": False,
                "skipped": False,
                "reason": "delete_failed",
            },
        ),
    ):
        executor_service.get_old_pods_async = AsyncMock(return_value=old_pods)

        mock_runtime_client = Mock()
        mock_runtime_client.get_sandbox = AsyncMock(return_value=(None, None))
        mock_get_client.return_value = mock_runtime_client

        result = await job_service_instance.cleanup_orphan_pods(
            AsyncMock(spec=AsyncSession), older_than_hours=48
        )

    assert result["deleted"] == []
    assert result["failed"][0]["task_id"] == 1100
    assert result["failed"][0]["reason"] == "delete_failed"


@pytest.mark.unit
@pytest.mark.asyncio
async def test_cleanup_stale_orphan_executors_empty_k8s_response():
    """When K8s returns no old pods, result should be a no-op."""
    job_service_instance = JobService(Mock())

    with patch(
        "app.services.adapters.executor_job.executor_kinds_service"
    ) as executor_service:
        executor_service.get_old_pods_async = AsyncMock(return_value=[])

        result = await job_service_instance.cleanup_orphan_pods(
            AsyncMock(spec=AsyncSession), older_than_hours=48
        )

    assert result["total_scanned"] == 0
    assert result["deleted"] == []
    assert result["skipped"] == []
    assert result["failed"] == []


@pytest.mark.unit
@pytest.mark.asyncio
async def test_cleanup_stale_orphan_executors_no_task_id_skipped():
    """Pods without a task_id label must be skipped, mirroring cleanup_stale_tasks.sh."""
    job_service_instance = JobService(Mock())
    old_pods = [{"task_id": None, "pod_name": "sandbox-unlabeled-xyz"}]

    with patch(
        "app.services.adapters.executor_job.executor_kinds_service"
    ) as executor_service:
        executor_service.get_old_pods_async = AsyncMock(return_value=old_pods)

        result = await job_service_instance.cleanup_orphan_pods(
            AsyncMock(spec=AsyncSession), older_than_hours=48
        )

    assert result["total_scanned"] == 1
    assert result["deleted"] == []
    assert result["failed"] == []
    assert result["skipped"][0]["pod_name"] == "sandbox-unlabeled-xyz"
    assert result["skipped"][0]["reason"] == "no_task_id"


@pytest.mark.unit
@pytest.mark.asyncio
async def test_cleanup_stale_orphan_executors_task_id_below_threshold_skipped():
    """Pods with task_id <= 1000 must be skipped, mirroring awk '$1+0 > 1000' in delete_notfound_pods.sh."""
    job_service_instance = JobService(Mock())
    old_pods = [
        {"task_id": "500", "pod_name": "wegent-task-500-lowid"},
        {"task_id": "1000", "pod_name": "wegent-task-1000-boundary"},
    ]

    with patch(
        "app.services.adapters.executor_job.executor_kinds_service"
    ) as executor_service:
        executor_service.get_old_pods_async = AsyncMock(return_value=old_pods)

        result = await job_service_instance.cleanup_orphan_pods(
            AsyncMock(spec=AsyncSession), older_than_hours=48
        )

    assert result["total_scanned"] == 2
    assert result["deleted"] == []
    assert result["failed"] == []
    assert len(result["skipped"]) == 2
    assert result["skipped"][0]["reason"] == "invalid_task_id(500)"
    assert result["skipped"][1]["reason"] == "invalid_task_id(1000)"


def _mock_distributed_lock(async_redis_client):
    lock = Mock()
    lock.async_redis_client = async_redis_client
    return patch(
        "app.core.distributed_lock.distributed_lock",
        lock,
    )


@pytest.mark.unit
@pytest.mark.asyncio
async def test_orphan_cleanup_due_when_no_timestamp():
    """First run (no recorded timestamp) is always due."""
    from wecode.service.jobs import _orphan_cleanup_due

    redis_client = Mock()
    redis_client.get = AsyncMock(return_value=None)

    with _mock_distributed_lock(redis_client):
        assert await _orphan_cleanup_due(10800) is True


@pytest.mark.unit
@pytest.mark.asyncio
async def test_orphan_cleanup_not_due_within_interval():
    """A run recorded less than one interval ago is not due (global rate limit)."""
    from wecode.service.jobs import _orphan_cleanup_due

    recent = time.time() - 100
    redis_client = Mock()
    redis_client.get = AsyncMock(return_value=str(recent))

    with _mock_distributed_lock(redis_client):
        assert await _orphan_cleanup_due(10800) is False


@pytest.mark.unit
@pytest.mark.asyncio
async def test_orphan_cleanup_due_after_interval():
    """A run recorded more than one interval ago is due again."""
    from wecode.service.jobs import _orphan_cleanup_due

    stale = time.time() - 20000
    redis_client = Mock()
    redis_client.get = AsyncMock(return_value=str(stale))

    with _mock_distributed_lock(redis_client):
        assert await _orphan_cleanup_due(10800) is True


@pytest.mark.unit
@pytest.mark.asyncio
async def test_orphan_cleanup_due_when_redis_unavailable():
    """Fail open: run when Redis is unavailable, matching lock behavior."""
    from wecode.service.jobs import _orphan_cleanup_due

    with _mock_distributed_lock(None):
        assert await _orphan_cleanup_due(10800) is True


@pytest.mark.unit
@pytest.mark.asyncio
async def test_mark_orphan_cleanup_ran_writes_timestamp():
    """Recording a run stores the current epoch seconds under the last-run key."""
    from wecode.service.jobs import (
        ORPHAN_POD_CLEANUP_LAST_RUN_KEY,
        _mark_orphan_cleanup_ran,
    )

    redis_client = Mock()
    redis_client.set = AsyncMock()

    with _mock_distributed_lock(redis_client):
        await _mark_orphan_cleanup_ran()

    redis_client.set.assert_awaited_once()
    key_arg = redis_client.set.call_args.args[0]
    value_arg = redis_client.set.call_args.args[1]
    assert key_arg == ORPHAN_POD_CLEANUP_LAST_RUN_KEY
    assert float(value_arg) == pytest.approx(time.time(), abs=5)


@pytest.mark.unit
@pytest.mark.asyncio
async def test_cleanup_stale_orphan_sandbox_deletes_and_archives():
    """Sandbox cleanup delegates to cleanup_sandbox_by_task_id_async."""
    job_service_instance = JobService(Mock())

    with patch(
        "app.services.adapters.executor_job.executor_kinds_service"
    ) as ek_service:
        ek_service.cleanup_sandbox_by_task_id_async = AsyncMock(
            return_value={
                "deleted": True,
                "redis_cleared": True,
                "archived": True,
                "reason": "sandbox_deleted",
            }
        )

        result = await job_service_instance._cleanup_stale_orphan_sandbox(
            task_id=5000,
            pod_name="sandbox-5000-abc",
            inactive_hours=24,
            max_inactive_hours=24 * 7,
            sandbox_payload={"last_activity_at": 0},
        )

    assert result["deleted"] is True
    assert result["skipped"] is False
    assert result["reason"] == "sandbox_deleted"
    assert result["archived"] is True
    # last_activity_at=0 is idle well past max_inactive_hours -> force delete on archive failure
    ek_service.cleanup_sandbox_by_task_id_async.assert_awaited_once_with(
        5000, archive_before_delete=True, delete_on_archive_failure=True
    )


@pytest.mark.unit
@pytest.mark.asyncio
async def test_cleanup_stale_orphan_sandbox_failed():
    """When cleanup_sandbox_by_task_id_async raises, return sandbox_cleanup_failed."""
    job_service_instance = JobService(Mock())

    with patch(
        "app.services.adapters.executor_job.executor_kinds_service"
    ) as ek_service:
        ek_service.cleanup_sandbox_by_task_id_async = AsyncMock(
            side_effect=Exception("executor_manager unreachable")
        )

        result = await job_service_instance._cleanup_stale_orphan_sandbox(
            task_id=5001,
            pod_name="sandbox-5001-xyz",
            inactive_hours=24,
            max_inactive_hours=24 * 7,
            sandbox_payload={"last_activity_at": 0},
        )

    assert result["deleted"] is False
    assert result["skipped"] is False
    assert result["reason"] == "sandbox_cleanup_failed"


@pytest.mark.unit
@pytest.mark.asyncio
async def test_cleanup_stale_orphan_sandbox_not_deleted():
    """When neither pod nor Redis is cleared, it's skipped."""
    job_service_instance = JobService(Mock())

    with patch(
        "app.services.adapters.executor_job.executor_kinds_service"
    ) as ek_service:
        ek_service.cleanup_sandbox_by_task_id_async = AsyncMock(
            return_value={
                "deleted": False,
                "redis_cleared": False,
                "archived": False,
                "reason": "sandbox_not_found",
            }
        )

        result = await job_service_instance._cleanup_stale_orphan_sandbox(
            task_id=5002,
            pod_name="sandbox-5002-zzz",
            inactive_hours=24,
            max_inactive_hours=24 * 7,
            sandbox_payload={"last_activity_at": 0},
        )

    assert result["deleted"] is False
    assert result["skipped"] is True
    assert result["reason"] == "sandbox_not_found"


@pytest.mark.unit
@pytest.mark.asyncio
async def test_cleanup_stale_orphan_sandbox_redis_cleared_but_pod_alive():
    """redis_cleared=True but deleted=False: fallback to direct K8s pod delete."""
    job_service_instance = JobService(Mock())

    with patch(
        "app.services.adapters.executor_job.executor_kinds_service"
    ) as ek_service:
        ek_service.cleanup_sandbox_by_task_id_async = AsyncMock(
            return_value={
                "deleted": False,
                "redis_cleared": True,
                "archived": False,
                "reason": "sandbox_metadata_cleared",
            }
        )
        ek_service.delete_pod_by_name_async = AsyncMock(
            return_value={"status": "success"}
        )

        result = await job_service_instance._cleanup_stale_orphan_sandbox(
            task_id=5003,
            pod_name="sandbox-5003-aaa",
            inactive_hours=24,
            max_inactive_hours=24 * 7,
            sandbox_payload={"last_activity_at": 0},
        )

    assert result["deleted"] is True
    assert result["skipped"] is False
    assert result["reason"] == "pod_deleted"
    ek_service.delete_pod_by_name_async.assert_awaited_once_with("sandbox-5003-aaa")


@pytest.mark.unit
@pytest.mark.asyncio
async def test_cleanup_stale_orphan_sandbox_redis_cleared_fallback_fails():
    """Fallback delete_pod_by_name_async raising leaves pod alive as delete_failed."""
    job_service_instance = JobService(Mock())

    with patch(
        "app.services.adapters.executor_job.executor_kinds_service"
    ) as ek_service:
        ek_service.cleanup_sandbox_by_task_id_async = AsyncMock(
            return_value={
                "deleted": False,
                "redis_cleared": True,
                "archived": False,
                "reason": "sandbox_metadata_cleared",
            }
        )
        ek_service.delete_pod_by_name_async = AsyncMock(
            side_effect=Exception("k8s unreachable")
        )

        result = await job_service_instance._cleanup_stale_orphan_sandbox(
            task_id=5004,
            pod_name="sandbox-5004-bbb",
            inactive_hours=24,
            max_inactive_hours=24 * 7,
            sandbox_payload={"last_activity_at": 0},
        )

    assert result["deleted"] is False
    assert result["skipped"] is False
    assert result["reason"] == "delete_failed"
    assert "k8s_status" not in result


@pytest.mark.unit
@pytest.mark.asyncio
async def test_cleanup_stale_orphan_sandbox_redis_cleared_fallback_not_found():
    """Fallback returning not_found is treated as success (pod already gone)."""
    job_service_instance = JobService(Mock())

    with patch(
        "app.services.adapters.executor_job.executor_kinds_service"
    ) as ek_service:
        ek_service.cleanup_sandbox_by_task_id_async = AsyncMock(
            return_value={
                "deleted": False,
                "redis_cleared": True,
                "archived": False,
                "reason": "sandbox_metadata_cleared",
            }
        )
        ek_service.delete_pod_by_name_async = AsyncMock(
            return_value={"status": "not_found"}
        )

        result = await job_service_instance._cleanup_stale_orphan_sandbox(
            task_id=5005,
            pod_name="sandbox-5005-ccc",
            inactive_hours=24,
            max_inactive_hours=24 * 7,
            sandbox_payload={"last_activity_at": 0},
        )

    assert result["deleted"] is True
    assert result["skipped"] is False
    assert result["reason"] == "pod_deleted"


@pytest.mark.unit
@pytest.mark.asyncio
async def test_cleanup_stale_orphan_executor_fallback_uses_shared_helper():
    """executor_not_found triggers direct pod delete via shared fallback helper."""
    job_service_instance = JobService(Mock())

    with (
        patch.object(
            job_service_instance,
            "cleanup_stale_task_executor",
            new_callable=AsyncMock,
            return_value={
                "task_id": 6000,
                "deleted": False,
                "skipped": False,
                "reason": "executor_not_found",
                "executors": [],
            },
        ),
        patch(
            "app.services.adapters.executor_job.executor_kinds_service"
        ) as ek_service,
    ):
        ek_service.delete_pod_by_name_async = AsyncMock(
            return_value={"status": "success"}
        )

        result = await job_service_instance._cleanup_stale_orphan_executor(
            task_id=6000,
            pod_name="wegent-task-6000-abc",
            inactive_hours=24,
            max_inactive_hours=24 * 7,
            db=AsyncMock(),
        )

    assert result["deleted"] is True
    assert result["skipped"] is False
    assert result["reason"] == "pod_deleted"
    ek_service.delete_pod_by_name_async.assert_awaited_once_with("wegent-task-6000-abc")


@pytest.mark.unit
@pytest.mark.asyncio
async def test_cleanup_stale_orphan_executors_routes_sandbox_to_cleanup_stale_orphan_sandbox():
    """Sandbox-first routing via get_sandbox: sandbox found -> _cleanup_stale_orphan_sandbox."""
    job_service_instance = JobService(Mock())
    old_pods = [
        {"task_id": "6001", "pod_name": "sandbox-6001-abc"},
        {"task_id": "6002", "pod_name": "wegent-task-6002-xyz"},
    ]

    async def fake_get_sandbox(sandbox_id):
        if sandbox_id == "6001":
            return ({"sandbox_id": "6001", "last_activity_at": 0.0}, None)
        return (None, None)

    with (
        patch(
            "wecode.service.executor_job_patch.get_executor_runtime_client"
        ) as mock_get_client,
        patch(
            "app.services.adapters.executor_job.executor_kinds_service"
        ) as executor_service,
        patch.object(
            job_service_instance,
            "_cleanup_stale_orphan_sandbox",
            new_callable=AsyncMock,
            return_value={
                "task_id": 6001,
                "pod_name": "sandbox-6001-abc",
                "deleted": True,
                "skipped": False,
                "reason": "sandbox_deleted",
                "archived": True,
            },
        ) as mock_sandbox_cleanup,
        patch.object(
            job_service_instance,
            "_cleanup_stale_orphan_executor",
            new_callable=AsyncMock,
            return_value={
                "task_id": 6002,
                "pod_name": "wegent-task-6002-xyz",
                "deleted": True,
                "skipped": False,
                "reason": "pod_deleted",
            },
        ) as mock_pod_cleanup,
    ):
        executor_service.get_old_pods_async = AsyncMock(return_value=old_pods)

        mock_runtime_client = Mock()
        mock_runtime_client.get_sandbox = AsyncMock(side_effect=fake_get_sandbox)
        mock_get_client.return_value = mock_runtime_client

        result = await job_service_instance.cleanup_orphan_pods(
            AsyncMock(spec=AsyncSession), older_than_hours=48
        )

    assert result["total_scanned"] == 2
    assert len(result["deleted"]) == 2

    # sandbox pod -> _cleanup_stale_orphan_sandbox (with sandbox_payload)
    mock_sandbox_cleanup.assert_awaited_once_with(
        task_id=6001,
        pod_name="sandbox-6001-abc",
        inactive_hours=24,
        max_inactive_hours=24 * 7,
        sandbox_payload=ANY,
    )
    # executor pod -> _cleanup_stale_orphan_executor
    mock_pod_cleanup.assert_awaited_once_with(
        task_id=6002,
        pod_name="wegent-task-6002-xyz",
        inactive_hours=24,
        max_inactive_hours=24 * 7,
        db=ANY,
    )


@pytest.mark.unit
@pytest.mark.asyncio
async def test_cleanup_stale_orphan_executors_sandbox_lookup_error_falls_back_to_executor():
    """When get_sandbox returns an error, fall back to _cleanup_stale_orphan_executor."""
    job_service_instance = JobService(Mock())
    old_pods = [{"task_id": "8001", "pod_name": "wegent-task-8001-x"}]

    with (
        patch(
            "wecode.service.executor_job_patch.get_executor_runtime_client"
        ) as mock_get_client,
        patch(
            "app.services.adapters.executor_job.executor_kinds_service"
        ) as executor_service,
        patch.object(
            job_service_instance,
            "_cleanup_stale_orphan_executor",
            new_callable=AsyncMock,
            return_value={
                "task_id": 8001,
                "pod_name": "wegent-task-8001-x",
                "deleted": True,
                "skipped": False,
                "reason": "pod_deleted",
            },
        ) as mock_pod,
        patch.object(
            job_service_instance,
            "_cleanup_stale_orphan_sandbox",
            new_callable=AsyncMock,
        ) as mock_sandbox,
    ):
        executor_service.get_old_pods_async = AsyncMock(return_value=old_pods)

        mock_runtime_client = Mock()
        mock_runtime_client.get_sandbox = AsyncMock(
            return_value=(None, "executor_manager unreachable")
        )
        mock_get_client.return_value = mock_runtime_client

        result = await job_service_instance.cleanup_orphan_pods(
            AsyncMock(spec=AsyncSession), older_than_hours=48
        )

    assert len(result["deleted"]) == 1
    assert result["deleted"][0]["task_id"] == 8001
    mock_pod.assert_awaited_once()
    mock_sandbox.assert_not_called()


@pytest.mark.unit
@pytest.mark.asyncio
async def test_cleanup_stale_orphan_sandbox_accepts_payload():
    """_cleanup_stale_orphan_sandbox accepts optional sandbox_payload for API consistency."""
    job_service_instance = JobService(Mock())

    with patch(
        "app.services.adapters.executor_job.executor_kinds_service"
    ) as ek_service:
        ek_service.cleanup_sandbox_by_task_id_async = AsyncMock(
            return_value={
                "deleted": True,
                "redis_cleared": True,
                "archived": True,
                "reason": "sandbox_deleted",
            }
        )

        result = await job_service_instance._cleanup_stale_orphan_sandbox(
            task_id=7000,
            pod_name="sandbox-7000-pay",
            inactive_hours=24,
            max_inactive_hours=24 * 7,
            sandbox_payload={"sandbox_id": "7000", "last_activity_at": 0.0},
        )

    assert result["deleted"] is True
    ek_service.cleanup_sandbox_by_task_id_async.assert_awaited_once_with(
        7000, archive_before_delete=True, delete_on_archive_failure=True
    )


@pytest.mark.unit
@pytest.mark.asyncio
async def test_cleanup_stale_orphan_sandbox_not_stale_skipped():
    """When last_activity_at is within inactive_hours, sandbox is skipped."""
    job_service_instance = JobService(Mock())
    recent_ts = time.time() - 3600  # 1 hour ago

    with patch(
        "app.services.adapters.executor_job.executor_kinds_service"
    ) as ek_service:
        ek_service.cleanup_sandbox_by_task_id_async = AsyncMock()

        result = await job_service_instance._cleanup_stale_orphan_sandbox(
            task_id=7001,
            pod_name="sandbox-7001-stale",
            inactive_hours=24,
            max_inactive_hours=24 * 7,
            sandbox_payload={
                "sandbox_id": "7001",
                "last_activity_at": recent_ts,
            },
        )

    assert result["deleted"] is False
    assert result["skipped"] is True
    assert result["reason"] == "not_stale"
    ek_service.cleanup_sandbox_by_task_id_async.assert_not_called()


@pytest.mark.unit
@pytest.mark.asyncio
async def test_cleanup_stale_orphan_sandbox_within_max_idle_keeps_archive_guard():
    """Idle past inactive_hours but within max_inactive_hours: archive failure must
    not force deletion, so delete_on_archive_failure is False."""
    job_service_instance = JobService(Mock())
    # 25h idle: past inactive_hours (24h) but well within max_inactive_hours (7d).
    stale_ts = time.time() - 25 * 3600

    with patch(
        "app.services.adapters.executor_job.executor_kinds_service"
    ) as ek_service:
        ek_service.cleanup_sandbox_by_task_id_async = AsyncMock(
            return_value={
                "deleted": True,
                "redis_cleared": True,
                "archived": True,
                "reason": "sandbox_deleted",
            }
        )

        result = await job_service_instance._cleanup_stale_orphan_sandbox(
            task_id=7002,
            pod_name="sandbox-7002-idle",
            inactive_hours=24,
            max_inactive_hours=24 * 7,
            sandbox_payload={"last_activity_at": stale_ts},
        )

    assert result["deleted"] is True
    ek_service.cleanup_sandbox_by_task_id_async.assert_awaited_once_with(
        7002, archive_before_delete=True, delete_on_archive_failure=False
    )


@pytest.mark.unit
@pytest.mark.asyncio
async def test_cleanup_orphan_pods_force_deletes_abnormal_pod_when_normal_skips():
    """An abnormal (non-Running) pod skipped by the normal path is force-deleted.

    Even when _cleanup_stale_orphan_executor skips a pod as not_stale, an
    OOMKilled pod is already dead and must be force-deleted by name.
    """
    job_service_instance = JobService(Mock())
    old_pods = [
        {"task_id": "1001", "pod_name": "wegent-task-1001-oom", "status": "OOMKilled"}
    ]

    with (
        patch(
            "wecode.service.executor_job_patch.get_executor_runtime_client"
        ) as mock_get_client,
        patch(
            "app.services.adapters.executor_job.executor_kinds_service"
        ) as executor_service,
        patch.object(
            job_service_instance,
            "_cleanup_stale_orphan_executor",
            new_callable=AsyncMock,
            return_value={
                "task_id": 1001,
                "pod_name": "wegent-task-1001-oom",
                "deleted": False,
                "skipped": True,
                "reason": "not_stale",
            },
        ),
    ):
        executor_service.get_old_pods_async = AsyncMock(return_value=old_pods)
        executor_service.delete_pod_by_name_async = AsyncMock(
            return_value={"status": "success"}
        )

        mock_runtime_client = Mock()
        mock_runtime_client.get_sandbox = AsyncMock(return_value=(None, None))
        mock_get_client.return_value = mock_runtime_client

        result = await job_service_instance.cleanup_orphan_pods(
            AsyncMock(spec=AsyncSession), older_than_hours=48
        )

    assert len(result["deleted"]) == 1
    assert result["deleted"][0]["task_id"] == 1001
    assert result["skipped"] == []
    executor_service.delete_pod_by_name_async.assert_awaited_once_with(
        "wegent-task-1001-oom"
    )


@pytest.mark.unit
@pytest.mark.asyncio
async def test_cleanup_orphan_pods_force_deletes_abnormal_pod_after_cleanup_error():
    """A cleanup exception must not stop an abnormal pod from being force-deleted."""
    job_service_instance = JobService(Mock())
    old_pods = [
        {"task_id": "1002", "pod_name": "wegent-task-1002-err", "status": "Error"}
    ]

    with (
        patch(
            "wecode.service.executor_job_patch.get_executor_runtime_client"
        ) as mock_get_client,
        patch(
            "app.services.adapters.executor_job.executor_kinds_service"
        ) as executor_service,
        patch.object(
            job_service_instance,
            "_cleanup_stale_orphan_executor",
            new_callable=AsyncMock,
            side_effect=Exception("executor_manager unreachable"),
        ),
    ):
        executor_service.get_old_pods_async = AsyncMock(return_value=old_pods)
        executor_service.delete_pod_by_name_async = AsyncMock(
            return_value={"status": "success"}
        )

        mock_runtime_client = Mock()
        mock_runtime_client.get_sandbox = AsyncMock(return_value=(None, None))
        mock_get_client.return_value = mock_runtime_client

        result = await job_service_instance.cleanup_orphan_pods(
            AsyncMock(spec=AsyncSession), older_than_hours=48
        )

    assert len(result["deleted"]) == 1
    assert result["deleted"][0]["task_id"] == 1002
    assert result["failed"] == []
    executor_service.delete_pod_by_name_async.assert_awaited_once_with(
        "wegent-task-1002-err"
    )


@pytest.mark.unit
@pytest.mark.asyncio
async def test_cleanup_orphan_pods_running_pod_not_force_deleted_when_skipped():
    """A healthy Running pod skipped as not_stale must not be force-deleted."""
    job_service_instance = JobService(Mock())
    old_pods = [
        {"task_id": "1003", "pod_name": "wegent-task-1003-run", "status": "Running"}
    ]

    with (
        patch(
            "wecode.service.executor_job_patch.get_executor_runtime_client"
        ) as mock_get_client,
        patch(
            "app.services.adapters.executor_job.executor_kinds_service"
        ) as executor_service,
        patch.object(
            job_service_instance,
            "_cleanup_stale_orphan_executor",
            new_callable=AsyncMock,
            return_value={
                "task_id": 1003,
                "pod_name": "wegent-task-1003-run",
                "deleted": False,
                "skipped": True,
                "reason": "not_stale",
            },
        ),
    ):
        executor_service.get_old_pods_async = AsyncMock(return_value=old_pods)
        executor_service.delete_pod_by_name_async = AsyncMock()

        mock_runtime_client = Mock()
        mock_runtime_client.get_sandbox = AsyncMock(return_value=(None, None))
        mock_get_client.return_value = mock_runtime_client

        result = await job_service_instance.cleanup_orphan_pods(
            AsyncMock(spec=AsyncSession), older_than_hours=48
        )

    assert result["deleted"] == []
    assert len(result["skipped"]) == 1
    assert result["skipped"][0]["reason"] == "not_stale"
    executor_service.delete_pod_by_name_async.assert_not_called()


@pytest.mark.unit
@pytest.mark.parametrize(
    "pod_info, expected",
    [
        # Empty / missing / whitespace status must NOT be treated as abnormal:
        # an unknown status is not evidence the pod is dead, and force-deleting
        # would risk killing an active (not_stale) pod.
        ({"status": ""}, False),
        ({"status": "   "}, False),
        ({"status": None}, False),
        ({}, False),
        # Running is healthy.
        ({"status": "Running"}, False),
        # Any known non-Running status is abnormal.
        ({"status": "OOMKilled"}, True),
        ({"status": "Error"}, True),
        ({"status": "CrashLoopBackOff"}, True),
        ({"status": "Unknown"}, True),
    ],
)
def test_pod_is_abnormal(pod_info, expected):
    assert _pod_is_abnormal(pod_info) is expected
