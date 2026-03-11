# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from unittest.mock import Mock, patch

import pytest
from sqlalchemy.orm import Session

from app.models.task import TaskResource
from app.services.adapters.task_kinds import TaskKindsService


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
            "is_group_chat": True,
        },
        "status": {
            "state": "Available",
            "status": "PENDING",
            "progress": 0,
        },
    }


@pytest.mark.unit
def test_get_user_group_tasks_lite_uses_db_pagination_and_count():
    """Test that get_user_group_tasks_lite returns correct items and total.

    This test mocks the database layer to verify the service correctly:
    1. Returns paginated results
    2. Returns the correct total count
    3. Builds lite task list from tasks
    """
    task_service = TaskKindsService(TaskResource)
    db = Mock(spec=Session)

    # Create real datetime objects for comparison
    now = datetime.now()

    # Mock task objects with valid JSON
    mock_task1 = Mock(spec=TaskResource)
    mock_task1.id = 11
    mock_task1.updated_at = now
    mock_task1.json = _create_valid_task_json(11, "Task 11")

    mock_task2 = Mock(spec=TaskResource)
    mock_task2.id = 22
    mock_task2.updated_at = now
    mock_task2.json = _create_valid_task_json(22, "Task 22")

    # Mock execute results for different queries
    def mock_execute(sql, params=None):
        result = Mock()
        sql_str = str(sql)
        if "SELECT id, updated_at" in sql_str and "is_group_chat = true" in sql_str:
            # Select group chat tasks (no limit/skip, just IDs)
            result.fetchall.return_value = [
                (11, mock_task1.updated_at),
                (22, mock_task2.updated_at),
            ]
        elif "resource_members" in sql_str and "resource_type = 'Namespace'" in sql_str:
            # Namespace query
            result.fetchall.return_value = []
        elif "resource_members" in sql_str and "resource_type = 'Task'" in sql_str:
            # Member task IDs query
            result.fetchall.return_value = []
        else:
            result.fetchall.return_value = []
            result.fetchone.return_value = None
        return result

    db.execute.side_effect = mock_execute

    # Mock query for loading full task data
    db.query.return_value.filter.return_value.all.return_value = [
        mock_task1,
        mock_task2,
    ]

    with patch(
        "app.services.adapters.task_kinds.queries.build_lite_task_list",
        return_value=[{"id": 11}, {"id": 22}],
    ) as mock_build:
        items, total = task_service.get_user_group_tasks_lite(
            db, user_id=7, skip=0, limit=25
        )

    # Total is now computed from the union of all task IDs (2 tasks from group_chat)
    assert total == 2
    assert items == [{"id": 11}, {"id": 22}]
    mock_build.assert_called_once()
