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


@pytest.mark.unit
def test_get_user_personal_task_groups_lite_uses_personal_query_without_group_id_fetch():
    task_service = TaskKindsService(TaskResource)
    db = Mock(spec=Session)
    paged_tasks = [Mock(spec=TaskResource), Mock(spec=TaskResource)]
    paged_tasks[0].id = 11
    paged_tasks[1].id = 22

    with (
        patch(
            "app.services.adapters.task_kinds.queries.get_group_task_ids_for_owned_tasks",
            return_value={99},
            create=True,
        ) as mock_group_ids,
        patch(
            "app.services.adapters.task_kinds.queries.get_owned_task_ids_and_total",
            return_value=([11, 22], 9),
        ) as mock_owned_query,
        patch(
            "app.services.adapters.task_kinds.queries.get_personal_task_ids_and_total",
            return_value=([11, 22], 9),
            create=True,
        ) as mock_personal_query,
        patch(
            "app.services.adapters.task_kinds.queries.load_tasks_by_ids",
            return_value=paged_tasks,
        ),
        patch.object(
            task_service,
            "_filter_personal_tasks",
            return_value=paged_tasks,
        ) as mock_filter,
        patch(
            "app.services.adapters.task_kinds.queries.build_lite_task_groups",
            return_value=[{"group_key": "team:1"}],
        ) as mock_build,
    ):
        items, total = task_service.get_user_personal_task_groups_lite(
            db, user_id=7, skip=50, limit=25, types=["online"]
        )

    assert total == 9
    assert items == [{"group_key": "team:1"}]
    mock_group_ids.assert_not_called()
    mock_owned_query.assert_not_called()
    mock_personal_query.assert_called_once_with(
        db,
        user_id=7,
        skip=50,
        limit=25,
        extra_limit=200,
        project_scope="all",
    )
    mock_filter.assert_called_once_with(paged_tasks, set(), ["online"])
    mock_build.assert_called_once_with(db, paged_tasks, 7)
