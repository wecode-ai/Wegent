# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import Mock, patch

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.task import TaskResource
from app.services.adapters.task_kinds import TaskKindsService


@pytest.mark.unit
class TestTaskAccessControl:
    """Test task access control in TaskKindsService.get_task_by_id"""

    @pytest.fixture
    def mock_db(self):
        """Create a mock database session"""
        return Mock(spec=Session)

    @pytest.fixture
    def task_service(self):
        """Create TaskKindsService instance"""
        return TaskKindsService(TaskResource)

    @pytest.fixture
    def mock_task(self):
        """Create a mock task"""
        task = Mock(spec=TaskResource)
        task.id = 123
        task.user_id = 1
        task.kind = "Task"
        task.is_active = True
        task.json = {"status": {"status": "RUNNING"}}
        return task

    def test_owner_can_access_task(self, task_service, mock_db, mock_task):
        """Test that task owner can access their task"""
        with (
            patch(
                "app.services.adapters.task_kinds.queries.task_store"
            ) as mock_task_store,
            patch(
                "app.services.adapters.task_kinds.queries.task_access_store"
            ) as mock_access_store,
        ):
            mock_task_store.get_active_non_deleted_task.return_value = mock_task
            mock_access_store.is_member.return_value = True

            with patch(
                "app.services.adapters.task_kinds.queries.convert_to_task_dict"
            ) as mock_convert:
                mock_convert.return_value = {"id": 123, "user_id": 1}

                result = task_service.get_task_by_id(mock_db, task_id=123, user_id=1)

                assert result is not None
                assert result["id"] == 123
                mock_task_store.get_active_non_deleted_task.assert_called_once_with(
                    mock_db, task_id=123, client_origin=None
                )
                mock_access_store.is_member.assert_called_once_with(
                    mock_db, task_id=123, user_id=1
                )

    def test_member_can_access_group_chat(self, task_service, mock_db, mock_task):
        """Test that group chat member can access the task"""
        with (
            patch(
                "app.services.adapters.task_kinds.queries.task_store"
            ) as mock_task_store,
            patch(
                "app.services.adapters.task_kinds.queries.task_access_store"
            ) as mock_access_store,
        ):
            mock_task_store.get_active_non_deleted_task.return_value = mock_task
            mock_access_store.is_member.return_value = True

            with patch(
                "app.services.adapters.task_kinds.queries.convert_to_task_dict"
            ) as mock_convert:
                mock_convert.return_value = {"id": 123, "user_id": 1}

                result = task_service.get_task_by_id(mock_db, task_id=123, user_id=2)

                assert result is not None
                assert result["id"] == 123
                mock_access_store.is_member.assert_called_once_with(
                    mock_db, task_id=123, user_id=2
                )

    def test_non_member_cannot_access_group_chat(
        self, task_service, mock_db, mock_task
    ):
        """Test that non-member cannot access group chat"""
        with (
            patch(
                "app.services.adapters.task_kinds.queries.task_store"
            ) as mock_task_store,
            patch(
                "app.services.adapters.task_kinds.queries.task_access_store"
            ) as mock_access_store,
        ):
            mock_task_store.get_active_non_deleted_task.return_value = mock_task
            mock_access_store.is_member.return_value = False

            with pytest.raises(HTTPException) as exc_info:
                task_service.get_task_by_id(mock_db, task_id=123, user_id=3)

            assert exc_info.value.status_code == 404
            assert exc_info.value.detail == "Task not found"
            mock_access_store.is_member.assert_called_once_with(
                mock_db, task_id=123, user_id=3
            )

    def test_task_not_found_returns_404(self, task_service, mock_db):
        """Test that non-existent task returns 404"""
        with patch(
            "app.services.adapters.task_kinds.queries.task_store"
        ) as mock_task_store:
            mock_task_store.get_active_non_deleted_task.return_value = None

            with pytest.raises(HTTPException) as exc_info:
                task_service.get_task_by_id(mock_db, task_id=999, user_id=1)

        assert exc_info.value.status_code == 404
        assert exc_info.value.detail == "Task not found"

    def test_deleted_task_not_accessible(self, task_service, mock_db):
        """Test that deleted tasks are not accessible"""
        # Mock a deleted task
        deleted_task = Mock(spec=TaskResource)
        deleted_task.id = 123
        deleted_task.user_id = 1
        deleted_task.kind = "Task"
        deleted_task.is_active = True
        deleted_task.json = {"status": {"status": "DELETE"}}

        with patch(
            "app.services.adapters.task_kinds.queries.task_store"
        ) as mock_task_store:
            mock_task_store.get_active_non_deleted_task.return_value = None

            with pytest.raises(HTTPException) as exc_info:
                task_service.get_task_by_id(mock_db, task_id=123, user_id=1)

        assert exc_info.value.status_code == 404
        assert exc_info.value.detail == "Task not found"

    def test_inactive_task_not_accessible(self, task_service, mock_db):
        """Test that inactive tasks are not accessible"""
        with patch(
            "app.services.adapters.task_kinds.queries.task_store"
        ) as mock_task_store:
            mock_task_store.get_active_non_deleted_task.return_value = None

            with pytest.raises(HTTPException) as exc_info:
                task_service.get_task_by_id(mock_db, task_id=123, user_id=1)

        assert exc_info.value.status_code == 404
        assert exc_info.value.detail == "Task not found"
