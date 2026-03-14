# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import Mock, patch

import pytest
from sqlalchemy.orm import Session

from app.models.task import TaskResource
from app.services.adapters.task_kinds import TaskKindsService


def _mock_execute_result(*, scalar_value=None, rows=None):
    result = Mock()
    result.scalar.return_value = scalar_value
    result.fetchall.return_value = rows or []
    return result


def _create_valid_task_json(task_id: int, title: str = "Test Task") -> dict:
    """Create a valid Task JSON that passes Task.model_validate()."""
    return {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Task",
        "metadata": {
            "name": f"task-{task_id}",
            "namespace": "default",
            "labels": {},
        },
        "spec": {
            "title": title,
            "prompt": "Test prompt",
            "teamRef": {"name": "test-team", "namespace": "default"},
            "workspaceRef": {"name": "test-workspace", "namespace": "default"},
        },
        "status": {
            "state": "Available",
            "status": "PENDING",
            "progress": 0,
        },
    }


@pytest.mark.unit
class TestTaskQueryPaginationTotals:
    @pytest.fixture
    def task_service(self):
        return TaskKindsService(TaskResource)

    @pytest.fixture
    def mock_db(self):
        return Mock(spec=Session)

    def test_get_user_tasks_with_pagination_keeps_total_on_empty_page(
        self, task_service, mock_db
    ):
        """Test that total count is preserved even when page is empty."""
        # Mock for get_accessible_task_ids_and_total (2 calls: count + ids)
        # No more all_ids_sql call - optimized version only uses get_accessible_task_ids_and_total
        mock_db.execute.side_effect = [
            _mock_execute_result(
                scalar_value=12
            ),  # 1. count in get_accessible_task_ids_and_total
            _mock_execute_result(
                rows=[]
            ),  # 2. ids in get_accessible_task_ids_and_total (empty)
        ]

        items, total = task_service.get_user_tasks_with_pagination(
            mock_db, user_id=1, skip=100, limit=10
        )

        assert items == []
        assert total == 12  # Total from get_accessible_task_ids_and_total is preserved

    def test_get_user_tasks_lite_keeps_total_on_empty_page(self, task_service, mock_db):
        """Test that total count is preserved even when page is empty."""
        # Mock for get_accessible_task_ids_and_total (2 calls: count + ids)
        # No more all_ids_sql call - optimized version only uses get_accessible_task_ids_and_total
        mock_db.execute.side_effect = [
            _mock_execute_result(
                scalar_value=8
            ),  # 1. count in get_accessible_task_ids_and_total
            _mock_execute_result(
                rows=[]
            ),  # 2. ids in get_accessible_task_ids_and_total (empty)
        ]

        items, total = task_service.get_user_tasks_lite(
            mock_db, user_id=1, skip=50, limit=10
        )

        assert items == []
        assert total == 8  # Total from get_accessible_task_ids_and_total is preserved

    def test_get_user_tasks_with_pagination_returns_tasks_with_total(
        self, task_service, mock_db
    ):
        """Test that tasks are returned with correct total."""
        task_json = _create_valid_task_json(1, "Test Task")

        mock_task = Mock(spec=TaskResource)
        mock_task.id = 1
        mock_task.json = task_json
        mock_task.created_at = Mock()
        mock_task.updated_at = Mock()

        # Mock execute results - only 2 calls needed now (count + ids)
        mock_db.execute.side_effect = [
            _mock_execute_result(scalar_value=5),  # 1. count
            _mock_execute_result(rows=[(1, Mock())]),  # 2. ids
        ]

        # Mock query for loading tasks via load_tasks_by_ids
        mock_db.query.return_value.filter.return_value.all.return_value = [mock_task]

        with patch(
            "app.services.adapters.task_kinds.queries.get_tasks_related_data_batch",
            return_value={
                "1": {
                    "workspace_data": {},
                    "team_id": 1,
                    "user_name": "test",
                    "created_at": Mock(),
                    "updated_at": Mock(),
                    "completed_at": None,
                    "is_group_chat": False,
                }
            },
        ):
            items, total = task_service.get_user_tasks_with_pagination(
                mock_db, user_id=1, skip=0, limit=10
            )

        assert len(items) == 1
        assert total == 5  # Total from get_accessible_task_ids_and_total

    def test_get_user_tasks_lite_returns_tasks_with_total(self, task_service, mock_db):
        """Test that lite tasks are returned with correct total."""
        task_json = _create_valid_task_json(1, "Test Task")

        mock_task = Mock(spec=TaskResource)
        mock_task.id = 1
        mock_task.json = task_json
        mock_task.created_at = Mock()
        mock_task.updated_at = Mock()

        # Mock execute results - only 2 calls needed now (count + ids)
        mock_db.execute.side_effect = [
            _mock_execute_result(scalar_value=5),  # 1. count
            _mock_execute_result(rows=[(1, Mock())]),  # 2. ids
        ]

        # Mock query for loading tasks via load_tasks_by_ids
        mock_db.query.return_value.filter.return_value.all.return_value = [mock_task]

        with patch(
            "app.services.adapters.task_kinds.queries.build_lite_task_list",
            return_value=[{"id": 1, "title": "Test Task"}],
        ) as mock_build:
            items, total = task_service.get_user_tasks_lite(
                mock_db, user_id=1, skip=0, limit=10
            )

        assert len(items) == 1
        assert total == 5  # Total from get_accessible_task_ids_and_total
        mock_build.assert_called_once()
