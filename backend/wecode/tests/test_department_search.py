# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

from wecode.api.department_search import _is_obsolete_department, search_departments
from wecode.service.erp_client import DepartmentInfo


class TestDepartmentSearch:
    @pytest.mark.parametrize(
        "display_name",
        [
            "研发部（失效）",
            "研发部(无效)",
            "研发部（旧）",
            "研发部（old）",
            "研发部(OLD)",
            "研发部（ ｏｌｄ ）",
            "研发部(old)（失效）",
            "研发部（待失效）",
            "研发部（待撤销）",
        ],
    )
    def test_is_obsolete_department_matches_exact_markers(self, display_name):
        department = DepartmentInfo(id="1", name=display_name)

        assert _is_obsolete_department(department) is True

    @pytest.mark.parametrize(
        "display_name",
        [
            "研发部（old2）",
            "舆情组（五栋旧）",
            "研发部-旧",
            "研发部—旧",
            "研发部（old data）",
            "Gold平台研发部",
            "旧系统研发部",
            "研发部（失效处理中）",
            "研发部（无效待确认）",
            "研发部",
            "",
        ],
    )
    def test_is_obsolete_department_keeps_non_exact_markers(self, display_name):
        department = DepartmentInfo(id="1", name=display_name)

        assert _is_obsolete_department(department) is False

    def test_is_obsolete_department_falls_back_to_label(self):
        department = DepartmentInfo(id="1", name=None, label="研发部（失效）")

        assert _is_obsolete_department(department) is True

    def test_is_obsolete_department_prefers_name_over_label(self):
        department = DepartmentInfo(
            id="1",
            name="研发部",
            label="研发部（失效）",
        )

        assert _is_obsolete_department(department) is False

    def test_search_departments_query_too_long(self):
        db = MagicMock()
        user = MagicMock()
        user.user_name = "test"

        with pytest.raises(HTTPException) as exc_info:
            search_departments(q="x" * 101, db=db, current_user=user)
        assert exc_info.value.status_code == 400

    def test_search_departments_filters_before_visibility_and_sanitizes(self):
        db = MagicMock()
        user = MagicMock()
        user.user_name = "test"

        active = DepartmentInfo(id="1", name="研发部")
        obsolete = DepartmentInfo(id="2", name="调整部门（待失效）")
        retained = DepartmentInfo(id="3", name="调整部门（old2）")
        missing_id = DepartmentInfo(id=None, name="无编号部门")
        duplicate = DepartmentInfo(id="1", name="研发部重复记录")

        with (
            patch(
                "wecode.api.department_search.erp_client.search_departments"
            ) as mock_search,
            patch("wecode.api.department_search.filter_hidden_for_user") as mock_filter,
        ):
            visible_departments = [active, retained, missing_id, duplicate]
            mock_search.return_value = [
                active,
                obsolete,
                retained,
                missing_id,
                duplicate,
            ]
            mock_filter.return_value = visible_departments

            result = search_departments(q="研发", db=db, current_user=user)
            assert result == {"departments": [active, retained]}
            mock_search.assert_called_once_with("研发")
            mock_filter.assert_called_once_with("test", visible_departments)
