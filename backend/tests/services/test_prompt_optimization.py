# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import MagicMock, patch

import pytest

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


@pytest.mark.parametrize(
    "group_role,owner,admin,namespace,view,edit",
    [
        (None, True, False, "default", True, True),
        (None, False, True, "default", True, True),
        (None, False, False, "default", False, False),
        ("Developer", False, False, "my-group", True, True),
        ("Reporter", False, False, "my-group", True, False),
        ("RestrictedAnalyst", False, False, "my-group", False, False),
        (None, False, False, "my-group", False, False),
        ("Maintainer", False, False, "my-group", True, True),
        (None, True, False, "my-group", True, True),
    ],
)
def test_permission_checks_use_real_group_membership(
    test_db, test_user, group_role, owner, admin, namespace, view, edit
):
    from app.models.kind import Kind
    from app.models.namespace import Namespace
    from app.models.resource_member import ResourceMember

    test_user.role = "admin" if admin else "user"
    resource = Kind(
        kind="Team",
        name="prompt-permissions",
        namespace=namespace,
        user_id=test_user.id if owner else 0,
        is_active=True,
        json={},
    )
    test_db.add(resource)
    if namespace != "default":
        group = Namespace(name=namespace, owner_user_id=0, is_active=True)
        test_db.add(group)
        test_db.flush()
        if group_role:
            test_db.add(
                ResourceMember(
                    resource_type="Namespace",
                    resource_id=group.id,
                    entity_type="user",
                    entity_id=str(test_user.id),
                    role=group_role,
                    status="approved",
                )
            )
    test_db.flush()
    assert can_view_prompt(test_db, test_user, resource) is view
    assert can_edit_prompt(test_db, test_user, resource) is edit


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
