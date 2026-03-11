# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import Mock, patch

import pytest
from sqlalchemy.orm import Session

from app.models.task import TaskResource
from app.services.adapters.task_kinds import TaskKindsService


@pytest.mark.unit
def test_get_user_group_tasks_lite_uses_db_pagination_and_count():
    task_service = TaskKindsService(TaskResource)
    db = Mock(spec=Session)
    paged_tasks = [Mock(spec=TaskResource), Mock(spec=TaskResource)]

    with (
        patch(
            "app.services.adapters.task_kinds.queries.get_group_task_ids_for_accessible_user",
            return_value={11, 22, 33},
        ),
        patch(
            "app.services.adapters.task_kinds.queries.count_non_deleted_tasks_by_ids",
            return_value=9,
        ) as mock_count,
        patch(
            "app.services.adapters.task_kinds.queries.load_tasks_by_ids_ordered",
            return_value=paged_tasks,
        ) as mock_load,
        patch(
            "app.services.adapters.task_kinds.queries.build_lite_task_list",
            return_value=[{"id": 11}, {"id": 22}],
        ) as mock_build,
    ):
        items, total = task_service.get_user_group_tasks_lite(
            db, user_id=7, skip=50, limit=25
        )

    assert total == 9
    assert items == [{"id": 11}, {"id": 22}]
    mock_count.assert_called_once()
    mock_load.assert_called_once()
    mock_build.assert_called_once_with(db, paged_tasks, 7)
