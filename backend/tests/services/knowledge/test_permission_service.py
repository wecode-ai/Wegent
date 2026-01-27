# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for knowledge permission service.
"""

from unittest.mock import MagicMock, patch

import pytest

from app.models.kind import Kind
from app.models.permission import Permission
from app.models.user import User
from app.schemas.namespace import GroupRole
from app.services.knowledge.permission_service import (
    can_access_knowledge_base,
    can_manage_knowledge_base,
    can_write_knowledge_base,
    get_permission_source,
    get_user_permission_type,
)


@pytest.fixture
def mock_db():
    """Create a mock database session."""
    return MagicMock()


@pytest.fixture
def mock_user():
    """Create a mock user."""
    user = MagicMock(spec=User)
    user.id = 1
    user.user_name = "testuser"
    user.role = "user"
    return user


@pytest.fixture
def mock_admin_user():
    """Create a mock admin user."""
    user = MagicMock(spec=User)
    user.id = 2
    user.user_name = "admin"
    user.role = "admin"
    return user


@pytest.fixture
def personal_kb():
    """Create a mock personal knowledge base."""
    kb = MagicMock(spec=Kind)
    kb.id = 100
    kb.user_id = 1  # Owned by user 1
    kb.namespace = "default"
    kb.json = {"spec": {"name": "Personal KB"}}
    return kb


@pytest.fixture
def organization_kb():
    """Create a mock organization knowledge base."""
    kb = MagicMock(spec=Kind)
    kb.id = 200
    kb.user_id = 2
    kb.namespace = "organization"
    kb.json = {"spec": {"name": "Organization KB"}}
    return kb


@pytest.fixture
def group_kb():
    """Create a mock group knowledge base."""
    kb = MagicMock(spec=Kind)
    kb.id = 300
    kb.user_id = 3
    kb.namespace = "test-group"
    kb.json = {"spec": {"name": "Group KB"}}
    return kb


class TestCanAccessKnowledgeBase:
    """Tests for can_access_knowledge_base function."""

    def test_organization_kb_accessible_by_all(
        self, mock_db, mock_user, organization_kb
    ):
        """Organization KB should be accessible by all users."""
        result = can_access_knowledge_base(mock_db, mock_user.id, organization_kb)
        assert result is True

    def test_personal_kb_accessible_by_owner(self, mock_db, mock_user, personal_kb):
        """Personal KB should be accessible by its owner."""
        mock_db.query.return_value.filter.return_value.first.return_value = None
        result = can_access_knowledge_base(mock_db, mock_user.id, personal_kb)
        assert result is True

    def test_personal_kb_not_accessible_by_non_owner_without_permission(
        self, mock_db, mock_user, personal_kb
    ):
        """Personal KB should not be accessible by non-owner without permission."""
        personal_kb.user_id = 999  # Different owner
        mock_db.query.return_value.filter.return_value.first.return_value = None
        result = can_access_knowledge_base(mock_db, mock_user.id, personal_kb)
        assert result is False

    def test_personal_kb_accessible_by_non_owner_with_permission(
        self, mock_db, mock_user, personal_kb
    ):
        """Personal KB should be accessible by non-owner with explicit permission."""
        personal_kb.user_id = 999  # Different owner
        mock_permission = MagicMock(spec=Permission)
        mock_permission.permission_type = "read"
        mock_db.query.return_value.filter.return_value.first.return_value = (
            mock_permission
        )
        result = can_access_knowledge_base(mock_db, mock_user.id, personal_kb)
        assert result is True

    @patch("app.services.knowledge.permission_service.get_effective_role_in_group")
    def test_group_kb_accessible_by_group_member(
        self, mock_get_role, mock_db, mock_user, group_kb
    ):
        """Group KB should be accessible by group members."""
        mock_get_role.return_value = GroupRole.Reporter
        result = can_access_knowledge_base(mock_db, mock_user.id, group_kb)
        assert result is True

    @patch("app.services.knowledge.permission_service.get_effective_role_in_group")
    def test_group_kb_not_accessible_by_non_member(
        self, mock_get_role, mock_db, mock_user, group_kb
    ):
        """Group KB should not be accessible by non-members."""
        mock_get_role.return_value = None
        result = can_access_knowledge_base(mock_db, mock_user.id, group_kb)
        assert result is False


class TestCanManageKnowledgeBase:
    """Tests for can_manage_knowledge_base function."""

    def test_organization_kb_manageable_by_admin(
        self, mock_db, mock_admin_user, organization_kb
    ):
        """Organization KB should be manageable by admin."""
        result = can_manage_knowledge_base(mock_db, mock_admin_user, organization_kb)
        assert result is True

    def test_organization_kb_not_manageable_by_non_admin(
        self, mock_db, mock_user, organization_kb
    ):
        """Organization KB should not be manageable by non-admin."""
        result = can_manage_knowledge_base(mock_db, mock_user, organization_kb)
        assert result is False

    def test_personal_kb_manageable_by_owner(self, mock_db, mock_user, personal_kb):
        """Personal KB should be manageable by owner."""
        result = can_manage_knowledge_base(mock_db, mock_user, personal_kb)
        assert result is True

    def test_personal_kb_not_manageable_by_non_owner_without_permission(
        self, mock_db, mock_user, personal_kb
    ):
        """Personal KB should not be manageable by non-owner without manage permission."""
        personal_kb.user_id = 999
        mock_db.query.return_value.filter.return_value.first.return_value = None
        result = can_manage_knowledge_base(mock_db, mock_user, personal_kb)
        assert result is False

    @patch("app.services.knowledge.permission_service.get_effective_role_in_group")
    def test_group_kb_manageable_by_owner_role(
        self, mock_get_role, mock_db, mock_user, group_kb
    ):
        """Group KB should be manageable by group Owner."""
        mock_get_role.return_value = GroupRole.Owner
        result = can_manage_knowledge_base(mock_db, mock_user, group_kb)
        assert result is True

    @patch("app.services.knowledge.permission_service.get_effective_role_in_group")
    def test_group_kb_manageable_by_maintainer_role(
        self, mock_get_role, mock_db, mock_user, group_kb
    ):
        """Group KB should be manageable by group Maintainer."""
        mock_get_role.return_value = GroupRole.Maintainer
        result = can_manage_knowledge_base(mock_db, mock_user, group_kb)
        assert result is True

    @patch("app.services.knowledge.permission_service.get_effective_role_in_group")
    def test_group_kb_not_manageable_by_developer_role(
        self, mock_get_role, mock_db, mock_user, group_kb
    ):
        """Group KB should not be manageable by group Developer."""
        mock_get_role.return_value = GroupRole.Developer
        result = can_manage_knowledge_base(mock_db, mock_user, group_kb)
        assert result is False


class TestCanWriteKnowledgeBase:
    """Tests for can_write_knowledge_base function."""

    def test_organization_kb_writable_by_admin(
        self, mock_db, mock_admin_user, organization_kb
    ):
        """Organization KB should be writable by admin."""
        result = can_write_knowledge_base(mock_db, mock_admin_user, organization_kb)
        assert result is True

    def test_organization_kb_not_writable_by_non_admin(
        self, mock_db, mock_user, organization_kb
    ):
        """Organization KB should not be writable by non-admin."""
        result = can_write_knowledge_base(mock_db, mock_user, organization_kb)
        assert result is False

    def test_personal_kb_writable_by_owner(self, mock_db, mock_user, personal_kb):
        """Personal KB should be writable by owner."""
        result = can_write_knowledge_base(mock_db, mock_user, personal_kb)
        assert result is True

    @patch("app.services.knowledge.permission_service.get_effective_role_in_group")
    def test_group_kb_writable_by_maintainer(
        self, mock_get_role, mock_db, mock_user, group_kb
    ):
        """Group KB should be writable by Maintainer."""
        mock_get_role.return_value = GroupRole.Maintainer
        result = can_write_knowledge_base(mock_db, mock_user, group_kb)
        assert result is True


class TestGetUserPermissionType:
    """Tests for get_user_permission_type function."""

    def test_organization_kb_admin_gets_manage(
        self, mock_db, mock_admin_user, organization_kb
    ):
        """Admin should get manage permission for organization KB."""
        result = get_user_permission_type(mock_db, mock_admin_user, organization_kb)
        assert result == "manage"

    def test_organization_kb_non_admin_gets_read(
        self, mock_db, mock_user, organization_kb
    ):
        """Non-admin should get read permission for organization KB."""
        result = get_user_permission_type(mock_db, mock_user, organization_kb)
        assert result == "read"

    def test_personal_kb_owner_gets_manage(self, mock_db, mock_user, personal_kb):
        """Owner should get manage permission for personal KB."""
        result = get_user_permission_type(mock_db, mock_user, personal_kb)
        assert result == "manage"

    @patch("app.services.knowledge.permission_service.get_effective_role_in_group")
    def test_group_kb_owner_role_gets_manage(
        self, mock_get_role, mock_db, mock_user, group_kb
    ):
        """Group Owner should get manage permission."""
        mock_get_role.return_value = GroupRole.Owner
        result = get_user_permission_type(mock_db, mock_user, group_kb)
        assert result == "manage"

    @patch("app.services.knowledge.permission_service.get_effective_role_in_group")
    def test_group_kb_developer_role_gets_write(
        self, mock_get_role, mock_db, mock_user, group_kb
    ):
        """Group Developer should get write permission."""
        mock_get_role.return_value = GroupRole.Developer
        result = get_user_permission_type(mock_db, mock_user, group_kb)
        assert result == "write"

    @patch("app.services.knowledge.permission_service.get_effective_role_in_group")
    def test_group_kb_reporter_role_gets_read(
        self, mock_get_role, mock_db, mock_user, group_kb
    ):
        """Group Reporter should get read permission."""
        mock_get_role.return_value = GroupRole.Reporter
        result = get_user_permission_type(mock_db, mock_user, group_kb)
        assert result == "read"


class TestGetPermissionSource:
    """Tests for get_permission_source function."""

    def test_organization_kb_admin_returns_system_admin(
        self, mock_db, mock_admin_user, organization_kb
    ):
        """Admin accessing organization KB should return system_admin."""
        result = get_permission_source(mock_db, mock_admin_user, organization_kb)
        assert result == "system_admin"

    def test_organization_kb_non_admin_returns_organization_member(
        self, mock_db, mock_user, organization_kb
    ):
        """Non-admin accessing organization KB should return organization_member."""
        result = get_permission_source(mock_db, mock_user, organization_kb)
        assert result == "organization_member"

    def test_personal_kb_owner_returns_owner(self, mock_db, mock_user, personal_kb):
        """Owner accessing personal KB should return owner."""
        result = get_permission_source(mock_db, mock_user, personal_kb)
        assert result == "owner"

    @patch("app.services.knowledge.permission_service.get_effective_role_in_group")
    def test_group_kb_member_returns_group_role(
        self, mock_get_role, mock_db, mock_user, group_kb
    ):
        """Group member should return group_role."""
        mock_get_role.return_value = GroupRole.Developer
        result = get_permission_source(mock_db, mock_user, group_kb)
        assert result == "group_role"

    def test_personal_kb_with_permission_returns_explicit_grant(
        self, mock_db, mock_user, personal_kb
    ):
        """User with explicit permission should return explicit_grant."""
        personal_kb.user_id = 999  # Not the owner
        mock_permission = MagicMock(spec=Permission)
        mock_db.query.return_value.filter.return_value.first.return_value = (
            mock_permission
        )
        result = get_permission_source(mock_db, mock_user, personal_kb)
        assert result == "explicit_grant"

    def test_personal_kb_without_permission_returns_none(
        self, mock_db, mock_user, personal_kb
    ):
        """User without permission should return none."""
        personal_kb.user_id = 999  # Not the owner
        mock_db.query.return_value.filter.return_value.first.return_value = None
        result = get_permission_source(mock_db, mock_user, personal_kb)
        assert result == "none"
