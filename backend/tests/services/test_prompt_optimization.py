# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import MagicMock, patch

import pytest

from app.schemas.base_role import BaseRole
from app.schemas.prompt_optimization import PromptChange
from app.services.prompt_optimization import (
    apply_prompt_changes,
    assemble_team_prompt,
    can_edit_prompt,
    can_view_prompt,
)


@pytest.fixture
def mock_team():
    team = MagicMock()
    team.id = 1
    team.name = "test-team"
    team.user_id = 1
    team.namespace = "default"
    team.json = {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Team",
        "metadata": {"name": "test-team", "namespace": "default"},
        "spec": {
            "members": [
                {
                    "botRef": {"name": "bot1", "namespace": "default"},
                    "prompt": "Focus on security",
                    "role": "leader",
                }
            ],
            "collaborationModel": "coordinate",
        },
    }
    return team


@pytest.fixture
def mock_bot():
    bot = MagicMock()
    bot.id = 1
    bot.name = "bot1"
    bot.namespace = "default"
    bot.json = {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Bot",
        "metadata": {"name": "bot1", "namespace": "default"},
        "spec": {
            "ghostRef": {"name": "ghost1", "namespace": "default"},
            "shellRef": {"name": "ClaudeCode", "namespace": "default"},
        },
    }
    return bot


@pytest.fixture
def mock_ghost():
    ghost = MagicMock()
    ghost.id = 1
    ghost.name = "ghost1"
    ghost.namespace = "default"
    ghost.json = {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Ghost",
        "metadata": {"name": "ghost1", "namespace": "default"},
        "spec": {"systemPrompt": "You are a code reviewer."},
    }
    return ghost


class TestAssembleTeamPrompt:
    @patch("app.services.prompt_optimization.kindReader.get_by_name_and_namespace")
    def test_assemble_single_bot_team(
        self, mock_get_kind, mock_team, mock_bot, mock_ghost
    ):
        mock_get_kind.side_effect = [mock_bot, mock_ghost]

        # Create mock db
        mock_db = MagicMock()
        mock_db.query.return_value.filter.return_value.first.return_value = mock_team

        assembled, sources = assemble_team_prompt(mock_db, 1, 1)

        assert "You are a code reviewer." in assembled
        assert "Focus on security" in assembled
        assert len(sources) == 2
        assert sources[0].type == "ghost"
        assert sources[1].type == "member"


class TestPermissionChecks:
    @patch("app.services.prompt_optimization.get_effective_role_in_group")
    def test_owner_can_view_and_edit(self, mock_get_role):
        user = MagicMock()
        user.id = 1
        user.role = "user"

        resource = MagicMock()
        resource.user_id = 1
        resource.namespace = "default"

        assert can_view_prompt(None, user, resource) is True
        assert can_edit_prompt(None, user, resource) is True

    @patch("app.services.prompt_optimization.get_effective_role_in_group")
    def test_admin_can_view_and_edit(self, mock_get_role):
        user = MagicMock()
        user.id = 2
        user.role = "admin"

        resource = MagicMock()
        resource.user_id = 1
        resource.namespace = "default"

        assert can_view_prompt(None, user, resource) is True
        assert can_edit_prompt(None, user, resource) is True

    @patch("app.services.prompt_optimization.get_effective_role_in_group")
    def test_non_owner_in_default_namespace_cannot_view_or_edit(self, mock_get_role):
        user = MagicMock()
        user.id = 2
        user.role = "user"

        resource = MagicMock()
        resource.user_id = 1
        resource.namespace = "default"

        assert can_view_prompt(None, user, resource) is False
        assert can_edit_prompt(None, user, resource) is False

    @patch("app.services.prompt_optimization.get_effective_role_in_group")
    def test_developer_can_view_and_edit(self, mock_get_role):
        mock_get_role.return_value = BaseRole.Developer

        user = MagicMock()
        user.id = 2
        user.role = "user"

        resource = MagicMock()
        resource.user_id = 1
        resource.namespace = "my-group"

        assert can_view_prompt(None, user, resource) is True
        assert can_edit_prompt(None, user, resource) is True

    @patch("app.services.prompt_optimization.get_effective_role_in_group")
    def test_reporter_can_view_but_not_edit(self, mock_get_role):
        mock_get_role.return_value = BaseRole.Reporter

        user = MagicMock()
        user.id = 2
        user.role = "user"

        resource = MagicMock()
        resource.user_id = 1
        resource.namespace = "my-group"

        assert can_view_prompt(None, user, resource) is True
        assert can_edit_prompt(None, user, resource) is False

    @patch("app.services.prompt_optimization.get_effective_role_in_group")
    def test_restricted_analyst_cannot_view_or_edit(self, mock_get_role):
        mock_get_role.return_value = BaseRole.RestrictedAnalyst

        user = MagicMock()
        user.id = 2
        user.role = "user"

        resource = MagicMock()
        resource.user_id = 1
        resource.namespace = "my-group"

        assert can_view_prompt(None, user, resource) is False
        assert can_edit_prompt(None, user, resource) is False

    @patch("app.services.prompt_optimization.get_effective_role_in_group")
    def test_no_group_role_cannot_view_or_edit(self, mock_get_role):
        mock_get_role.return_value = None

        user = MagicMock()
        user.id = 2
        user.role = "user"

        resource = MagicMock()
        resource.user_id = 1
        resource.namespace = "my-group"

        assert can_view_prompt(None, user, resource) is False
        assert can_edit_prompt(None, user, resource) is False

    @patch("app.services.prompt_optimization.get_effective_role_in_group")
    def test_maintainer_can_view_and_edit(self, mock_get_role):
        mock_get_role.return_value = BaseRole.Maintainer

        user = MagicMock()
        user.id = 2
        user.role = "user"

        resource = MagicMock()
        resource.user_id = 1
        resource.namespace = "my-group"

        assert can_view_prompt(None, user, resource) is True
        assert can_edit_prompt(None, user, resource) is True

    @patch("app.services.prompt_optimization.get_effective_role_in_group")
    def test_owner_can_view_and_edit_in_group_namespace(self, mock_get_role):
        user = MagicMock()
        user.id = 1
        user.role = "user"

        resource = MagicMock()
        resource.user_id = 1
        resource.namespace = "my-group"

        assert can_view_prompt(None, user, resource) is True
        assert can_edit_prompt(None, user, resource) is True
        # Should not need to check group role for owner
        mock_get_role.assert_not_called()


class TestApplyPromptChanges:
    @patch("app.services.prompt_optimization.can_edit_prompt")
    def test_apply_ghost_change(self, mock_can_edit):
        mock_can_edit.return_value = True

        # Setup mock ghost
        mock_ghost = MagicMock()
        mock_ghost.id = 1
        mock_ghost.json = {
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Ghost",
            "metadata": {"name": "ghost1", "namespace": "default"},
            "spec": {"systemPrompt": "old prompt"},
        }

        mock_db = MagicMock()
        mock_db.query.return_value.filter.return_value.first.return_value = mock_ghost

        user = MagicMock()
        changes = [
            PromptChange(type="ghost", id=1, field="systemPrompt", value="new prompt")
        ]

        result = apply_prompt_changes(mock_db, user, 1, changes)

        assert result.success is True
        assert result.applied_changes == 1
        assert len(result.errors) == 0

    @patch("app.services.prompt_optimization.can_edit_prompt")
    def test_apply_ghost_change_no_permission(self, mock_can_edit):
        mock_can_edit.return_value = False

        # Setup mock ghost
        mock_ghost = MagicMock()
        mock_ghost.id = 1
        mock_ghost.json = {
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Ghost",
            "metadata": {"name": "ghost1", "namespace": "default"},
            "spec": {"systemPrompt": "old prompt"},
        }

        mock_db = MagicMock()
        mock_db.query.return_value.filter.return_value.first.return_value = mock_ghost

        user = MagicMock()
        changes = [
            PromptChange(type="ghost", id=1, field="systemPrompt", value="new prompt")
        ]

        result = apply_prompt_changes(mock_db, user, 1, changes)

        assert result.success is False
        assert result.applied_changes == 0
        assert len(result.errors) == 1
        assert "No permission" in result.errors[0]

    @patch("app.services.prompt_optimization.can_edit_prompt")
    def test_apply_ghost_not_found(self, mock_can_edit):
        mock_db = MagicMock()
        mock_db.query.return_value.filter.return_value.first.return_value = None

        user = MagicMock()
        changes = [
            PromptChange(type="ghost", id=999, field="systemPrompt", value="new prompt")
        ]

        result = apply_prompt_changes(mock_db, user, 1, changes)

        assert result.success is False
        assert result.applied_changes == 0
        assert len(result.errors) == 1
        assert "not found" in result.errors[0]

    @patch("app.services.prompt_optimization.can_edit_prompt")
    def test_apply_member_change(self, mock_can_edit):
        mock_can_edit.return_value = True

        # Setup mock team with valid Team CRD structure
        mock_team = MagicMock()
        mock_team.id = 1
        mock_team.json = {
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Team",
            "metadata": {"name": "test-team", "namespace": "default"},
            "spec": {
                "members": [
                    {
                        "botRef": {"name": "bot1", "namespace": "default"},
                        "prompt": "old prompt",
                    }
                ],
                "collaborationModel": "coordinate",
            },
        }

        mock_db = MagicMock()
        mock_db.query.return_value.filter.return_value.first.return_value = mock_team

        user = MagicMock()
        changes = [PromptChange(type="member", team_id=1, index=0, value="new prompt")]

        result = apply_prompt_changes(mock_db, user, 1, changes)

        assert result.success is True
        assert result.applied_changes == 1
        assert len(result.errors) == 0

    @patch("app.services.prompt_optimization.can_edit_prompt")
    def test_apply_member_change_invalid_index(self, mock_can_edit):
        mock_can_edit.return_value = True

        # Setup mock team with only 1 member
        mock_team = MagicMock()
        mock_team.id = 1
        mock_team.json = {
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Team",
            "metadata": {"name": "test-team", "namespace": "default"},
            "spec": {
                "members": [
                    {
                        "botRef": {"name": "bot1", "namespace": "default"},
                        "prompt": "old prompt",
                    }
                ],
                "collaborationModel": "coordinate",
            },
        }

        mock_db = MagicMock()
        mock_db.query.return_value.filter.return_value.first.return_value = mock_team

        user = MagicMock()
        changes = [PromptChange(type="member", team_id=1, index=5, value="new prompt")]

        result = apply_prompt_changes(mock_db, user, 1, changes)

        assert result.success is False
        assert result.applied_changes == 0
        assert len(result.errors) == 1
        assert "Invalid member index" in result.errors[0]

    @patch("app.services.prompt_optimization.can_edit_prompt")
    def test_apply_multiple_changes_partial_failure(self, mock_can_edit):
        # First call allows edit, second denies
        mock_can_edit.side_effect = [True, False]

        # Setup mock ghost
        mock_ghost = MagicMock()
        mock_ghost.id = 1
        mock_ghost.json = {
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Ghost",
            "metadata": {"name": "ghost1", "namespace": "default"},
            "spec": {"systemPrompt": "old prompt"},
        }

        mock_db = MagicMock()
        mock_db.query.return_value.filter.return_value.first.return_value = mock_ghost

        user = MagicMock()
        changes = [
            PromptChange(
                type="ghost", id=1, field="systemPrompt", value="new prompt 1"
            ),
            PromptChange(
                type="ghost", id=2, field="systemPrompt", value="new prompt 2"
            ),
        ]

        result = apply_prompt_changes(mock_db, user, 1, changes)

        assert result.success is False
        assert result.applied_changes == 1
        assert len(result.errors) == 1
