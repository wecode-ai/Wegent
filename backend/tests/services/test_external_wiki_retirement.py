# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest

from app.models.kind import Kind
from app.services.external_wiki_retirement import (
    inspect_external_wiki_skill,
    retire_external_wiki_skill,
)


def _kind(test_db, *, user_id: int, kind: str, name: str, json: dict) -> Kind:
    row = Kind(
        user_id=user_id,
        kind=kind,
        name=name,
        namespace="default",
        json=json,
        is_active=True,
    )
    test_db.add(row)
    test_db.commit()
    test_db.refresh(row)
    return row


def _create_target(test_db) -> Kind:
    return _kind(
        test_db,
        user_id=0,
        kind="Skill",
        name="external-wiki",
        json={"spec": {"description": "retired"}},
    )


def test_retirement_removes_exact_references_and_is_idempotent(test_db, test_user):
    skill = _create_target(test_db)
    other = _kind(
        test_db,
        user_id=test_user.id,
        kind="Skill",
        name="external-wiki",
        json={"spec": {"description": "personal"}},
    )
    ghost = _kind(
        test_db,
        user_id=test_user.id,
        kind="Ghost",
        name="wiki-agent",
        json={
            "spec": {
                "skills": [skill.name],
                "skill_refs": {skill.name: {"skill_id": skill.id}},
            }
        },
    )
    binding = _kind(
        test_db,
        user_id=test_user.id,
        kind="SkillBinding",
        name=f"user-{test_user.id}-skill-{skill.id}",
        json={"spec": {"skillRef": {"skillId": skill.id}}},
    )
    installed = _kind(
        test_db,
        user_id=test_user.id,
        kind="InstalledSkill",
        name="legacy-external-wiki",
        json={
            "spec": {
                "source": {"type": "personal", "skillKey": skill.name},
                "skillRef": {
                    "kind": "Skill",
                    "name": skill.name,
                    "namespace": skill.namespace,
                    "user_id": skill.user_id,
                },
                "enabled": True,
                "installState": "installed",
            }
        },
    )

    dry_run = inspect_external_wiki_skill(test_db)
    assert dry_run.ghost_ids == [ghost.id]
    assert dry_run.binding_ids == [binding.id]
    assert dry_run.installed_skill_ids == [installed.id]
    assert test_db.get(Kind, skill.id).is_active is True

    applied = retire_external_wiki_skill(test_db)
    assert applied.applied is True
    assert test_db.get(Kind, skill.id).is_active is False
    assert test_db.get(Kind, other.id).is_active is True
    assert test_db.get(Kind, binding.id).is_active is False
    assert test_db.get(Kind, installed.id).is_active is False
    assert test_db.get(Kind, installed.id).json["spec"]["installState"] == "uninstalled"
    assert test_db.get(Kind, ghost.id).json["spec"]["skills"] == []

    repeated = retire_external_wiki_skill(test_db)
    assert repeated.applied is False


def test_retirement_refuses_ambiguous_installed_skill(test_db, test_user):
    skill = _create_target(test_db)
    ambiguous = _kind(
        test_db,
        user_id=test_user.id,
        kind="InstalledSkill",
        name="ambiguous-external-wiki",
        json={
            "spec": {
                "source": {"type": "system", "skillKey": skill.name},
                "skillRef": {
                    "kind": "Skill",
                    "name": skill.name,
                    "namespace": "other",
                    "user_id": 0,
                },
            }
        },
    )

    with pytest.raises(RuntimeError, match=str(ambiguous.id)):
        retire_external_wiki_skill(test_db)

    assert test_db.get(Kind, skill.id).is_active is True
    assert test_db.get(Kind, ambiguous.id).is_active is True
