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

    Uses query_utils helpers for efficient batch operations.
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

    # Mock the query_utils helpers
    with patch(
        "app.services.adapters.task_kinds.queries.get_group_task_ids_for_accessible_user",
        return_value={11, 22},
    ) as mock_get_ids:
        with patch(
            "app.services.adapters.task_kinds.queries.count_non_deleted_tasks_by_ids",
            return_value=2,
        ) as mock_count:
            with patch(
                "app.services.adapters.task_kinds.queries.load_tasks_by_ids_ordered",
                return_value=[mock_task1, mock_task2],
            ) as mock_load:
                with patch(
                    "app.services.adapters.task_kinds.queries.build_lite_task_list",
                    return_value=[{"id": 11}, {"id": 22}],
                ) as mock_build:
                    items, total = task_service.get_user_group_tasks_lite(
                        db, user_id=7, skip=0, limit=25
                    )

    # Verify all helpers were called correctly
    mock_get_ids.assert_called_once_with(db, user_id=7)
    mock_count.assert_called_once_with(db, [11, 22])
    mock_load.assert_called_once_with(
        db,
        [11, 22],
        order_field="updated_at",
        descending=True,
        skip=0,
        limit=25,
        exclude_deleted=True,
    )
    mock_build.assert_called_once_with(db, [mock_task1, mock_task2], 7)

    assert total == 2
    assert items == [{"id": 11}, {"id": 22}]


@pytest.mark.unit
def test_get_user_group_tasks_lite_empty_result():
    """Test that get_user_group_tasks_lite handles empty group tasks."""
    task_service = TaskKindsService(TaskResource)
    db = Mock(spec=Session)

    with patch(
        "app.services.adapters.task_kinds.queries.get_group_task_ids_for_accessible_user",
        return_value=set(),
    ) as mock_get_ids:
        items, total = task_service.get_user_group_tasks_lite(
            db, user_id=7, skip=0, limit=25
        )

    mock_get_ids.assert_called_once_with(db, user_id=7)
    assert total == 0
    assert items == []


@pytest.mark.unit
def test_get_user_group_tasks_lite_all_deleted():
    """Test that get_user_group_tasks_lite returns empty when all tasks are deleted."""
    task_service = TaskKindsService(TaskResource)
    db = Mock(spec=Session)

    with patch(
        "app.services.adapters.task_kinds.queries.get_group_task_ids_for_accessible_user",
        return_value={11, 22},
    ) as mock_get_ids:
        with patch(
            "app.services.adapters.task_kinds.queries.count_non_deleted_tasks_by_ids",
            return_value=0,
        ) as mock_count:
            items, total = task_service.get_user_group_tasks_lite(
                db, user_id=7, skip=0, limit=25
            )

    mock_get_ids.assert_called_once_with(db, user_id=7)
    mock_count.assert_called_once_with(db, [11, 22])
    assert total == 0
    assert items == []


@pytest.mark.unit
def test_get_user_group_tasks_lite_pagination():
    """Test pagination with skip and limit parameters."""
    task_service = TaskKindsService(TaskResource)
    db = Mock(spec=Session)

    now = datetime.now()

    # Create 5 mock tasks
    mock_tasks = []
    for i in range(1, 6):
        task = Mock(spec=TaskResource)
        task.id = i * 10
        task.updated_at = now
        task.json = _create_valid_task_json(i * 10, f"Task {i}")
        mock_tasks.append(task)

    task_ids = {10, 20, 30, 40, 50}

    with patch(
        "app.services.adapters.task_kinds.queries.get_group_task_ids_for_accessible_user",
        return_value=task_ids,
    ):
        with patch(
            "app.services.adapters.task_kinds.queries.count_non_deleted_tasks_by_ids",
            return_value=5,
        ):
            with patch(
                "app.services.adapters.task_kinds.queries.load_tasks_by_ids_ordered",
                return_value=mock_tasks[2:4],  # Tasks 30, 40 (skip 2, limit 2)
            ) as mock_load:
                with patch(
                    "app.services.adapters.task_kinds.queries.build_lite_task_list",
                    return_value=[{"id": 30}, {"id": 40}],
                ):
                    items, total = task_service.get_user_group_tasks_lite(
                        db, user_id=7, skip=2, limit=2
                    )

    # Verify skip and limit are passed correctly
    mock_load.assert_called_once_with(
        db,
        list(task_ids),
        order_field="updated_at",
        descending=True,
        skip=2,
        limit=2,
        exclude_deleted=True,
    )

    assert total == 5
    assert len(items) == 2


@pytest.mark.unit
def test_get_user_personal_tasks_lite_basic():
    """Test get_user_personal_tasks_lite returns non-group tasks."""
    task_service = TaskKindsService(TaskResource)
    db = Mock(spec=Session)

    now = datetime.now()

    # Create mock tasks
    mock_task1 = Mock(spec=TaskResource)
    mock_task1.id = 11
    mock_task1.updated_at = now
    mock_task1.json = _create_valid_task_json(11, "Personal Task 1")
    mock_task1.json["spec"]["is_group_chat"] = False

    mock_task2 = Mock(spec=TaskResource)
    mock_task2.id = 22
    mock_task2.updated_at = now
    mock_task2.json = _create_valid_task_json(22, "Personal Task 2")
    mock_task2.json["spec"]["is_group_chat"] = False

    with patch(
        "app.services.adapters.task_kinds.queries.get_owned_task_ids_and_total",
        return_value=([11, 22, 33], 3),  # 3 owned tasks
    ) as mock_owned:
        with patch(
            "app.services.adapters.task_kinds.queries.get_group_task_ids_for_owned_tasks",
            return_value={33},  # Task 33 is a group task
        ) as mock_group:
            with patch(
                "app.services.adapters.task_kinds.queries.load_tasks_by_ids",
                return_value=[mock_task1, mock_task2],
            ) as mock_load:
                with patch(
                    "app.services.adapters.task_kinds.queries.build_lite_task_list",
                    return_value=[{"id": 11}, {"id": 22}],
                ) as mock_build:
                    items, total = task_service.get_user_personal_tasks_lite(
                        db, user_id=7, skip=0, limit=25
                    )

    # Verify helpers were called
    mock_owned.assert_called_once_with(db, user_id=7, skip=0, limit=25, extra_limit=200)
    mock_group.assert_called_once_with(db, user_id=7)
    mock_load.assert_called_once()
    mock_build.assert_called_once()

    assert total == 2
    assert items == [{"id": 11}, {"id": 22}]


@pytest.mark.unit
def test_get_user_personal_tasks_lite_type_filter():
    """Test get_user_personal_tasks_lite filters by task type."""
    task_service = TaskKindsService(TaskResource)
    db = Mock(spec=Session)

    now = datetime.now()

    # Create mock tasks with different types
    mock_task_online = Mock(spec=TaskResource)
    mock_task_online.id = 11
    mock_task_online.json = _create_valid_task_json(11, "Online Task")
    mock_task_online.json["spec"]["is_group_chat"] = False
    # Default is chat type (online)

    mock_task_offline = Mock(spec=TaskResource)
    mock_task_offline.id = 22
    mock_task_offline.json = _create_valid_task_json(22, "Offline Task")
    mock_task_offline.json["spec"]["is_group_chat"] = False
    mock_task_offline.json["metadata"]["labels"]["taskType"] = "code"

    mock_task_subscription = Mock(spec=TaskResource)
    mock_task_subscription.id = 33
    mock_task_subscription.json = _create_valid_task_json(33, "Subscription Task")
    mock_task_subscription.json["spec"]["is_group_chat"] = False
    mock_task_subscription.json["metadata"]["labels"]["type"] = "subscription"

    with patch(
        "app.services.adapters.task_kinds.queries.get_owned_task_ids_and_total",
        return_value=([22], 1),  # Only 1 owned task (the offline one)
    ):
        with patch(
            "app.services.adapters.task_kinds.queries.get_group_task_ids_for_owned_tasks",
            return_value=set(),
        ):
            with patch(
                "app.services.adapters.task_kinds.queries.load_tasks_by_ids",
                return_value=[mock_task_offline],
            ):
                with patch(
                    "app.services.adapters.task_kinds.queries.build_lite_task_list",
                    return_value=[{"id": 22}],
                ) as mock_build:
                    # Request only offline tasks
                    items, total = task_service.get_user_personal_tasks_lite(
                        db, user_id=7, skip=0, limit=25, types=["offline"]
                    )

    # Should only return the code/offline task
    assert total == 1
    assert items == [{"id": 22}]


@pytest.mark.unit
def test_get_user_personal_tasks_lite_excludes_group_tasks():
    """Test get_user_personal_tasks_lite excludes all group tasks."""
    task_service = TaskKindsService(TaskResource)
    db = Mock(spec=Session)

    now = datetime.now()

    # Create mock tasks
    mock_task_personal = Mock(spec=TaskResource)
    mock_task_personal.id = 11
    mock_task_personal.json = _create_valid_task_json(11, "Personal Task")
    mock_task_personal.json["spec"]["is_group_chat"] = False

    mock_task_group = Mock(spec=TaskResource)
    mock_task_group.id = 22
    mock_task_group.json = _create_valid_task_json(22, "Group Task")
    mock_task_group.json["spec"]["is_group_chat"] = True

    with patch(
        "app.services.adapters.task_kinds.queries.get_owned_task_ids_and_total",
        return_value=([11, 22], 2),
    ):
        with patch(
            "app.services.adapters.task_kinds.queries.get_group_task_ids_for_owned_tasks",
            return_value={22},  # Task 22 is a group task
        ):
            with patch(
                "app.services.adapters.task_kinds.queries.load_tasks_by_ids",
                return_value=[mock_task_personal],  # Only personal task returned
            ):
                with patch(
                    "app.services.adapters.task_kinds.queries.build_lite_task_list",
                    return_value=[{"id": 11}],
                ):
                    items, total = task_service.get_user_personal_tasks_lite(
                        db, user_id=7, skip=0, limit=25
                    )

    # Should only return the personal task (11), not the group task (22)
    assert total == 1
    assert items == [{"id": 11}]


@pytest.mark.unit
def test_get_user_personal_tasks_lite_empty_result():
    """Test get_user_personal_tasks_lite handles empty result."""
    task_service = TaskKindsService(TaskResource)
    db = Mock(spec=Session)

    with patch(
        "app.services.adapters.task_kinds.queries.get_owned_task_ids_and_total",
        return_value=([], 0),
    ) as mock_owned:
        with patch(
            "app.services.adapters.task_kinds.queries.get_group_task_ids_for_owned_tasks",
            return_value=set(),
        ):
            items, total = task_service.get_user_personal_tasks_lite(
                db, user_id=7, skip=0, limit=25
            )

    mock_owned.assert_called_once()
    assert total == 0
    assert items == []


@pytest.mark.unit
def test_get_user_personal_tasks_lite_all_group_tasks():
    """Test get_user_personal_tasks_lite when all owned tasks are group tasks."""
    task_service = TaskKindsService(TaskResource)
    db = Mock(spec=Session)

    with patch(
        "app.services.adapters.task_kinds.queries.get_owned_task_ids_and_total",
        return_value=([11, 22], 2),
    ):
        with patch(
            "app.services.adapters.task_kinds.queries.get_group_task_ids_for_owned_tasks",
            return_value={11, 22},  # All tasks are group tasks
        ):
            with patch(
                "app.services.adapters.task_kinds.queries.load_tasks_by_ids",
                return_value=[],  # No tasks after filtering
            ):
                items, total = task_service.get_user_personal_tasks_lite(
                    db, user_id=7, skip=0, limit=25
                )

    # No personal tasks to return
    assert total == 0
    assert items == []
