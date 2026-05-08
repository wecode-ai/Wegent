# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from sqlalchemy.orm import Session

from app.core.security import get_password_hash
from app.models.kind import Kind
from app.models.skill_binary import SkillBinary
from app.models.user import User
from app.services.adapters.skill_kinds import skill_kinds_service


def _create_user(test_db: Session, user_name: str, email: str) -> User:
    user = User(
        user_name=user_name,
        password_hash=get_password_hash("testPass123"),
        email=email,
        is_active=True,
        git_info=None,
    )
    test_db.add(user)
    test_db.commit()
    test_db.refresh(user)
    return user


def _create_skill(
    test_db: Session,
    *,
    user_id: int,
    name: str,
    namespace: str = "default",
    binary_data: bytes = b"fake-zip-content",
) -> Kind:
    skill = Kind(
        user_id=user_id,
        kind="Skill",
        name=name,
        namespace=namespace,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Skill",
            "metadata": {"name": name, "namespace": namespace},
            "spec": {"description": f"Test skill {name}", "version": "1.0.0"},
        },
        is_active=True,
    )
    test_db.add(skill)
    test_db.commit()
    test_db.refresh(skill)
    sb = SkillBinary(
        kind_id=skill.id,
        binary_data=binary_data,
        file_size=len(binary_data),
        file_hash="abc123def456",
    )
    test_db.add(sb)
    test_db.commit()
    return skill


class TestCopySkillToNamespace:
    def test_copies_personal_skill_to_group(self, test_db: Session):
        """Personal skill copied to group namespace: new Kind + SkillBinary created."""
        user = _create_user(test_db, "skill_copy_user1", "sc1@test.com")
        skill = _create_skill(test_db, user_id=user.id, name="excel-helper")

        result = skill_kinds_service.copy_skill_to_namespace(
            test_db,
            skill_id=skill.id,
            target_namespace="eng-team",
            user_id=user.id,
        )

        assert result["original_id"] == skill.id
        assert result["target_id"] != skill.id
        assert result["was_copied"] is True
        new_skill = test_db.query(Kind).filter(Kind.id == result["target_id"]).first()
        assert new_skill.namespace == "eng-team"
        assert new_skill.name == "excel-helper"
        # SkillBinary must also exist
        sb = (
            test_db.query(SkillBinary)
            .filter(SkillBinary.kind_id == result["target_id"])
            .first()
        )
        assert sb is not None
        assert sb.binary_data == b"fake-zip-content"

    def test_skips_copy_when_same_name_exists_in_target(self, test_db: Session):
        """If target namespace already has same-name skill, skip copy and return existing."""
        user = _create_user(test_db, "skill_copy_user2", "sc2@test.com")
        personal_skill = _create_skill(test_db, user_id=user.id, name="code-review")
        existing_group_skill = _create_skill(
            test_db, user_id=user.id, name="code-review", namespace="eng-team"
        )

        result = skill_kinds_service.copy_skill_to_namespace(
            test_db,
            skill_id=personal_skill.id,
            target_namespace="eng-team",
            user_id=user.id,
        )

        assert result["original_id"] == personal_skill.id
        assert result["target_id"] == existing_group_skill.id
        assert result["was_copied"] is False
        # No duplicate created
        count = (
            test_db.query(Kind)
            .filter(
                Kind.kind == "Skill",
                Kind.name == "code-review",
                Kind.namespace == "eng-team",
                Kind.is_active == True,
            )
            .count()
        )
        assert count == 1

    def test_raises_if_skill_not_found(self, test_db: Session):
        """Non-existent skill_id raises 404."""
        from fastapi import HTTPException

        user = _create_user(test_db, "skill_copy_user3", "sc3@test.com")
        with pytest.raises(HTTPException) as exc_info:
            skill_kinds_service.copy_skill_to_namespace(
                test_db, skill_id=99999, target_namespace="eng-team", user_id=user.id
            )
        assert exc_info.value.status_code == 404


from app.services.adapters.bot_kinds import bot_kinds_service


def _create_shell(test_db, *, user_id=0, name="ClaudeCode", namespace="default"):
    from app.models.kind import Kind

    shell = Kind(
        user_id=user_id,
        kind="Shell",
        name=name,
        namespace=namespace,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Shell",
            "metadata": {
                "name": name,
                "namespace": namespace,
                "labels": {"type": "local_engine"},
            },
            "spec": {"shellType": "ClaudeCode", "baseImage": "test:latest"},
            "status": {"state": "Available"},
        },
        is_active=True,
    )
    test_db.add(shell)
    test_db.commit()
    test_db.refresh(shell)
    return shell


def _create_bot_with_skills(
    test_db,
    *,
    user_id,
    name,
    namespace="default",
    skill_ids,
    skill_names,
):
    from app.models.kind import Kind

    skill_refs = {
        sname: {"skill_id": sid, "namespace": "default", "is_public": False}
        for sname, sid in zip(skill_names, skill_ids)
    }
    # Create a ghost with skill_refs so clone_bot can read them via _convert_to_bot_dict
    ghost_name = f"ghost-{name}"
    ghost = Kind(
        user_id=user_id,
        kind="Ghost",
        name=ghost_name,
        namespace=namespace,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Ghost",
            "metadata": {"name": ghost_name, "namespace": namespace},
            "spec": {
                "systemPrompt": "Test prompt",
                "skills": skill_names,
                "skill_refs": skill_refs,
            },
        },
        is_active=True,
    )
    test_db.add(ghost)
    test_db.commit()

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
                "ghostRef": {"name": ghost_name, "namespace": namespace},
                "shellRef": {"name": "ClaudeCode", "namespace": "default"},
            },
        },
        is_active=True,
    )
    test_db.add(bot)
    test_db.commit()
    test_db.refresh(bot)
    return bot


class TestCloneBotWithSkillMapping:
    def test_clone_bot_updates_skill_refs_with_mapping(self, test_db):
        """clone_bot with skill_id_mapping updates skill_refs to new IDs."""
        user = _create_user(test_db, "clone_bot_user1", "cb1@test.com")
        _create_shell(test_db)
        skill_a = _create_skill(test_db, user_id=user.id, name="excel-helper")
        skill_b = _create_skill(test_db, user_id=user.id, name="code-review")
        new_skill_a = _create_skill(
            test_db, user_id=user.id, name="excel-helper", namespace="eng-team"
        )
        bot = _create_bot_with_skills(
            test_db,
            user_id=user.id,
            name="my-bot",
            skill_ids=[skill_a.id, skill_b.id],
            skill_names=["excel-helper", "code-review"],
        )

        cloned = bot_kinds_service.clone_bot(
            test_db,
            bot_id=bot.id,
            user_id=user.id,
            new_name="Copy of my-bot",
            namespace="eng-team",
            skill_id_mapping={skill_a.id: new_skill_a.id},
        )

        from app.models.kind import Kind as K

        cloned_kind = test_db.query(K).filter(K.id == cloned["id"]).first()
        # skill_refs are stored in the ghost's spec, not the bot's spec
        ghost_ref = cloned_kind.json.get("spec", {}).get("ghostRef", {})
        cloned_ghost = (
            test_db.query(K)
            .filter(
                K.kind == "Ghost",
                K.name == ghost_ref.get("name"),
                K.namespace == ghost_ref.get("namespace"),
            )
            .first()
        )
        refs = cloned_ghost.json.get("spec", {}).get("skill_refs", {})
        assert refs["excel-helper"]["skill_id"] == new_skill_a.id
        # skill_b not in mapping — ref stays as-is (fallback at runtime)
        assert refs["code-review"]["skill_id"] == skill_b.id

    def test_clone_bot_without_mapping_preserves_original_refs(self, test_db):
        """clone_bot with no mapping: skill_refs unchanged."""
        user = _create_user(test_db, "clone_bot_user2", "cb2@test.com")
        _create_shell(test_db)
        skill_a = _create_skill(test_db, user_id=user.id, name="my-skill")
        bot = _create_bot_with_skills(
            test_db,
            user_id=user.id,
            name="bot-no-map",
            skill_ids=[skill_a.id],
            skill_names=["my-skill"],
        )

        cloned = bot_kinds_service.clone_bot(
            test_db,
            bot_id=bot.id,
            user_id=user.id,
            new_name="Copy of bot-no-map",
            namespace="eng-team",
            skill_id_mapping=None,
        )

        from app.models.kind import Kind as K

        cloned_kind = test_db.query(K).filter(K.id == cloned["id"]).first()
        # skill_refs are stored in the ghost's spec, not the bot's spec
        ghost_ref = cloned_kind.json.get("spec", {}).get("ghostRef", {})
        cloned_ghost = (
            test_db.query(K)
            .filter(
                K.kind == "Ghost",
                K.name == ghost_ref.get("name"),
                K.namespace == ghost_ref.get("namespace"),
            )
            .first()
        )
        refs = cloned_ghost.json.get("spec", {}).get("skill_refs", {})
        assert refs["my-skill"]["skill_id"] == skill_a.id
