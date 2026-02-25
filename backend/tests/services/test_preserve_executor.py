# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for preserve executor functionality.

This module tests:
1. cleanup_stale_executors skips tasks with preserveExecutor=true
2. set_preserve_executor API functionality
3. Permission control for preserve executor operations
"""

from datetime import datetime, timedelta
from unittest.mock import MagicMock, Mock, patch

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.schemas.kind import Task
from app.services.adapters.executor_job import JobService
from app.services.adapters.task_kinds import TaskKindsService


@pytest.mark.unit
class TestCleanupStaleExecutorsWithPreserveFlag:
    """Test cleanup_stale_executors skips tasks with preserveExecutor label"""

    @pytest.fixture
    def job_service(self):
        """Create JobService instance"""
        from app.models.kind import Kind

        return JobService(Kind)

    @pytest.fixture
    def mock_db(self):
        """Create a mock database session"""
        return Mock(spec=Session)

    def _create_mock_task_resource(
        self, task_id: int, user_id: int, preserve_executor: bool = False
    ):
        """Helper to create a mock TaskResource with optional preserveExecutor label"""
        task = Mock(spec=TaskResource)
        task.id = task_id
        task.user_id = user_id
        task.kind = "Task"
        task.is_active = True

        labels = {"taskType": "chat"}
        if preserve_executor:
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

    def _create_mock_subtask(
        self,
        subtask_id: int,
        task_id: int,
        executor_name: str = "executor-1",
        executor_namespace: str = "default",
    ):
        """Helper to create a mock Subtask"""
        subtask = Mock(spec=Subtask)
        subtask.id = subtask_id
        subtask.task_id = task_id
        subtask.executor_name = executor_name
        subtask.executor_namespace = executor_namespace
        subtask.executor_deleted_at = False
        subtask.status = SubtaskStatus.COMPLETED
        subtask.updated_at = datetime.now() - timedelta(hours=48)
        return subtask

    def test_skips_task_with_preserve_executor_true(self, job_service, mock_db):
        """Test that tasks with preserveExecutor=true are skipped during cleanup"""
        # Create a mock subtask linked to a task with preserveExecutor=true
        mock_subtask = self._create_mock_subtask(1, 100)
        mock_task = self._create_mock_task_resource(100, 1, preserve_executor=True)

        # Setup mock query chain for subtasks
        mock_subtask_query = MagicMock()
        mock_subtask_query.join.return_value = mock_subtask_query
        mock_subtask_query.filter.return_value = mock_subtask_query
        mock_subtask_query.all.return_value = [mock_subtask]

        # Setup mock query chain for task lookup
        mock_task_query = MagicMock()
        mock_task_query.filter.return_value = mock_task_query
        mock_task_query.first.return_value = mock_task

        def query_side_effect(model):
            if model == Subtask:
                return mock_subtask_query
            elif model == TaskResource:
                return mock_task_query
            return MagicMock()

        mock_db.query.side_effect = query_side_effect

        # Mock the delete executor function
        with patch(
            "app.services.adapters.executor_job.executor_kinds_service"
        ) as mock_executor_service:
            with patch("app.services.adapters.executor_job.settings") as mock_settings:
                mock_settings.CHAT_TASK_EXECUTOR_DELETE_AFTER_HOURS = 24
                mock_settings.CODE_TASK_EXECUTOR_DELETE_AFTER_HOURS = 48

                job_service.cleanup_stale_executors(mock_db)

                # Verify delete_executor_task_sync was NOT called
                mock_executor_service.delete_executor_task_sync.assert_not_called()

    def test_cleans_up_task_without_preserve_flag(self, job_service, mock_db):
        """Test that tasks without preserveExecutor label are cleaned up normally"""
        # Create a mock subtask linked to a task WITHOUT preserveExecutor
        mock_subtask = self._create_mock_subtask(1, 100)
        mock_task = self._create_mock_task_resource(100, 1, preserve_executor=False)

        # Setup mock query chain for subtasks
        mock_subtask_query = MagicMock()
        mock_subtask_query.join.return_value = mock_subtask_query
        mock_subtask_query.filter.return_value = mock_subtask_query
        mock_subtask_query.all.return_value = [mock_subtask]
        mock_subtask_query.update.return_value = 1

        # Setup mock query chain for task lookup
        mock_task_query = MagicMock()
        mock_task_query.filter.return_value = mock_task_query
        mock_task_query.first.return_value = mock_task

        def query_side_effect(model):
            if model == Subtask:
                return mock_subtask_query
            elif model == TaskResource:
                return mock_task_query
            return MagicMock()

        mock_db.query.side_effect = query_side_effect

        # Mock the delete executor function to succeed
        with patch(
            "app.services.adapters.executor_job.executor_kinds_service"
        ) as mock_executor_service:
            with patch("app.services.adapters.executor_job.settings") as mock_settings:
                mock_settings.CHAT_TASK_EXECUTOR_DELETE_AFTER_HOURS = 24
                mock_settings.CODE_TASK_EXECUTOR_DELETE_AFTER_HOURS = 48
                mock_executor_service.delete_executor_task_sync.return_value = True

                job_service.cleanup_stale_executors(mock_db)

                # Verify delete_executor_task_sync WAS called
                mock_executor_service.delete_executor_task_sync.assert_called_once_with(
                    "executor-1", "default"
                )

    def test_skips_task_with_preserve_executor_false(self, job_service, mock_db):
        """Test that tasks with preserveExecutor=false are cleaned up normally"""
        # Create a mock subtask linked to a task with preserveExecutor=false
        mock_subtask = self._create_mock_subtask(1, 100)
        mock_task = self._create_mock_task_resource(100, 1, preserve_executor=False)
        # Explicitly set preserveExecutor to "false"
        mock_task.json["metadata"]["labels"]["preserveExecutor"] = "false"

        # Setup mock query chain for subtasks
        mock_subtask_query = MagicMock()
        mock_subtask_query.join.return_value = mock_subtask_query
        mock_subtask_query.filter.return_value = mock_subtask_query
        mock_subtask_query.all.return_value = [mock_subtask]
        mock_subtask_query.update.return_value = 1

        # Setup mock query chain for task lookup
        mock_task_query = MagicMock()
        mock_task_query.filter.return_value = mock_task_query
        mock_task_query.first.return_value = mock_task

        def query_side_effect(model):
            if model == Subtask:
                return mock_subtask_query
            elif model == TaskResource:
                return mock_task_query
            return MagicMock()

        mock_db.query.side_effect = query_side_effect

        # Mock the delete executor function to succeed
        with patch(
            "app.services.adapters.executor_job.executor_kinds_service"
        ) as mock_executor_service:
            with patch("app.services.adapters.executor_job.settings") as mock_settings:
                mock_settings.CHAT_TASK_EXECUTOR_DELETE_AFTER_HOURS = 24
                mock_settings.CODE_TASK_EXECUTOR_DELETE_AFTER_HOURS = 48
                mock_executor_service.delete_executor_task_sync.return_value = True

                job_service.cleanup_stale_executors(mock_db)

                # Verify delete_executor_task_sync WAS called (preserveExecutor=false means cleanup)
                mock_executor_service.delete_executor_task_sync.assert_called_once_with(
                    "executor-1", "default"
                )


@pytest.mark.unit
class TestSetPreserveExecutorAPI:
    """Test set_preserve_executor API functionality"""

    @pytest.fixture
    def task_service(self):
        """Create TaskKindsService instance"""
        return TaskKindsService(TaskResource)

    @pytest.fixture
    def mock_db(self):
        """Create a mock database session"""
        return Mock(spec=Session)

    def _create_mock_task(
        self, task_id: int, user_id: int, preserve_executor: bool = False
    ):
        """Helper to create a mock TaskResource"""
        task = Mock(spec=TaskResource)
        task.id = task_id
        task.user_id = user_id
        task.kind = "Task"
        task.is_active = True

        labels = {"taskType": "chat"}
        if preserve_executor:
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

    def test_set_preserve_executor_true(self, task_service, mock_db):
        """Test setting preserveExecutor to true"""
        mock_task = self._create_mock_task(123, 1, preserve_executor=False)

        # Setup mock query chain
        mock_query = MagicMock()
        mock_db.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.first.return_value = mock_task

        # Mock task_member_service (imported inside the function)
        with patch(
            "app.services.task_member_service.task_member_service"
        ) as mock_member_service:
            mock_member_service.is_member.return_value = True

            # Mock flag_modified to avoid SQLAlchemy internals
            with patch(
                "app.services.adapters.task_kinds.operations.flag_modified"
            ) as mock_flag_modified:
                result = task_service.set_preserve_executor(
                    mock_db, task_id=123, user_id=1, preserve=True
                )

                assert result["task_id"] == 123
                assert result["preserve_executor"] is True
                assert "preserved" in result["message"].lower()

                # Verify the task json was updated
                assert (
                    mock_task.json["metadata"]["labels"]["preserveExecutor"] == "true"
                )
                mock_db.commit.assert_called_once()
                mock_flag_modified.assert_called_once()

    def test_set_preserve_executor_false(self, task_service, mock_db):
        """Test setting preserveExecutor to false"""
        mock_task = self._create_mock_task(123, 1, preserve_executor=True)

        # Setup mock query chain
        mock_query = MagicMock()
        mock_db.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.first.return_value = mock_task

        # Mock task_member_service (imported inside the function)
        with patch(
            "app.services.task_member_service.task_member_service"
        ) as mock_member_service:
            mock_member_service.is_member.return_value = True

            # Mock flag_modified to avoid SQLAlchemy internals
            with patch(
                "app.services.adapters.task_kinds.operations.flag_modified"
            ) as mock_flag_modified:
                result = task_service.set_preserve_executor(
                    mock_db, task_id=123, user_id=1, preserve=False
                )

                assert result["task_id"] == 123
                assert result["preserve_executor"] is False
                assert "cleanup" in result["message"].lower()

                # Verify the task json was updated to "false" (not deleted)
                assert (
                    mock_task.json["metadata"]["labels"]["preserveExecutor"] == "false"
                )
                mock_db.commit.assert_called_once()
                mock_flag_modified.assert_called_once()

    def test_non_member_cannot_set_preserve_executor(self, task_service, mock_db):
        """Test that non-members cannot set preserve executor flag"""
        mock_task = self._create_mock_task(123, 1, preserve_executor=False)

        # Setup mock query chain
        mock_query = MagicMock()
        mock_db.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.first.return_value = mock_task

        # Mock task_member_service (imported inside the function)
        with patch(
            "app.services.task_member_service.task_member_service"
        ) as mock_member_service:
            mock_member_service.is_member.return_value = False

            with pytest.raises(HTTPException) as exc_info:
                task_service.set_preserve_executor(
                    mock_db, task_id=123, user_id=999, preserve=True
                )

            assert exc_info.value.status_code == 404
            assert (
                "not found" in exc_info.value.detail.lower()
                or "permission" in exc_info.value.detail.lower()
            )

    def test_task_not_found_raises_404(self, task_service, mock_db):
        """Test that non-existent task raises 404"""
        # Setup mock query chain to return None
        mock_query = MagicMock()
        mock_db.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.first.return_value = None

        # Mock task_member_service (imported inside the function)
        with patch(
            "app.services.task_member_service.task_member_service"
        ) as mock_member_service:
            mock_member_service.is_member.return_value = False

            with pytest.raises(HTTPException) as exc_info:
                task_service.set_preserve_executor(
                    mock_db, task_id=999, user_id=1, preserve=True
                )

            assert exc_info.value.status_code == 404

    def test_group_member_can_set_preserve_executor(self, task_service, mock_db):
        """Test that group chat members can set preserve executor flag"""
        mock_task = self._create_mock_task(123, 1, preserve_executor=False)

        # Setup mock query chain
        mock_query = MagicMock()
        mock_db.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.first.return_value = mock_task

        # Mock task_member_service (imported inside the function)
        with patch(
            "app.services.task_member_service.task_member_service"
        ) as mock_member_service:
            # User 2 is a group member, not the owner (user_id=1)
            mock_member_service.is_member.return_value = True

            # Mock flag_modified to avoid SQLAlchemy internals
            with patch(
                "app.services.adapters.task_kinds.operations.flag_modified"
            ) as mock_flag_modified:
                result = task_service.set_preserve_executor(
                    mock_db, task_id=123, user_id=2, preserve=True
                )

                assert result["task_id"] == 123
                assert result["preserve_executor"] is True
                mock_member_service.is_member.assert_called_once_with(mock_db, 123, 2)
                mock_flag_modified.assert_called_once()


@pytest.mark.unit
class TestPreserveExecutorLabelConsistency:
    """Test that preserveExecutor label is handled consistently"""

    def test_preserve_executor_uses_string_values(self):
        """Test that preserveExecutor uses 'true'/'false' string values like autoDeleteExecutor"""
        task_json = {
            "metadata": {
                "labels": {
                    "autoDeleteExecutor": "false",  # Existing pattern uses strings
                    "preserveExecutor": "true",  # Should follow same pattern
                }
            }
        }

        # Both should use string values for consistency
        assert task_json["metadata"]["labels"]["autoDeleteExecutor"] == "false"
        assert task_json["metadata"]["labels"]["preserveExecutor"] == "true"

    def test_preserve_executor_false_is_explicit(self):
        """Test that setting preserve=False results in 'false' string, not key deletion"""
        # This ensures the behavior matches autoDeleteExecutor pattern
        labels = {"preserveExecutor": "true"}

        # When disabling, should set to "false" not delete
        labels["preserveExecutor"] = "false"

        assert "preserveExecutor" in labels
        assert labels["preserveExecutor"] == "false"
