"""The shared authorization policy for selecting and saving Bot Skills."""

from dataclasses import dataclass
from functools import cached_property

from fastapi import HTTPException
from sqlalchemy import and_, or_
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.models.kind import Kind
from app.schemas.base_role import BaseRole
from app.services.group_permission import check_group_permission
from app.services.skill_binding_service import skill_binding_service


def normalize_binding_groups(
    db: Session, user_id: int, group_names: list[str] | None
) -> list[str]:
    groups = list(
        dict.fromkeys(
            n.strip() for n in group_names or [] if n.strip() and n.strip() != "default"
        )
    )
    denied = [
        n
        for n in groups
        if not check_group_permission(db, user_id, n, BaseRole.Reporter)
    ]
    if denied:
        raise HTTPException(
            status_code=403,
            detail=f"Group access denied: {', '.join(sorted(denied))}",
        )
    return groups


@dataclass
class SkillBindingPolicy:
    db: Session
    user_id: int
    namespace: str
    target_groups: list[str]

    @cached_property
    def default_ids(self) -> set[int]:
        return skill_binding_service.list_user_default_skill_ids(self.db, self.user_id)

    @cached_property
    def group_ids(self) -> dict[str, set[int]]:
        groups = list(
            dict.fromkeys(
                n for n in [self.namespace, *self.target_groups] if n != "default"
            )
        )
        return {
            n: skill_binding_service.list_group_skill_ids(self.db, n, self.user_id)
            for n in groups
        }

    @classmethod
    def load(
        cls, db: Session, user_id: int, namespace: str, target_groups: list[str]
    ) -> "SkillBindingPolicy":
        return cls(db, user_id, namespace, target_groups)

    @cached_property
    def permission_filter(self) -> ColumnElement[bool]:
        """Use one SQL predicate for discovery and persistence authorization."""
        conditions = [
            Kind.user_id == 0,
            and_(Kind.user_id == self.user_id, Kind.namespace == "default"),
            Kind.id.in_(self.default_ids),
        ]
        if self.namespace != "default":
            conditions.extend(
                [
                    Kind.namespace == self.namespace,
                    Kind.id.in_(self.group_ids[self.namespace]),
                ]
            )
        if self.target_groups:
            conditions.append(
                and_(
                    *(
                        or_(
                            Kind.namespace == group,
                            Kind.id.in_(self.group_ids[group]),
                        )
                        for group in self.target_groups
                    )
                )
            )
        return or_(*conditions)

    def list_skills(self, db: Session, skip: int, limit: int) -> list[Kind]:
        """Apply authorization and pagination before loading Skill definitions."""
        return (
            db.query(Kind)
            .filter(
                Kind.kind == "Skill",
                Kind.is_active.is_(True),
                self.permission_filter,
            )
            .order_by(Kind.created_at.desc(), Kind.id.desc())
            .offset(skip)
            .limit(limit)
            .all()
        )
