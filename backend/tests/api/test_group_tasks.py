# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from unittest.mock import MagicMock, Mock, patch

import pytest
from sqlalchemy.orm import Session

from app.models.task import TaskResource
from app.services.adapters.task_kinds import TaskKindsService


@pytest.mark.unit
class TestGetUserGroupTasksLite:
    """Test get_user_group_tasks_lite method in TaskKindsService"""

    @pytest.fixture
    def mock_db(self):
        """Create a mock database session"""
        return Mock(spec=Session)

    @pytest.fixture
    def task_service(self):
        """Create TaskKindsService instance"""
        return TaskKindsService(TaskResource)

    @pytest.fixture
    def mock_group_task(self):
        """Create a mock group chat task"""
        task = Mock(spec=TaskResource)
        task.id = 123
        task.user_id = 1
        task.kind = "Task"
        task.is_active = True
        task.created_at = datetime.now()
        task.updated_at = datetime.now()
        task.json = {
            "kind": "Task",
            "spec": {
                "title": "Group Chat Task",
                "prompt": "Test prompt",
                "is_group_chat": True,
                "teamRef": {"name": "test-team", "namespace": "default"},
                "workspaceRef": {"name": "workspace-123", "namespace": "default"},
            },
            "status": {
                "status": "COMPLETED",
                "progress": 100,
                "createdAt": datetime.now().isoformat(),
                "updatedAt": datetime.now().isoformat(),
            },
            "metadata": {
                "name": "task-123",
                "namespace": "default",
                "labels": {"taskType": "chat", "type": "online"},
            },
            "apiVersion": "agent.wecode.io/v1",
        }
        return task

    @pytest.fixture
    def mock_single_chat_task(self):
        """Create a mock single chat task (not group chat)"""
        task = Mock(spec=TaskResource)
        task.id = 456
        task.user_id = 1
        task.kind = "Task"
        task.is_active = True
        task.created_at = datetime.now()
        task.updated_at = datetime.now()
        task.json = {
            "kind": "Task",
            "spec": {
                "title": "Single Chat Task",
                "prompt": "Test prompt",
                "is_group_chat": False,
                "teamRef": {"name": "test-team", "namespace": "default"},
                "workspaceRef": {"name": "workspace-456", "namespace": "default"},
            },
            "status": {
                "status": "COMPLETED",
                "progress": 100,
                "createdAt": datetime.now().isoformat(),
                "updatedAt": datetime.now().isoformat(),
            },
            "metadata": {
                "name": "task-456",
                "namespace": "default",
                "labels": {"taskType": "chat", "type": "online"},
            },
            "apiVersion": "agent.wecode.io/v1",
        }
        return task

    def test_returns_group_chat_tasks(self, task_service, mock_db, mock_group_task):
        """Test that the method returns group chat tasks"""
        # Mock database execute for count query
        mock_count_result = Mock()
        mock_count_result.scalar.return_value = 1

        # Mock database execute for IDs query
        mock_ids_result = Mock()
        mock_ids_result.fetchall.return_value = [(123, datetime.now())]

        # Set up execute to return different results for different queries
        def execute_side_effect(sql, params=None):
            sql_str = str(sql) if hasattr(sql, "__str__") else ""
            if "COUNT" in sql_str:
                return mock_count_result
            elif "SELECT DISTINCT" in sql_str:
                return mock_ids_result
            elif "SELECT id FROM kinds" in sql_str:
                result = Mock()
                result.fetchone.return_value = (1,)  # team_id
                return result
            elif "JSON_EXTRACT" in sql_str:
                result = Mock()
                result.fetchone.return_value = ('"test-repo"',)  # git_repo
                return result
            return Mock()

        mock_db.execute.side_effect = execute_side_effect

        # Mock query for tasks
        mock_query = MagicMock()
        mock_db.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.group_by.return_value = mock_query
        mock_query.all.return_value = [mock_group_task]

        # Call the method
        result, total = task_service.get_user_group_tasks_lite(
            mock_db, user_id=1, skip=0, limit=10
        )

        # Verify results
        assert total == 1
        assert len(result) == 1
        assert result[0]["id"] == 123
        assert result[0]["is_group_chat"] is True
        assert result[0]["title"] == "Group Chat Task"

    def test_excludes_single_chat_tasks(
        self, task_service, mock_db, mock_single_chat_task
    ):
        """Test that single chat tasks (is_group_chat=false and no members) are not returned"""
        # Mock database execute for count query - returns 0 for single chat
        mock_count_result = Mock()
        mock_count_result.scalar.return_value = 0

        # Mock database execute for IDs query - returns empty
        mock_ids_result = Mock()
        mock_ids_result.fetchall.return_value = []

        def execute_side_effect(sql, params=None):
            sql_str = str(sql) if hasattr(sql, "__str__") else ""
            if "COUNT" in sql_str:
                return mock_count_result
            elif "SELECT DISTINCT" in sql_str:
                return mock_ids_result
            return Mock()

        mock_db.execute.side_effect = execute_side_effect

        # Call the method
        result, total = task_service.get_user_group_tasks_lite(
            mock_db, user_id=1, skip=0, limit=10
        )

        # Verify results - should be empty since no group chats
        assert total == 0
        assert len(result) == 0

    def test_pagination_works_correctly(self, task_service, mock_db, mock_group_task):
        """Test that pagination parameters work correctly"""
        # Mock database execute for count query
        mock_count_result = Mock()
        mock_count_result.scalar.return_value = 25  # Total 25 items

        # Mock database execute for IDs query
        mock_ids_result = Mock()
        mock_ids_result.fetchall.return_value = [(123, datetime.now())]

        def execute_side_effect(sql, params=None):
            sql_str = str(sql) if hasattr(sql, "__str__") else ""
            if "COUNT" in sql_str:
                return mock_count_result
            elif "SELECT DISTINCT" in sql_str:
                # Verify pagination params are passed
                if params:
                    assert params.get("skip") == 10  # page 2, limit 10
                    assert params.get("limit") == 60  # limit + 50
                return mock_ids_result
            elif "SELECT id FROM kinds" in sql_str:
                result = Mock()
                result.fetchone.return_value = (1,)
                return result
            elif "JSON_EXTRACT" in sql_str:
                result = Mock()
                result.fetchone.return_value = ('"test-repo"',)
                return result
            return Mock()

        mock_db.execute.side_effect = execute_side_effect

        # Mock query for tasks
        mock_query = MagicMock()
        mock_db.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.group_by.return_value = mock_query
        mock_query.all.return_value = [mock_group_task]

        # Call with page 2, limit 10 (skip=10)
        result, total = task_service.get_user_group_tasks_lite(
            mock_db, user_id=1, skip=10, limit=10
        )

        # Verify total is from database
        assert total == 25

    def test_excludes_delete_status_tasks(self, task_service, mock_db):
        """Test that DELETE status tasks are not returned"""
        # Create a deleted task
        deleted_task = Mock(spec=TaskResource)
        deleted_task.id = 789
        deleted_task.user_id = 1
        deleted_task.kind = "Task"
        deleted_task.is_active = True
        deleted_task.created_at = datetime.now()
        deleted_task.updated_at = datetime.now()
        deleted_task.json = {
            "kind": "Task",
            "spec": {
                "title": "Deleted Group Chat",
                "prompt": "Test prompt",
                "is_group_chat": True,
                "teamRef": {"name": "test-team", "namespace": "default"},
                "workspaceRef": {"name": "workspace-789", "namespace": "default"},
            },
            "status": {
                "status": "DELETE",  # DELETE status
                "progress": 0,
            },
            "metadata": {
                "name": "task-789",
                "namespace": "default",
                "labels": {"taskType": "chat", "type": "online"},
            },
            "apiVersion": "agent.wecode.io/v1",
        }

        # Mock database execute
        mock_count_result = Mock()
        mock_count_result.scalar.return_value = 1

        mock_ids_result = Mock()
        mock_ids_result.fetchall.return_value = [(789, datetime.now())]

        def execute_side_effect(sql, params=None):
            sql_str = str(sql) if hasattr(sql, "__str__") else ""
            if "COUNT" in sql_str:
                return mock_count_result
            elif "SELECT DISTINCT" in sql_str:
                return mock_ids_result
            return Mock()

        mock_db.execute.side_effect = execute_side_effect

        # Mock query for tasks
        mock_query = MagicMock()
        mock_db.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.group_by.return_value = mock_query
        mock_query.all.return_value = [deleted_task]

        # Call the method
        result, total = task_service.get_user_group_tasks_lite(
            mock_db, user_id=1, skip=0, limit=10
        )

        # Verify DELETE status task is filtered out
        assert len(result) == 0

    def test_user_sees_only_participated_group_chats(
        self, task_service, mock_db, mock_group_task
    ):
        """Test that user only sees group chats they own or are members of"""
        # Mock database execute - the SQL already filters by user ownership or membership
        mock_count_result = Mock()
        mock_count_result.scalar.return_value = 1

        mock_ids_result = Mock()
        mock_ids_result.fetchall.return_value = [(123, datetime.now())]

        def execute_side_effect(sql, params=None):
            sql_str = str(sql) if hasattr(sql, "__str__") else ""
            if "COUNT" in sql_str:
                # Verify the SQL includes user filter
                assert params.get("user_id") == 1
                return mock_count_result
            elif "SELECT DISTINCT" in sql_str:
                assert params.get("user_id") == 1
                return mock_ids_result
            elif "SELECT id FROM kinds" in sql_str:
                result = Mock()
                result.fetchone.return_value = (1,)
                return result
            elif "JSON_EXTRACT" in sql_str:
                result = Mock()
                result.fetchone.return_value = ('"test-repo"',)
                return result
            return Mock()

        mock_db.execute.side_effect = execute_side_effect

        # Mock query for tasks
        mock_query = MagicMock()
        mock_db.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.group_by.return_value = mock_query
        mock_query.all.return_value = [mock_group_task]

        # Call with user_id=1
        result, total = task_service.get_user_group_tasks_lite(
            mock_db, user_id=1, skip=0, limit=10
        )

        # Should return the task since user 1 owns it
        assert len(result) == 1

    def test_empty_result_when_no_group_chats(self, task_service, mock_db):
        """Test that empty result is returned when user has no group chats"""
        # Mock database execute for count query - returns 0
        mock_count_result = Mock()
        mock_count_result.scalar.return_value = 0

        # Mock database execute for IDs query - returns empty
        mock_ids_result = Mock()
        mock_ids_result.fetchall.return_value = []

        def execute_side_effect(sql, params=None):
            sql_str = str(sql) if hasattr(sql, "__str__") else ""
            if "COUNT" in sql_str:
                return mock_count_result
            elif "SELECT DISTINCT" in sql_str:
                return mock_ids_result
            return Mock()

        mock_db.execute.side_effect = execute_side_effect

        # Call the method
        result, total = task_service.get_user_group_tasks_lite(
            mock_db, user_id=1, skip=0, limit=10
        )

        # Verify empty results
        assert total == 0
        assert len(result) == 0
        assert result == []
