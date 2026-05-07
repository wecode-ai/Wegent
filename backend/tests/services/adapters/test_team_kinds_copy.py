# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from sqlalchemy.orm import Session

from app.core.security import get_password_hash
from app.models.kind import Kind
from app.models.user import User
from app.services.adapters.team_kinds import team_kinds_service


def _create_user(test_db: Session, user_name: str, email: str) -> User:
    user = User(
        user_name=user_name,
        password_hash=get_password_hash("testpassword123"),
        email=email,
        is_active=True,
        git_info=None,
    )
    test_db.add(user)
    test_db.commit()
    test_db.refresh(user)
    return user


def _create_bot(test_db: Session, *, user_id: int, name: str, namespace: str = "default") -> Kind:
    bot = Kind(
        user_id=user_id,
        kind="Bot",
        name=name,
        namespace=namespace,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Bot",
            "metadata": {"name": name, "namespace": namespace},
            "spec": {
                "ghostRef": {"name": f"ghost-{name}", "namespace": namespace},
                "shellRef": {"name": "ClaudeCode", "namespace": "default"},
            },
        },
        is_active=True,
    )
    test_db.add(bot)
    test_db.commit()
    test_db.refresh(bot)
    return bot


def _create_ghost(test_db: Session, *, user_id: int, name: str, namespace: str = "default") -> Kind:
    ghost = Kind(
        user_id=user_id,
        kind="Ghost",
        name=name,
        namespace=namespace,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Ghost",
            "metadata": {"name": name, "namespace": namespace},
            "spec": {"systemPrompt": "test prompt", "mcpServers": {}},
        },
        is_active=True,
    )
    test_db.add(ghost)
    test_db.commit()
    test_db.refresh(ghost)
    return ghost


def _create_shell(test_db: Session, *, user_id: int = 0, name: str = "ClaudeCode", namespace: str = "default") -> Kind:
    shell = Kind(
        user_id=user_id,
        kind="Shell",
        name=name,
        namespace=namespace,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Shell",
            "metadata": {"name": name, "namespace": namespace, "labels": {"type": "local_engine"}},
            "spec": {"shellType": "ClaudeCode", "baseImage": "test-image:latest"},
            "status": {"state": "Available"},
        },
        is_active=True,
    )
    test_db.add(shell)
    test_db.commit()
    test_db.refresh(shell)
    return shell


def _create_team(
    test_db: Session,
    *,
    user_id: int,
    name: str,
    namespace: str = "default",
    collaboration_model: str = "pipeline",
    bot_ids: list[int] | None = None,
) -> Kind:
    members = []
    if bot_ids:
        for bot_id in bot_ids:
            bot = test_db.query(Kind).filter(Kind.id == bot_id).first()
            members.append({
                "botRef": {"name": bot.name, "namespace": bot.namespace},
                "prompt": "",
                "role": "leader" if bot_id == bot_ids[0] else "member",
            })
    team = Kind(
        user_id=user_id,
        kind="Team",
        name=name,
        namespace=namespace,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Team",
            "metadata": {"name": name, "namespace": namespace},
            "spec": {
                "collaborationModel": collaboration_model,
                "members": members,
                "bind_mode": ["chat"],
            },
        },
        is_active=True,
    )
    test_db.add(team)
    test_db.commit()
    test_db.refresh(team)
    return team


class TestCopyTeamNonSolo:
    def test_copy_non_solo_team_creates_new_team(self, test_db: Session):
        """Non-solo copy: creates new team, same bot references, name prefixed."""
        user = _create_user(test_db, "copy_user1", "copy1@test.com")
        _create_shell(test_db, name="ClaudeCode", namespace="default")
        bot = _create_bot(test_db, user_id=user.id, name="my-bot")
        team = _create_team(
            test_db,
            user_id=user.id,
            name="my-team",
            collaboration_model="pipeline",
            bot_ids=[bot.id],
        )

        result = team_kinds_service.copy_team(test_db, team_id=team.id, user_id=user.id)

        assert result["name"] == "Copy of my-team"
        assert result["id"] != team.id

    def test_copy_non_solo_team_does_not_clone_bots(self, test_db: Session):
        """Non-solo copy: bot count stays the same (no new bots created)."""
        user = _create_user(test_db, "copy_user2", "copy2@test.com")
        _create_shell(test_db, name="ClaudeCode", namespace="default")
        bot = _create_bot(test_db, user_id=user.id, name="shared-bot")
        team = _create_team(
            test_db,
            user_id=user.id,
            name="pipeline-team",
            collaboration_model="pipeline",
            bot_ids=[bot.id],
        )
        before_count = test_db.query(Kind).filter(Kind.kind == "Bot", Kind.is_active == True).count()

        team_kinds_service.copy_team(test_db, team_id=team.id, user_id=user.id)

        after_count = test_db.query(Kind).filter(Kind.kind == "Bot", Kind.is_active == True).count()
        assert after_count == before_count


class TestCopyTeamSolo:
    def test_copy_solo_team_clones_bot(self, test_db: Session):
        """Solo copy: creates new bot with 'Copy of' prefix."""
        user = _create_user(test_db, "copy_user3", "copy3@test.com")
        _create_shell(test_db)
        ghost = _create_ghost(test_db, user_id=user.id, name="ghost-solo-bot")
        bot = _create_bot(test_db, user_id=user.id, name="solo-bot")
        team = _create_team(
            test_db,
            user_id=user.id,
            name="solo-team",
            collaboration_model="solo",
            bot_ids=[bot.id],
        )
        before_count = test_db.query(Kind).filter(Kind.kind == "Bot", Kind.is_active == True).count()

        result = team_kinds_service.copy_team(test_db, team_id=team.id, user_id=user.id)

        after_count = test_db.query(Kind).filter(Kind.kind == "Bot", Kind.is_active == True).count()
        assert after_count == before_count + 1
        assert result["name"] == "Copy of solo-team"

    def test_copy_solo_team_new_bot_name_prefixed(self, test_db: Session):
        """Solo copy: new bot has 'Copy of' prefix."""
        user = _create_user(test_db, "copy_user4", "copy4@test.com")
        _create_shell(test_db, name="ClaudeCode", namespace="default")
        _create_ghost(test_db, user_id=user.id, name="ghost-original-bot")
        bot = _create_bot(test_db, user_id=user.id, name="original-bot")
        team = _create_team(
            test_db,
            user_id=user.id,
            name="my-solo-team",
            collaboration_model="solo",
            bot_ids=[bot.id],
        )

        result = team_kinds_service.copy_team(test_db, team_id=team.id, user_id=user.id)

        # The result contains bot_id, not botRef - look up the bot name from the result
        new_bot_id = result["bots"][0]["bot_id"]
        new_bot = test_db.query(Kind).filter(Kind.id == new_bot_id).first()
        assert new_bot.name == "Copy of original-bot"


class TestCopyTeamErrors:
    def test_copy_nonexistent_team_raises_404(self, test_db: Session):
        """Copy of nonexistent team raises HTTPException 404."""
        from fastapi import HTTPException
        user = _create_user(test_db, "copy_user5", "copy5@test.com")

        with pytest.raises(HTTPException) as exc_info:
            team_kinds_service.copy_team(test_db, team_id=99999, user_id=user.id)

        assert exc_info.value.status_code == 404
