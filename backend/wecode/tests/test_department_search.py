# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

from wecode.api.department_search import search_departments


class TestDepartmentSearch:
    def test_search_departments_query_too_long(self):
        db = MagicMock()
        user = MagicMock()
        user.user_name = "test"

        with pytest.raises(HTTPException) as exc_info:
            search_departments(q="x" * 101, db=db, current_user=user)
        assert exc_info.value.status_code == 400

    def test_search_departments_calls_filter_hidden(self):
        db = MagicMock()
        user = MagicMock()
        user.user_name = "test"

        with (
            patch(
                "wecode.api.department_search.erp_client.search_departments"
            ) as mock_search,
            patch("wecode.api.department_search.filter_hidden_for_user") as mock_filter,
        ):
            mock_search.return_value = []
            mock_filter.return_value = []

            result = search_departments(q="研发", db=db, current_user=user)
            assert result == {"departments": []}
            mock_search.assert_called_once_with("研发")
            mock_filter.assert_called_once_with("test", [])
