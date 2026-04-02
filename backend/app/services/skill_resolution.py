# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared runtime helpers for skill lookup and reference resolution."""

from typing import Any, Dict, List

from sqlalchemy.orm import Session

from app.models.kind import Kind


def build_skill_ref_meta(skill: Kind) -> Dict[str, Any]:
    """Convert a skill Kind row into runtime skill reference metadata."""
    return {
        "skill_id": skill.id,
        "namespace": skill.namespace or "default",
        "is_public": skill.user_id == 0,
    }


def find_skill_by_name(
    db: Session,
    *,
    skill_name: str,
    owner_user_id: int,
    team_namespace: str = "default",
) -> Kind | None:
    """Find a skill by runtime lookup order for bot-attached skills."""
    skill = (
        db.query(Kind)
        .filter(
            Kind.user_id == owner_user_id,
            Kind.kind == "Skill",
            Kind.name == skill_name,
            Kind.namespace == "default",
            Kind.is_active == True,  # noqa: E712
        )
        .first()
    )
    if skill:
        return skill

    if team_namespace != "default":
        skill = (
            db.query(Kind)
            .filter(
                Kind.kind == "Skill",
                Kind.name == skill_name,
                Kind.namespace == team_namespace,
                Kind.is_active == True,  # noqa: E712
            )
            .first()
        )
        if skill:
            return skill

    return (
        db.query(Kind)
        .filter(
            Kind.user_id == 0,
            Kind.kind == "Skill",
            Kind.name == skill_name,
            Kind.is_active == True,  # noqa: E712
        )
        .first()
    )


def find_skill_by_ref(
    db: Session,
    *,
    skill_name: str,
    namespace: str,
    is_public: bool,
    user_id: int,
    team_namespace: str | None = None,
) -> Kind | None:
    """Find a skill by explicit name/namespace/public metadata."""
    if is_public:
        return (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Skill",
                Kind.name == skill_name,
                Kind.is_active == True,  # noqa: E712
            )
            .first()
        )

    skill = (
        db.query(Kind)
        .filter(
            Kind.user_id == user_id,
            Kind.kind == "Skill",
            Kind.name == skill_name,
            Kind.namespace == namespace,
            Kind.is_active == True,  # noqa: E712
        )
        .first()
    )
    if skill:
        return skill

    if namespace != "default":
        skill = (
            db.query(Kind)
            .filter(
                Kind.kind == "Skill",
                Kind.name == skill_name,
                Kind.namespace == namespace,
                Kind.is_active == True,  # noqa: E712
            )
            .first()
        )
        if skill:
            return skill

    if team_namespace and team_namespace != "default" and team_namespace != namespace:
        skill = (
            db.query(Kind)
            .filter(
                Kind.kind == "Skill",
                Kind.name == skill_name,
                Kind.namespace == team_namespace,
                Kind.is_active == True,  # noqa: E712
            )
            .first()
        )
        if skill:
            return skill

    if namespace != "default":
        return (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "Skill",
                Kind.name == skill_name,
                Kind.namespace == "default",
                Kind.is_active == True,  # noqa: E712
            )
            .first()
        )

    return None


def resolve_skill_refs_by_names(
    db: Session,
    *,
    skill_names: List[str],
    user_id: int,
    namespace: str = "default",
) -> Dict[str, Dict[str, Any]]:
    """Resolve name-only skills to precise skill reference metadata."""
    if not skill_names:
        return {}

    unique_names = list(dict.fromkeys(skill_names))
    resolved: Dict[str, Dict[str, Any]] = {}
    remaining = list(unique_names)

    personal_skills = (
        db.query(Kind)
        .filter(
            Kind.user_id == user_id,
            Kind.kind == "Skill",
            Kind.name.in_(remaining),
            Kind.namespace == "default",
            Kind.is_active == True,  # noqa: E712
        )
        .all()
    )
    for skill in personal_skills:
        if skill.name in remaining:
            resolved[skill.name] = build_skill_ref_meta(skill)
            remaining.remove(skill.name)

    if remaining and namespace != "default":
        group_skills = (
            db.query(Kind)
            .filter(
                Kind.kind == "Skill",
                Kind.name.in_(remaining),
                Kind.namespace == namespace,
                Kind.is_active == True,  # noqa: E712
            )
            .all()
        )
        for skill in group_skills:
            if skill.name in remaining:
                resolved[skill.name] = build_skill_ref_meta(skill)
                remaining.remove(skill.name)

    if remaining:
        public_skills = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Skill",
                Kind.name.in_(remaining),
                Kind.namespace == "default",
                Kind.is_active == True,  # noqa: E712
            )
            .all()
        )
        for skill in public_skills:
            if skill.name in remaining:
                resolved[skill.name] = build_skill_ref_meta(skill)
                remaining.remove(skill.name)

    return resolved
