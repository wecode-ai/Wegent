# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for the copy_to_group functionality in TeamKindsService.
"""

import pytest
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.namespace import Namespace
from app.models.namespace_member import NamespaceMember
from app.models.user import User
from app.services.adapters.team_kinds import team_kinds_service


@pytest.fixture
def test_group(test_db: Session, test_user: User) -> Namespace:
    """Create a test group."""
    group = Namespace(
        name="test-group",
        display_name="Test Group",
        owner_user_id=test_user.id,
        visibility="private",
        is_active=True,
    )
    test_db.add(group)
    test_db.commit()
    test_db.refresh(group)
    return group


@pytest.fixture
def test_group_membership(
    test_db: Session, test_user: User, test_group: Namespace
) -> NamespaceMember:
    """Create a group membership with Developer role."""
    member = NamespaceMember(
        group_name=test_group.name,
        user_id=test_user.id,
        role="Developer",
        is_active=True,
    )
    test_db.add(member)
    test_db.commit()
    test_db.refresh(member)
    return member


@pytest.fixture
def test_shell(test_db: Session) -> Kind:
    """Create a public shell for testing."""
    shell = Kind(
        user_id=0,  # Public shell
        kind="Shell",
        name="test-shell",
        namespace="default",
        json={
            "kind": "Shell",
            "apiVersion": "agent.wecode.io/v1",
            "metadata": {"name": "test-shell", "namespace": "default"},
            "spec": {"shellType": "ClaudeCode"},
            "status": {"state": "Available"},
        },
        is_active=True,
    )
    test_db.add(shell)
    test_db.commit()
    test_db.refresh(shell)
    return shell


@pytest.fixture
def test_ghost(test_db: Session, test_user: User) -> Kind:
    """Create a ghost for the test bot."""
    ghost = Kind(
        user_id=test_user.id,
        kind="Ghost",
        name="test-bot-ghost",
        namespace="default",
        json={
            "kind": "Ghost",
            "apiVersion": "agent.wecode.io/v1",
            "metadata": {"name": "test-bot-ghost", "namespace": "default"},
            "spec": {"systemPrompt": "Test prompt", "mcpServers": {}},
            "status": {"state": "Available"},
        },
        is_active=True,
    )
    test_db.add(ghost)
    test_db.commit()
    test_db.refresh(ghost)
    return ghost


@pytest.fixture
def test_bot(
    test_db: Session, test_user: User, test_shell: Kind, test_ghost: Kind
) -> Kind:
    """Create a personal bot for testing."""
    bot = Kind(
        user_id=test_user.id,
        kind="Bot",
        name="test-bot",
        namespace="default",
        json={
            "kind": "Bot",
            "apiVersion": "agent.wecode.io/v1",
            "metadata": {"name": "test-bot", "namespace": "default"},
            "spec": {
                "ghostRef": {"name": "test-bot-ghost", "namespace": "default"},
                "shellRef": {"name": "test-shell", "namespace": "default"},
            },
            "status": {"state": "Available"},
        },
        is_active=True,
    )
    test_db.add(bot)
    test_db.commit()
    test_db.refresh(bot)
    return bot


@pytest.fixture
def test_team(test_db: Session, test_user: User, test_bot: Kind) -> Kind:
    """Create a personal team for testing."""
    team = Kind(
        user_id=test_user.id,
        kind="Team",
        name="test-team",
        namespace="default",
        json={
            "kind": "Team",
            "apiVersion": "agent.wecode.io/v1",
            "metadata": {
                "name": "test-team",
                "namespace": "default",
                "labels": {"share_status": "0"},
            },
            "spec": {
                "members": [
                    {
                        "botRef": {"name": "test-bot", "namespace": "default"},
                        "prompt": "Test prompt",
                        "role": "worker",
                        "requireConfirmation": False,
                    }
                ],
                "collaborationModel": "pipeline",
                "description": "Test team description",
                "bind_mode": ["chat", "code"],
            },
            "status": {"state": "Available"},
        },
        is_active=True,
    )
    test_db.add(team)
    test_db.commit()
    test_db.refresh(team)
    return team


class TestCopyToGroup:
    """Test cases for copy_to_group method."""

    def test_copy_team_to_group_success(
        self,
        test_db: Session,
        test_user: User,
        test_team: Kind,
        test_bot: Kind,
        test_ghost: Kind,
        test_group: Namespace,
        test_group_membership: NamespaceMember,
    ):
        """Test successful copy of a team to a group."""
        result = team_kinds_service.copy_to_group(
            db=test_db,
            team_id=test_team.id,
            user_id=test_user.id,
            target_group_name=test_group.name,
        )

        assert result["name"] == "test-team"
        assert result["namespace"] == test_group.name
        assert len(result["copied_bots"]) == 1
        assert result["copied_bots"][0]["name"] == "test-bot"

        # Verify new team was created
        new_team = (
            test_db.query(Kind)
            .filter(
                Kind.kind == "Team",
                Kind.name == "test-team",
                Kind.namespace == test_group.name,
                Kind.is_active == True,
            )
            .first()
        )
        assert new_team is not None
        assert new_team.user_id == test_user.id

        # Verify new bot was created
        new_bot = (
            test_db.query(Kind)
            .filter(
                Kind.kind == "Bot",
                Kind.name == "test-bot",
                Kind.namespace == test_group.name,
                Kind.is_active == True,
            )
            .first()
        )
        assert new_bot is not None
        assert new_bot.user_id == test_user.id

    def test_copy_team_not_found(
        self,
        test_db: Session,
        test_user: User,
        test_group: Namespace,
        test_group_membership: NamespaceMember,
    ):
        """Test copy with non-existent team."""
        from fastapi import HTTPException

        with pytest.raises(HTTPException) as exc_info:
            team_kinds_service.copy_to_group(
                db=test_db,
                team_id=99999,
                user_id=test_user.id,
                target_group_name=test_group.name,
            )
        assert exc_info.value.status_code == 404
        assert "Team not found" in str(exc_info.value.detail)

    def test_copy_team_not_owned(
        self,
        test_db: Session,
        test_team: Kind,
        test_group: Namespace,
        test_group_membership: NamespaceMember,
    ):
        """Test copy when user doesn't own the team."""
        from fastapi import HTTPException

        # Create another user
        other_user = User(
            user_name="otheruser",
            password_hash="hash",
            email="other@example.com",
            is_active=True,
        )
        test_db.add(other_user)
        test_db.commit()
        test_db.refresh(other_user)

        # Add other user to group
        other_membership = NamespaceMember(
            group_name=test_group.name,
            user_id=other_user.id,
            role="Developer",
            is_active=True,
        )
        test_db.add(other_membership)
        test_db.commit()

        with pytest.raises(HTTPException) as exc_info:
            team_kinds_service.copy_to_group(
                db=test_db,
                team_id=test_team.id,
                user_id=other_user.id,
                target_group_name=test_group.name,
            )
        assert exc_info.value.status_code == 403
        assert "You can only copy your own teams" in str(exc_info.value.detail)

    def test_copy_group_team_fails(
        self,
        test_db: Session,
        test_user: User,
        test_group: Namespace,
        test_group_membership: NamespaceMember,
    ):
        """Test that copying a group team (non-personal) fails."""
        from fastapi import HTTPException

        # Create a team in the group namespace
        group_team = Kind(
            user_id=test_user.id,
            kind="Team",
            name="group-team",
            namespace=test_group.name,
            json={
                "kind": "Team",
                "apiVersion": "agent.wecode.io/v1",
                "metadata": {"name": "group-team", "namespace": test_group.name},
                "spec": {"members": [], "collaborationModel": "pipeline"},
                "status": {"state": "Available"},
            },
            is_active=True,
        )
        test_db.add(group_team)
        test_db.commit()
        test_db.refresh(group_team)

        with pytest.raises(HTTPException) as exc_info:
            team_kinds_service.copy_to_group(
                db=test_db,
                team_id=group_team.id,
                user_id=test_user.id,
                target_group_name=test_group.name,
            )
        assert exc_info.value.status_code == 400
        assert "Only personal teams can be copied" in str(exc_info.value.detail)

    def test_copy_insufficient_permission(
        self,
        test_db: Session,
        test_user: User,
        test_team: Kind,
        test_group: Namespace,
    ):
        """Test copy when user doesn't have Developer+ permission in target group."""
        from fastapi import HTTPException

        # Create membership with Reporter role (insufficient)
        reporter_membership = NamespaceMember(
            group_name=test_group.name,
            user_id=test_user.id,
            role="Reporter",
            is_active=True,
        )
        test_db.add(reporter_membership)
        test_db.commit()

        with pytest.raises(HTTPException) as exc_info:
            team_kinds_service.copy_to_group(
                db=test_db,
                team_id=test_team.id,
                user_id=test_user.id,
                target_group_name=test_group.name,
            )
        assert exc_info.value.status_code == 403
        assert "Developer role" in str(exc_info.value.detail)

    def test_copy_target_group_not_exists(
        self,
        test_db: Session,
        test_user: User,
        test_team: Kind,
    ):
        """Test copy when target group doesn't exist."""
        from fastapi import HTTPException

        with pytest.raises(HTTPException) as exc_info:
            team_kinds_service.copy_to_group(
                db=test_db,
                team_id=test_team.id,
                user_id=test_user.id,
                target_group_name="non-existent-group",
            )
        # Will fail on permission check first
        assert exc_info.value.status_code in [403, 404]

    def test_copy_duplicate_team_name(
        self,
        test_db: Session,
        test_user: User,
        test_team: Kind,
        test_group: Namespace,
        test_group_membership: NamespaceMember,
    ):
        """Test copy when team with same name already exists in target group."""
        from fastapi import HTTPException

        # Create a team with same name in target group
        existing_team = Kind(
            user_id=test_user.id,
            kind="Team",
            name="test-team",
            namespace=test_group.name,
            json={
                "kind": "Team",
                "apiVersion": "agent.wecode.io/v1",
                "metadata": {"name": "test-team", "namespace": test_group.name},
                "spec": {"members": [], "collaborationModel": "pipeline"},
                "status": {"state": "Available"},
            },
            is_active=True,
        )
        test_db.add(existing_team)
        test_db.commit()

        with pytest.raises(HTTPException) as exc_info:
            team_kinds_service.copy_to_group(
                db=test_db,
                team_id=test_team.id,
                user_id=test_user.id,
                target_group_name=test_group.name,
            )
        assert exc_info.value.status_code == 400
        assert "already exists" in str(exc_info.value.detail)

    def test_copy_with_public_bot_reference(
        self,
        test_db: Session,
        test_user: User,
        test_shell: Kind,
        test_group: Namespace,
        test_group_membership: NamespaceMember,
    ):
        """Test copy when team has a public bot (should reference, not copy)."""
        # Create a public ghost
        public_ghost = Kind(
            user_id=0,
            kind="Ghost",
            name="public-bot-ghost",
            namespace="default",
            json={
                "kind": "Ghost",
                "apiVersion": "agent.wecode.io/v1",
                "metadata": {"name": "public-bot-ghost", "namespace": "default"},
                "spec": {"systemPrompt": "Public bot", "mcpServers": {}},
                "status": {"state": "Available"},
            },
            is_active=True,
        )
        test_db.add(public_ghost)
        test_db.commit()

        # Create a public bot
        public_bot = Kind(
            user_id=0,
            kind="Bot",
            name="public-bot",
            namespace="default",
            json={
                "kind": "Bot",
                "apiVersion": "agent.wecode.io/v1",
                "metadata": {"name": "public-bot", "namespace": "default"},
                "spec": {
                    "ghostRef": {"name": "public-bot-ghost", "namespace": "default"},
                    "shellRef": {"name": "test-shell", "namespace": "default"},
                },
                "status": {"state": "Available"},
            },
            is_active=True,
        )
        test_db.add(public_bot)
        test_db.commit()
        test_db.refresh(public_bot)

        # Create team with public bot
        team_with_public_bot = Kind(
            user_id=test_user.id,
            kind="Team",
            name="team-with-public-bot",
            namespace="default",
            json={
                "kind": "Team",
                "apiVersion": "agent.wecode.io/v1",
                "metadata": {"name": "team-with-public-bot", "namespace": "default"},
                "spec": {
                    "members": [
                        {
                            "botRef": {"name": "public-bot", "namespace": "default"},
                            "prompt": "",
                            "role": "worker",
                            "requireConfirmation": False,
                        }
                    ],
                    "collaborationModel": "pipeline",
                },
                "status": {"state": "Available"},
            },
            is_active=True,
        )
        test_db.add(team_with_public_bot)
        test_db.commit()
        test_db.refresh(team_with_public_bot)

        result = team_kinds_service.copy_to_group(
            db=test_db,
            team_id=team_with_public_bot.id,
            user_id=test_user.id,
            target_group_name=test_group.name,
        )

        # Public bot should be referenced, not copied
        assert len(result["copied_bots"]) == 0
        assert len(result["referenced_bots"]) == 1
        assert result["referenced_bots"][0]["name"] == "public-bot"
