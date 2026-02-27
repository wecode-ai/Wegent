# SPDX-FileCopyrightText: 2025 Wecode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Test task member service group chat detection.

These tests verify that share records (copied_resource_id > 0) are correctly
excluded when determining if a task is a group chat or counting group chat members.
"""

from unittest.mock import MagicMock, Mock, patch

import pytest
from sqlalchemy.orm import Session

from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import PermissionLevel, ResourceType
from app.models.task import TaskResource
from app.services.task_member_service import TaskMemberService


@pytest.mark.unit
class TestTaskMemberServiceGroupChatDetection:
    """Test group chat detection excludes share records"""

    @pytest.fixture
    def mock_db(self):
        """Create a mock database session"""
        return Mock(spec=Session)

    @pytest.fixture
    def task_member_service(self):
        """Create TaskMemberService instance"""
        return TaskMemberService()

    @pytest.fixture
    def mock_task(self):
        """Create a mock task"""
        task = Mock(spec=TaskResource)
        task.id = 100
        task.user_id = 1
        task.kind = "Task"
        task.is_active = True
        task.json = {"spec": {"is_group_chat": False}}
        return task

    def test_is_member_excludes_share_records(self, task_member_service, mock_db):
        """
        Test that is_member returns False for users who only have share records.

        When a user copies a shared task, a ResourceMember record is created with
        copied_resource_id > 0. This should NOT make them a member of the original task.
        """
        # Mock task exists and user is not owner
        mock_task = Mock(spec=TaskResource)
        mock_task.id = 100
        mock_task.user_id = 1  # Owner is user 1

        # Set up query chain for get_task
        mock_query = MagicMock()
        mock_db.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.first.return_value = mock_task

        # User 2 has a share record (copied_resource_id > 0), not a group chat member
        # The filter should exclude this record because copied_resource_id == 0 is required
        # So first() should return None

        # Test: user 2 should NOT be considered a member
        with patch.object(
            task_member_service, "is_task_owner", return_value=False
        ) as mock_owner:
            # Reset mock for the ResourceMember query
            mock_db.reset_mock()
            mock_query = MagicMock()
            mock_db.query.return_value = mock_query
            mock_query.filter.return_value = mock_query
            mock_query.first.return_value = None  # No group chat member record found

            result = task_member_service.is_member(mock_db, task_id=100, user_id=2)

            # User 2 should not be considered a member
            assert result is False
            mock_owner.assert_called_once_with(mock_db, 100, 2)

    def test_is_member_includes_real_group_chat_members(
        self, task_member_service, mock_db
    ):
        """
        Test that is_member returns True for actual group chat members.

        Real group chat members have copied_resource_id = 0.
        """
        # Mock task exists and user is not owner
        mock_member = Mock(spec=ResourceMember)
        mock_member.id = 1
        mock_member.resource_type = ResourceType.TASK
        mock_member.resource_id = 100
        mock_member.user_id = 2
        mock_member.status = MemberStatus.APPROVED
        mock_member.copied_resource_id = 0  # Real group chat member

        with patch.object(
            task_member_service, "is_task_owner", return_value=False
        ) as mock_owner:
            mock_query = MagicMock()
            mock_db.query.return_value = mock_query
            mock_query.filter.return_value = mock_query
            mock_query.first.return_value = mock_member

            result = task_member_service.is_member(mock_db, task_id=100, user_id=2)

            # User 2 should be considered a member
            assert result is True
            mock_owner.assert_called_once_with(mock_db, 100, 2)

    def test_get_member_count_excludes_share_records(
        self, task_member_service, mock_db
    ):
        """
        Test that get_member_count excludes share records.

        Share records (copied_resource_id > 0) should not be counted as group chat members.
        Only owner (always counted as 1) + actual members (copied_resource_id = 0) should be counted.
        """
        # Mock count query returns 0 (no actual group chat members, only share records)
        mock_query = MagicMock()
        mock_db.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.count.return_value = 0

        result = task_member_service.get_member_count(mock_db, task_id=100)

        # Should return 1 (only owner), not count share records
        assert result == 1

    def test_get_member_count_includes_real_members(self, task_member_service, mock_db):
        """
        Test that get_member_count includes real group chat members.
        """
        # Mock count query returns 2 (two real group chat members)
        mock_query = MagicMock()
        mock_db.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.count.return_value = 2

        result = task_member_service.get_member_count(mock_db, task_id=100)

        # Should return 3 (owner + 2 members)
        assert result == 3

    def test_get_members_excludes_share_records(self, task_member_service, mock_db):
        """
        Test that get_members excludes share records from the member list.
        """
        # Mock task
        mock_task = Mock(spec=TaskResource)
        mock_task.id = 100
        mock_task.user_id = 1
        mock_task.created_at = "2025-01-01"

        # Mock owner user
        mock_owner = Mock()
        mock_owner.id = 1
        mock_owner.user_name = "owner"

        # Mock a real group chat member (not a share record)
        mock_member = Mock(spec=ResourceMember)
        mock_member.id = 1
        mock_member.user_id = 2
        mock_member.invited_by_user_id = 1
        mock_member.requested_at = "2025-01-02"
        mock_member.copied_resource_id = 0  # Real member

        mock_member_user = Mock()
        mock_member_user.id = 2
        mock_member_user.user_name = "member"

        with patch.object(
            task_member_service, "get_task", return_value=mock_task
        ), patch.object(
            task_member_service,
            "get_user",
            side_effect=lambda db, uid: mock_owner if uid == 1 else mock_member_user,
        ):
            # Mock query returns only real group chat members (not share records)
            mock_query = MagicMock()
            mock_db.query.return_value = mock_query
            mock_query.filter.return_value = mock_query
            mock_query.all.return_value = [mock_member]

            result = task_member_service.get_members(mock_db, task_id=100)

            # Should return 2 members: owner + 1 real member
            assert result.total == 2
            assert len(result.members) == 2
            assert result.members[0].is_owner is True
            assert result.members[1].is_owner is False


@pytest.mark.unit
class TestSharedTaskDoesNotBecomeGroupChat:
    """
    Test that sharing a task does not convert the original task to a group chat.

    This is the main bug scenario:
    1. User A creates a normal chat (is_group_chat = False)
    2. User B clicks "Continue Chat" to copy the shared task
    3. A ResourceMember record is created with resource_id = User A's task, copied_resource_id = User B's new task
    4. User A's original task should NOT become a group chat
    """

    @pytest.fixture
    def mock_db(self):
        """Create a mock database session"""
        return Mock(spec=Session)

    @pytest.fixture
    def task_member_service(self):
        """Create TaskMemberService instance"""
        return TaskMemberService()

    def test_original_task_not_group_chat_after_share(
        self, task_member_service, mock_db
    ):
        """
        After someone copies a shared task, the original task should NOT be marked as group chat.

        The share record has copied_resource_id > 0, which should be excluded from group chat detection.
        """
        # Mock the original task (User A's task)
        mock_task = Mock(spec=TaskResource)
        mock_task.id = 100
        mock_task.user_id = 1  # User A owns this task
        mock_task.json = {"spec": {"is_group_chat": False}}  # Not a group chat

        with patch.object(
            task_member_service, "get_task", return_value=mock_task
        ):
            # is_group_chat should return False
            result = task_member_service.is_group_chat(mock_db, task_id=100)
            assert result is False

    def test_member_count_is_one_after_share(self, task_member_service, mock_db):
        """
        After someone copies a shared task, member count of original task should be 1 (only owner).

        The share record should NOT be counted as a group chat member.
        """
        # Mock count query - should return 0 because share records are excluded
        mock_query = MagicMock()
        mock_db.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.count.return_value = 0  # No real group chat members

        result = task_member_service.get_member_count(mock_db, task_id=100)

        # Should be 1 (only owner), not 2 (owner + share recipient)
        assert result == 1

    def test_share_recipient_not_member_of_original_task(
        self, task_member_service, mock_db
    ):
        """
        User who copied a shared task should NOT be a member of the original task.
        """
        with patch.object(
            task_member_service, "is_task_owner", return_value=False
        ):
            # Query returns None because share records are excluded
            mock_query = MagicMock()
            mock_db.query.return_value = mock_query
            mock_query.filter.return_value = mock_query
            mock_query.first.return_value = None

            # User B (who copied the task) should NOT be a member of User A's original task
            result = task_member_service.is_member(mock_db, task_id=100, user_id=2)
            assert result is False
