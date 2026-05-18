# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from sqlalchemy.orm import Session

from app.core.security import get_password_hash
from app.models.kind import Kind
from app.models.namespace import Namespace
from app.models.resource_member import MemberStatus, ResourceMember
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


def _create_group(test_db: Session, owner: User, name: str) -> Namespace:
    group = Namespace(
        name=name,
        display_name=name,
        owner_user_id=owner.id,
        visibility="internal",
        description="test group",
        level="group",
        is_active=True,
    )
    test_db.add(group)
    test_db.commit()
    test_db.refresh(group)
    return group


def _add_group_member(
    test_db: Session, group: Namespace, user: User, role: str
) -> None:
    member = ResourceMember(
        resource_type="Namespace",
        resource_id=group.id,
        entity_type="user",
        entity_id=str(user.id),
        role=role,
        status=MemberStatus.APPROVED.value,
        invited_by_user_id=group.owner_user_id,
        share_link_id=0,
        reviewed_by_user_id=group.owner_user_id,
        copied_resource_id=0,
    )
    test_db.add(member)
    test_db.commit()


def _create_bot(
    test_db: Session, *, user_id: int, name: str, namespace: str = "default"
) -> Kind:
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


def _create_ghost(
    test_db: Session, *, user_id: int, name: str, namespace: str = "default"
) -> Kind:
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


def _create_shell(
    test_db: Session,
    *,
    user_id: int = 0,
    name: str = "ClaudeCode",
    namespace: str = "default",
) -> Kind:
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
            members.append(
                {
                    "botRef": {"name": bot.name, "namespace": bot.namespace},
                    "prompt": "",
                    "role": "leader" if bot_id == bot_ids[0] else "member",
                }
            )
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
        before_count = (
            test_db.query(Kind)
            .filter(Kind.kind == "Bot", Kind.is_active == True)
            .count()
        )

        team_kinds_service.copy_team(test_db, team_id=team.id, user_id=user.id)

        after_count = (
            test_db.query(Kind)
            .filter(Kind.kind == "Bot", Kind.is_active == True)
            .count()
        )
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
        before_count = (
            test_db.query(Kind)
            .filter(Kind.kind == "Bot", Kind.is_active == True)
            .count()
        )

        result = team_kinds_service.copy_team(test_db, team_id=team.id, user_id=user.id)

        after_count = (
            test_db.query(Kind)
            .filter(Kind.kind == "Bot", Kind.is_active == True)
            .count()
        )
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


class TestCopyTeamNonSoloCrossNamespace:
    def test_copy_non_solo_to_different_namespace_clones_bots(self, test_db):
        """Non-solo copy to different namespace: each bot is cloned to target namespace."""
        user = _create_user(test_db, "ns_copy_user1", "nsc1@test.com")
        group = _create_group(test_db, user, "eng-team")
        _add_group_member(test_db, group, user, "Developer")
        _create_shell(test_db, name="ClaudeCode", namespace="default")
        bot_a = _create_bot(test_db, user_id=user.id, name="bot-a")
        bot_b = _create_bot(test_db, user_id=user.id, name="bot-b")
        team = _create_team(
            test_db,
            user_id=user.id,
            name="pipeline-team",
            collaboration_model="pipeline",
            bot_ids=[bot_a.id, bot_b.id],
        )
        before_count = (
            test_db.query(Kind)
            .filter(Kind.kind == "Bot", Kind.is_active == True)
            .count()
        )

        team_kinds_service.copy_team(
            test_db, team_id=team.id, user_id=user.id, target_namespace="eng-team"
        )

        after_count = (
            test_db.query(Kind)
            .filter(Kind.kind == "Bot", Kind.is_active == True)
            .count()
        )
        assert after_count == before_count + 2  # Two bots cloned
        cloned_bots = (
            test_db.query(Kind)
            .filter(
                Kind.kind == "Bot", Kind.namespace == "eng-team", Kind.is_active == True
            )
            .all()
        )
        assert len(cloned_bots) == 2

    def test_copy_non_solo_same_namespace_still_references_original_bots(self, test_db):
        """Non-solo copy within same namespace: original behavior preserved (no cloning)."""
        user = _create_user(test_db, "ns_copy_user2", "nsc2@test.com")
        _create_shell(test_db, name="ClaudeCode", namespace="default")
        bot = _create_bot(test_db, user_id=user.id, name="same-ns-bot")
        team = _create_team(
            test_db,
            user_id=user.id,
            name="same-ns-team",
            collaboration_model="pipeline",
            bot_ids=[bot.id],
        )
        before_count = (
            test_db.query(Kind)
            .filter(Kind.kind == "Bot", Kind.is_active == True)
            .count()
        )

        team_kinds_service.copy_team(test_db, team_id=team.id, user_id=user.id)

        after_count = (
            test_db.query(Kind)
            .filter(Kind.kind == "Bot", Kind.is_active == True)
            .count()
        )
        assert after_count == before_count  # No new bots


class TestCopyTeamPreflight:
    def test_preflight_returns_personal_skills(self, test_db):
        """Preflight detects personal skills on team bots."""
        from app.models.skill_binary import SkillBinary as SB

        user = _create_user(test_db, "preflight_user1", "pf1@test.com")
        _create_shell(test_db, name="ClaudeCode", namespace="default")

        # Create personal skill with binary
        skill = Kind(
            user_id=user.id,
            kind="Skill",
            name="excel-helper",
            namespace="default",
            json={
                "apiVersion": "agent.wecode.io/v1",
                "kind": "Skill",
                "metadata": {"name": "excel-helper", "namespace": "default"},
                "spec": {"description": "Excel helper skill", "version": "1.0.0"},
            },
            is_active=True,
        )
        test_db.add(skill)
        test_db.commit()
        test_db.refresh(skill)
        sb = SB(kind_id=skill.id, binary_data=b"zip", file_size=3, file_hash="abc")
        test_db.add(sb)
        test_db.commit()

        # Create bot with skill_refs pointing to this skill
        # Note: skill_refs live in the ghost's spec, not the bot's spec
        ghost = Kind(
            user_id=user.id,
            kind="Ghost",
            name="ghost-bot-with-skill",
            namespace="default",
            json={
                "apiVersion": "agent.wecode.io/v1",
                "kind": "Ghost",
                "metadata": {"name": "ghost-bot-with-skill", "namespace": "default"},
                "spec": {
                    "systemPrompt": "",
                    "skills": ["excel-helper"],
                    "skill_refs": {
                        "excel-helper": {
                            "skill_id": skill.id,
                            "namespace": "default",
                            "is_public": False,
                        }
                    },
                },
            },
            is_active=True,
        )
        test_db.add(ghost)
        test_db.commit()
        bot = Kind(
            user_id=user.id,
            kind="Bot",
            name="bot-with-skill",
            namespace="default",
            json={
                "apiVersion": "agent.wecode.io/v1",
                "kind": "Bot",
                "metadata": {"name": "bot-with-skill", "namespace": "default"},
                "spec": {
                    "ghostRef": {
                        "name": "ghost-bot-with-skill",
                        "namespace": "default",
                    },
                    "shellRef": {"name": "ClaudeCode", "namespace": "default"},
                },
            },
            is_active=True,
        )
        test_db.add(bot)
        test_db.commit()
        test_db.refresh(bot)

        team = _create_team(
            test_db,
            user_id=user.id,
            name="skill-team",
            collaboration_model="solo",
            bot_ids=[bot.id],
        )

        result = team_kinds_service.get_copy_preflight(
            test_db, team_id=team.id, user_id=user.id, target_namespace="eng-team"
        )

        assert len(result["personal_skills"]) == 1
        assert result["personal_skills"][0]["name"] == "excel-helper"
        assert result["personal_skills"][0]["id"] == skill.id

    def test_preflight_excludes_group_skills(self, test_db):
        """Preflight only returns personal (namespace=default, non-public) skills."""
        user = _create_user(test_db, "preflight_user2", "pf2@test.com")
        _create_shell(test_db, name="ClaudeCode", namespace="default")

        # Group skill (already in a non-default namespace)
        group_skill = Kind(
            user_id=user.id,
            kind="Skill",
            name="group-skill",
            namespace="eng-team",
            json={
                "apiVersion": "agent.wecode.io/v1",
                "kind": "Skill",
                "metadata": {"name": "group-skill", "namespace": "eng-team"},
                "spec": {"description": "group skill", "version": "1.0.0"},
            },
            is_active=True,
        )
        test_db.add(group_skill)
        test_db.commit()
        test_db.refresh(group_skill)

        bot = Kind(
            user_id=user.id,
            kind="Bot",
            name="bot-group-skill",
            namespace="default",
            json={
                "apiVersion": "agent.wecode.io/v1",
                "kind": "Bot",
                "metadata": {"name": "bot-group-skill", "namespace": "default"},
                "spec": {
                    "ghostRef": {
                        "name": "ghost-bot-group-skill",
                        "namespace": "default",
                    },
                    "shellRef": {"name": "ClaudeCode", "namespace": "default"},
                    "skills": ["group-skill"],
                    "skill_refs": {
                        "group-skill": {
                            "skill_id": group_skill.id,
                            "namespace": "eng-team",
                            "is_public": False,
                        }
                    },
                },
            },
            is_active=True,
        )
        test_db.add(bot)
        test_db.commit()
        test_db.refresh(bot)

        team = _create_team(
            test_db,
            user_id=user.id,
            name="no-personal-team",
            collaboration_model="solo",
            bot_ids=[bot.id],
        )

        result = team_kinds_service.get_copy_preflight(
            test_db, team_id=team.id, user_id=user.id, target_namespace="eng-team"
        )

        assert result["personal_skills"] == []


from sqlalchemy.orm.attributes import flag_modified

from app.models.skill_binary import SkillBinary


def _attach_skill_to_bot(test_db, *, bot, skill):
    """Add a skill_ref to a bot's spec and to its ghost spec (where clone_bot reads from)."""
    from app.models.kind import Kind

    # Update bot spec (used by preflight and _collect_personal_skill_ids)
    spec = bot.json.get("spec", {})
    skills_list = spec.get("skills", [])
    skill_refs = spec.get("skill_refs", {})
    skills_list.append(skill.name)
    skill_refs[skill.name] = {
        "skill_id": skill.id,
        "namespace": skill.namespace,
        "is_public": False,
    }
    spec["skills"] = skills_list
    spec["skill_refs"] = skill_refs
    bot.json["spec"] = spec
    flag_modified(bot, "json")

    # Also update the ghost spec (where clone_bot reads skill_refs from)
    ghost_ref = spec.get("ghostRef", {})
    ghost = (
        test_db.query(Kind)
        .filter(
            Kind.kind == "Ghost",
            Kind.name == ghost_ref.get("name"),
            Kind.namespace == ghost_ref.get("namespace", bot.namespace),
            Kind.user_id == bot.user_id,
            Kind.is_active == True,
        )
        .first()
    )
    if ghost:
        ghost_spec = ghost.json.get("spec", {})
        g_skills = ghost_spec.get("skills", [])
        g_skill_refs = ghost_spec.get("skill_refs", {})
        g_skills.append(skill.name)
        g_skill_refs[skill.name] = {
            "skill_id": skill.id,
            "namespace": skill.namespace,
            "is_public": False,
        }
        ghost_spec["skills"] = g_skills
        ghost_spec["skill_refs"] = g_skill_refs
        ghost.json["spec"] = ghost_spec
        flag_modified(ghost, "json")

    test_db.commit()


def _create_skill_with_binary(test_db, *, user_id, name, namespace="default"):
    from app.models.kind import Kind

    skill = Kind(
        user_id=user_id,
        kind="Skill",
        name=name,
        namespace=namespace,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Skill",
            "metadata": {"name": name, "namespace": namespace},
            "spec": {"description": f"Skill {name}", "version": "1.0.0"},
        },
        is_active=True,
    )
    test_db.add(skill)
    test_db.commit()
    test_db.refresh(skill)
    sb = SkillBinary(
        kind_id=skill.id, binary_data=b"fake-zip", file_size=8, file_hash="deadbeef"
    )
    test_db.add(sb)
    test_db.commit()
    return skill


class TestCopyTeamWithSkills:
    def test_copy_solo_team_copies_personal_skills_when_flag_true(self, test_db):
        """copy_skills=True: personal skill copied to group, cloned bot refs updated."""
        from app.models.kind import Kind

        user = _create_user(test_db, "skill_team_user1", "st1@test.com")
        group = _create_group(test_db, user, "eng-team")
        _add_group_member(test_db, group, user, "Developer")
        _create_shell(test_db, name="ClaudeCode", namespace="default")

        personal_skill = _create_skill_with_binary(
            test_db, user_id=user.id, name="my-skill"
        )
        bot = _create_bot(test_db, user_id=user.id, name="skill-bot")
        _create_ghost(test_db, user_id=user.id, name="ghost-skill-bot")
        _attach_skill_to_bot(test_db, bot=bot, skill=personal_skill)

        team = _create_team(
            test_db,
            user_id=user.id,
            name="skill-solo-team",
            collaboration_model="solo",
            bot_ids=[bot.id],
        )

        result = team_kinds_service.copy_team(
            test_db,
            team_id=team.id,
            user_id=user.id,
            target_namespace="eng-team",
            copy_skills=True,
        )

        # Skill copied to eng-team namespace
        group_skill = (
            test_db.query(Kind)
            .filter(
                Kind.kind == "Skill",
                Kind.name == "my-skill",
                Kind.namespace == "eng-team",
                Kind.is_active == True,
            )
            .first()
        )
        assert group_skill is not None

        # Cloned bot's skill_refs point to the new group skill (skills live in the ghost)
        cloned_bot = (
            test_db.query(Kind)
            .filter(
                Kind.kind == "Bot", Kind.namespace == "eng-team", Kind.is_active == True
            )
            .first()
        )
        ghost_ref = cloned_bot.json.get("spec", {}).get("ghostRef", {})
        cloned_ghost = (
            test_db.query(Kind)
            .filter(
                Kind.kind == "Ghost",
                Kind.name == ghost_ref.get("name"),
                Kind.namespace == "eng-team",
                Kind.is_active == True,
            )
            .first()
        )
        assert cloned_ghost is not None
        refs = cloned_ghost.json.get("spec", {}).get("skill_refs", {})
        assert refs["my-skill"]["skill_id"] == group_skill.id
        assert refs["my-skill"]["namespace"] == "eng-team"

    def test_copy_solo_team_leaves_skills_in_personal_when_flag_false(self, test_db):
        """copy_skills=False: no skill copied, cloned bot refs stay pointing to personal."""
        from app.models.kind import Kind

        user = _create_user(test_db, "skill_team_user2", "st2@test.com")
        group = _create_group(test_db, user, "eng-team2")
        _add_group_member(test_db, group, user, "Developer")
        _create_shell(test_db, name="ClaudeCode", namespace="default")

        personal_skill = _create_skill_with_binary(
            test_db, user_id=user.id, name="skip-skill"
        )
        bot = _create_bot(test_db, user_id=user.id, name="skip-skill-bot")
        _create_ghost(test_db, user_id=user.id, name="ghost-skip-skill-bot")
        _attach_skill_to_bot(test_db, bot=bot, skill=personal_skill)

        team = _create_team(
            test_db,
            user_id=user.id,
            name="skip-skill-team",
            collaboration_model="solo",
            bot_ids=[bot.id],
        )

        team_kinds_service.copy_team(
            test_db,
            team_id=team.id,
            user_id=user.id,
            target_namespace="eng-team2",
            copy_skills=False,
        )

        # No group-namespace copy of the skill
        group_skill = (
            test_db.query(Kind)
            .filter(
                Kind.kind == "Skill",
                Kind.name == "skip-skill",
                Kind.namespace == "eng-team2",
                Kind.is_active == True,
            )
            .first()
        )
        assert group_skill is None

        # Cloned bot skill_refs still point to personal skill (skills live in the ghost)
        cloned_bot = (
            test_db.query(Kind)
            .filter(
                Kind.kind == "Bot",
                Kind.namespace == "eng-team2",
                Kind.is_active == True,
            )
            .first()
        )
        ghost_ref = cloned_bot.json.get("spec", {}).get("ghostRef", {})
        cloned_ghost = (
            test_db.query(Kind)
            .filter(
                Kind.kind == "Ghost",
                Kind.name == ghost_ref.get("name"),
                Kind.namespace == "eng-team2",
                Kind.is_active == True,
            )
            .first()
        )
        assert cloned_ghost is not None
        refs = cloned_ghost.json.get("spec", {}).get("skill_refs", {})
        assert refs["skip-skill"]["skill_id"] == personal_skill.id
