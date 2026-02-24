# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for group role to permission level mapping.
"""

from app.schemas.namespace import GroupRole
from app.services.knowledge.knowledge_service import GROUP_ROLE_TO_PERMISSION_LEVEL


class TestPermissionLevelMapping:
    """Test the GROUP_ROLE_TO_PERMISSION_LEVEL mapping."""

    def test_owner_maps_to_manage(self):
        """Owner role should map to 'manage' permission."""
        assert GROUP_ROLE_TO_PERMISSION_LEVEL[GroupRole.Owner] == "manage"

    def test_maintainer_maps_to_manage(self):
        """Maintainer role should map to 'manage' permission."""
        assert GROUP_ROLE_TO_PERMISSION_LEVEL[GroupRole.Maintainer] == "manage"

    def test_developer_maps_to_edit(self):
        """Developer role should map to 'edit' permission."""
        assert GROUP_ROLE_TO_PERMISSION_LEVEL[GroupRole.Developer] == "edit"

    def test_reporter_maps_to_view(self):
        """Reporter role should map to 'view' permission."""
        assert GROUP_ROLE_TO_PERMISSION_LEVEL[GroupRole.Reporter] == "view"
