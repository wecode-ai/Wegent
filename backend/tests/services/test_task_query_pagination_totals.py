# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import Mock

import pytest
from sqlalchemy.orm import Session

from app.models.task import TaskResource
from app.services.adapters.task_kinds import TaskKindsService


def _mock_execute_result(*, scalar_value=None, rows=None):
    result = Mock()
    result.scalar.return_value = scalar_value
    result.fetchall.return_value = rows or []
    return result


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
        mock_db.execute.side_effect = [
            _mock_execute_result(scalar_value=12),
            _mock_execute_result(rows=[]),
        ]

        items, total = task_service.get_user_tasks_with_pagination(
            mock_db, user_id=1, skip=100, limit=10
        )

        assert items == []
        assert total == 12

    def test_get_user_tasks_lite_keeps_total_on_empty_page(self, task_service, mock_db):
        mock_db.execute.side_effect = [
            _mock_execute_result(scalar_value=8),
            _mock_execute_result(rows=[]),
        ]

        items, total = task_service.get_user_tasks_lite(
            mock_db, user_id=1, skip=50, limit=10
        )

        assert items == []
        assert total == 8
