# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for persisted executor cleanup progress and lookback scanning."""

import logging
from contextlib import contextmanager
from datetime import datetime, timedelta
from unittest.mock import AsyncMock, Mock, patch

import pytest

from app.models.kind import Kind
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.services.adapters.executor_job import JobService
from app.services.executor_cleanup_cursor_service import (
    executor_cleanup_cursor_service,
)


@contextmanager
def _patched_cleanup_settings():
    with patch("app.services.adapters.executor_job.settings") as mock_settings:
        mock_settings.CHAT_TASK_EXECUTOR_DELETE_AFTER_HOURS = 24
        mock_settings.CODE_TASK_EXECUTOR_DELETE_AFTER_HOURS = 48
        mock_settings.STALE_NON_TERMINAL_TASK_EXECUTOR_DELETE_AFTER_HOURS = 24
        mock_settings.TASK_EXECUTOR_CLEANUP_PRIMARY_SCAN_BATCH_SIZE = 2000
        mock_settings.TASK_EXECUTOR_CLEANUP_LOOKBACK_HOURS = 48
        mock_settings.TASK_EXECUTOR_CLEANUP_LOOKBACK_SCAN_LIMIT = 500
        yield mock_settings


def _create_mock_task(task_id: int) -> TaskResource:
    task = Mock(spec=TaskResource)
    task.id = task_id
    task.user_id = 1
    task.kind = "Task"
    task.is_active = True
    task.updated_at = datetime.now() - timedelta(hours=48)
    task.json = {
        "kind": "Task",
        "apiVersion": "agent.wecode.io/v1",
        "metadata": {
            "name": f"task-{task_id}",
            "namespace": "default",
            "labels": {"taskType": "chat"},
        },
        "spec": {
            "title": "Test Task",
            "prompt": "Test prompt",
            "teamRef": {"name": "test-team", "namespace": "default"},
            "workspaceRef": {"name": "workspace-1", "namespace": "default"},
        },
        "status": {
            "status": "COMPLETED",
            "progress": 100,
            "createdAt": datetime.now().isoformat(),
            "updatedAt": datetime.now().isoformat(),
        },
    }
    return task


def _create_mock_subtask(subtask_id: int, task_id: int) -> Subtask:
    subtask = Mock(spec=Subtask)
    subtask.id = subtask_id
    subtask.task_id = task_id
    subtask.executor_name = f"executor-{subtask_id}"
    subtask.executor_namespace = "default"
    subtask.executor_deleted_at = False
    subtask.status = SubtaskStatus.COMPLETED
    subtask.updated_at = datetime.now() - timedelta(hours=36)
    return subtask


@pytest.mark.unit
class TestExecutorCleanupProgress:
    @pytest.fixture
    def job_service(self):
        return JobService(Kind)

    async def test_cleanup_uses_persisted_cursor_for_primary_scan(
        self, job_service, test_db
    ):
        """Test cleanup resumes primary scanning from the persisted cursor."""
        with (
            patch(
                "app.services.executor_cleanup_cursor_service.cache_manager"
            ) as mock_cache,
            _patched_cleanup_settings(),
            patch.object(
                job_service,
                "_scan_candidate_subtasks_batch",
                new_callable=AsyncMock,
                return_value=[],
            ) as scan_primary,
            patch.object(
                job_service,
                "_scan_lookback_subtasks_batch",
                new_callable=AsyncMock,
                return_value=[],
                create=True,
            ),
        ):
            mock_cache.get = AsyncMock(
                return_value={
                    "last_scanned_subtask_id": 123,
                    "updated_at": datetime.now().isoformat(),
                }
            )
            mock_cache.set = AsyncMock(return_value=True)

            await job_service.cleanup_stale_executors(test_db)

        assert scan_primary.call_args.kwargs["last_id"] == 123

    async def test_cursor_prefers_redis_value_when_available(self, test_db):
        """Test cursor reads the latest persisted value from Redis first."""
        with patch(
            "app.services.executor_cleanup_cursor_service.cache_manager"
        ) as mock_cache:
            mock_cache.get = AsyncMock(
                return_value={
                    "last_scanned_subtask_id": 789,
                    "updated_at": datetime.now().isoformat(),
                }
            )

            cursor = await executor_cleanup_cursor_service.get_cursor(test_db)

        assert cursor.last_scanned_subtask_id == 789

    async def test_cursor_defaults_to_recent_week_start_when_uninitialized(
        self, async_test_db
    ):
        """Test an uninitialized cursor starts from the earliest subtask created in the last week."""
        old_subtask = Subtask(
            user_id=1,
            task_id=1,
            team_id=1,
            title="old-subtask",
            bot_ids=[1],
            role=SubtaskRole.ASSISTANT,
            status=SubtaskStatus.COMPLETED,
            created_at=datetime.now() - timedelta(days=10),
            updated_at=datetime.now() - timedelta(days=6),
            completed_at=datetime.now() - timedelta(days=10),
        )
        recent_subtask = Subtask(
            user_id=1,
            task_id=1,
            team_id=1,
            title="recent-subtask",
            bot_ids=[1],
            role=SubtaskRole.ASSISTANT,
            status=SubtaskStatus.COMPLETED,
            created_at=datetime.now() - timedelta(days=3),
            updated_at=datetime.now() - timedelta(days=1),
            completed_at=datetime.now() - timedelta(days=3),
        )
        async_test_db.add_all([old_subtask, recent_subtask])
        await async_test_db.commit()
        await async_test_db.refresh(recent_subtask)

        with patch(
            "app.services.executor_cleanup_cursor_service.cache_manager"
        ) as mock_cache:
            mock_cache.get = AsyncMock(return_value=None)
            mock_cache.set = AsyncMock(return_value=True)

            cursor = await executor_cleanup_cursor_service.get_cursor(async_test_db)

        assert cursor.last_scanned_subtask_id == recent_subtask.id - 1
        assert mock_cache.set.call_args.args[0] == "executor_cleanup_cursor"

    async def test_advance_cursor_writes_value_to_redis(self, test_db):
        """Test advancing the cursor stores the latest value in Redis."""
        with patch(
            "app.services.executor_cleanup_cursor_service.cache_manager"
        ) as mock_cache:
            mock_cache.get = AsyncMock(return_value=None)
            mock_cache.set = AsyncMock(return_value=True)

            await executor_cleanup_cursor_service.advance_cursor(
                test_db,
                last_scanned_subtask_id=321,
            )

        mock_cache.set.assert_called_once()
        assert mock_cache.set.call_args.args[0] == "executor_cleanup_cursor"
        assert mock_cache.set.call_args.args[1]["last_scanned_subtask_id"] == 321

    async def test_cleanup_keeps_cursor_position_when_primary_scan_reaches_tail(
        self, job_service, test_db
    ):
        """Test cleanup keeps the Redis cursor position after scanning the tail."""
        with (
            patch(
                "app.services.executor_cleanup_cursor_service.cache_manager"
            ) as mock_cache,
            _patched_cleanup_settings(),
            patch.object(
                job_service,
                "_scan_candidate_subtasks_batch",
                new_callable=AsyncMock,
                return_value=[],
            ),
            patch.object(
                job_service,
                "_scan_lookback_subtasks_batch",
                new_callable=AsyncMock,
                return_value=[],
                create=True,
            ),
        ):
            mock_cache.get = AsyncMock(
                return_value={
                    "last_scanned_subtask_id": 456,
                    "updated_at": datetime.now().isoformat(),
                }
            )
            mock_cache.set = AsyncMock(return_value=True)

            await job_service.cleanup_stale_executors(test_db)

        mock_cache.set.assert_not_called()

    async def test_cleanup_uses_lookback_scan_when_primary_scan_is_empty(
        self, job_service, test_db
    ):
        """Test cleanup falls back to lookback scanning when no new primary rows exist."""
        subtask = _create_mock_subtask(12, 100)
        task = _create_mock_task(100)

        with (
            patch(
                "app.services.executor_cleanup_cursor_service.cache_manager"
            ) as mock_cache,
            _patched_cleanup_settings(),
            patch.object(
                job_service,
                "_scan_candidate_subtasks_batch",
                new_callable=AsyncMock,
                return_value=[],
            ),
            patch.object(
                job_service,
                "_scan_lookback_subtasks_batch",
                new_callable=AsyncMock,
                return_value=[subtask],
                create=True,
            ) as scan_lookback,
            patch.object(
                job_service,
                "_load_tasks_for_cleanup",
                new_callable=AsyncMock,
                return_value={100: task},
            ),
            patch.object(
                job_service,
                "_get_cleanup_subtasks_for_task",
                new_callable=AsyncMock,
                return_value=[subtask],
            ),
            patch(
                "app.services.adapters.executor_job.executor_kinds_service"
            ) as mock_executor_service,
        ):
            mock_cache.get = AsyncMock(
                return_value={
                    "last_scanned_subtask_id": 123,
                    "updated_at": datetime.now().isoformat(),
                }
            )
            mock_cache.set = AsyncMock(return_value=True)
            mock_executor_service.delete_executor_task_async = AsyncMock(
                return_value={"status": "success"}
            )

            await job_service.cleanup_stale_executors(test_db)

        assert scan_lookback.called
        mock_executor_service.delete_executor_task_async.assert_called_once_with(
            "executor-12", "default"
        )

    async def test_lookback_scan_uses_created_at_window_and_defers_updated_at_cutoff(
        self, job_service, async_test_db
    ):
        """Test lookback scanning uses created_at while Python keeps updated_at cutoff filtering."""
        now = datetime.now()
        lookback_start = now - timedelta(hours=48)
        cutoff = now - timedelta(hours=24)

        included_stale = Subtask(
            user_id=1,
            task_id=1,
            team_id=1,
            title="included-stale",
            bot_ids=[1],
            role=SubtaskRole.ASSISTANT,
            executor_name="executor-stale",
            executor_namespace="default",
            executor_deleted_at=False,
            status=SubtaskStatus.COMPLETED,
            created_at=now - timedelta(hours=36),
            updated_at=now - timedelta(hours=72),
            completed_at=now - timedelta(hours=36),
        )
        deferred_recent = Subtask(
            user_id=1,
            task_id=1,
            team_id=1,
            title="deferred-recent",
            bot_ids=[1],
            role=SubtaskRole.ASSISTANT,
            executor_name="executor-recent",
            executor_namespace="default",
            executor_deleted_at=False,
            status=SubtaskStatus.COMPLETED,
            created_at=now - timedelta(hours=30),
            updated_at=now - timedelta(hours=12),
            completed_at=now - timedelta(hours=30),
        )
        excluded_old_created = Subtask(
            user_id=1,
            task_id=1,
            team_id=1,
            title="excluded-old-created",
            bot_ids=[1],
            role=SubtaskRole.ASSISTANT,
            executor_name="executor-old-created",
            executor_namespace="default",
            executor_deleted_at=False,
            status=SubtaskStatus.COMPLETED,
            created_at=now - timedelta(hours=72),
            updated_at=now - timedelta(hours=36),
            completed_at=now - timedelta(hours=72),
        )

        async_test_db.add_all([included_stale, deferred_recent, excluded_old_created])
        await async_test_db.commit()

        scanned = await job_service._scan_lookback_subtasks_batch(
            async_test_db,
            lookback_start=lookback_start,
            cutoff=cutoff,
            limit=10,
        )
        scanned_ids = {subtask.id for subtask in scanned}

        assert included_stale.id in scanned_ids
        assert deferred_recent.id in scanned_ids
        assert excluded_old_created.id not in scanned_ids

        filtered = job_service._filter_scanned_subtasks(scanned, chat_cutoff=cutoff)
        filtered_ids = {subtask.id for subtask in filtered}

        assert included_stale.id in filtered_ids
        assert deferred_recent.id not in filtered_ids

    async def test_cleanup_logs_lookback_by_created_at_when_primary_scan_is_empty(
        self, job_service, test_db, caplog
    ):
        """Test cleanup logs the lookback scan mode explicitly."""
        with (
            patch(
                "app.services.executor_cleanup_cursor_service.cache_manager"
            ) as mock_cache,
            _patched_cleanup_settings(),
            patch.object(
                job_service,
                "_scan_candidate_subtasks_batch",
                new_callable=AsyncMock,
                return_value=[],
            ),
            patch.object(
                job_service,
                "_scan_lookback_subtasks_batch",
                new_callable=AsyncMock,
                return_value=[],
                create=True,
            ),
            caplog.at_level(logging.INFO, logger="app.services.adapters.executor_job"),
        ):
            mock_cache.get = AsyncMock(
                return_value={
                    "last_scanned_subtask_id": 123,
                    "updated_at": datetime.now().isoformat(),
                }
            )
            mock_cache.set = AsyncMock(return_value=True)

            await job_service.cleanup_stale_executors(test_db)

        assert "lookback_by=created_at" in caplog.text
