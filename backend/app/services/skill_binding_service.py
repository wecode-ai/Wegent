# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Service for binding Skill assets to long-term availability targets."""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.kind import Kind
from app.schemas.base_role import has_permission
from app.schemas.namespace import GroupRole
from app.schemas.skill_binding import (
    SkillBindingException,
    SkillBindingExceptionType,
    SkillBindingResponse,
    SkillBindingSkillRef,
    SkillBindingTargetType,
)
from app.services.group_permission import get_effective_role_in_group

SKILL_BINDING_KIND = "SkillBinding"
SKILL_BINDING_NAMESPACE = "default"
USER_DEFAULT_TARGET_ID_PREFIX = "user"


@dataclass(frozen=True)
class SkillBindingContext:
    """Runtime context used to decide whether a user automatic Skill applies."""

    mode: str | None = None
    agent_id: int | str | None = None
    project_id: int | str | None = None
    group_namespace: str | None = None


class SkillBindingService:
    """Manage SkillBinding resources in the kinds table."""

    def get_user_default_target_id(self, user_id: int) -> str:
        """Return the target id for a user's default enabled Skill bindings."""
        return f"{USER_DEFAULT_TARGET_ID_PREFIX}:{user_id}"

    def build_user_default_name(self, user_id: int, skill_id: int) -> str:
        """Return the stable Kind name for a user's binding to a Skill."""
        return f"user-{user_id}-skill-{skill_id}"

    def get_accessible_skill(self, db: Session, skill_id: int, user_id: int) -> Kind:
        """Return an active Skill asset the user may add to their defaults."""
        skill = (
            db.query(Kind)
            .filter(
                Kind.id == skill_id,
                Kind.kind == "Skill",
                Kind.is_active == True,
            )
            .first()
        )
        if not skill:
            raise HTTPException(status_code=404, detail="Skill not found")

        if self.can_user_access_skill(db, skill=skill, user_id=user_id):
            return skill

        raise HTTPException(status_code=404, detail="Skill not found")

    def can_user_access_skill(
        self,
        db: Session,
        *,
        skill: Kind,
        user_id: int,
    ) -> bool:
        """Return whether the user currently has access to an active Skill."""
        if not skill.is_active:
            return False

        capability = self._get_capability(skill)
        if skill.user_id in {user_id, 0} or (
            capability.get("visibility") == "public"
            and capability.get("publishStatus") == "published"
        ):
            return True

        if skill.namespace != "default":
            user_role = get_effective_role_in_group(db, user_id, skill.namespace)
            if user_role and has_permission(user_role, GroupRole.Reporter):
                return True

        return False

    def build_group_name(self, group_namespace: str, skill_id: int) -> str:
        """Return the stable Kind name for a group's binding to a Skill."""
        return f"group-skill-{skill_id}"

    def add_group_skill(
        self,
        db: Session,
        *,
        group_namespace: str,
        skill_id: int,
        created_by: int,
        commit: bool = True,
    ) -> Kind:
        """Create or restore a SkillBinding shared by a group."""
        from app.services.group_permission import check_group_permission

        if not check_group_permission(
            db, created_by, group_namespace, GroupRole.Developer
        ):
            raise HTTPException(
                status_code=403,
                detail="Developer role is required to add a group Skill",
            )

        skill = self.get_accessible_skill(db, skill_id, created_by)
        binding_name = self.build_group_name(group_namespace, skill_id)
        binding_json = self._build_binding_json(
            binding_name=binding_name,
            binding_namespace=group_namespace,
            skill=skill,
            target_type=SkillBindingTargetType.GROUP,
            target_id=group_namespace,
            created_by=created_by,
        )
        binding = self._get_group_binding(
            db,
            group_namespace=group_namespace,
            skill_id=skill_id,
            include_inactive=True,
        )
        if binding:
            binding.json = binding_json
            binding.is_active = True
            flag_modified(binding, "json")
        else:
            binding = Kind(
                user_id=created_by,
                kind=SKILL_BINDING_KIND,
                name=binding_name,
                namespace=group_namespace,
                json=binding_json,
                is_active=True,
            )
            db.add(binding)

        db.flush()
        if commit:
            db.commit()
            db.refresh(binding)
        return binding

    def list_group_bindings(
        self, db: Session, group_namespace: str, user_id: int
    ) -> list[Kind]:
        """Return active SkillBindings available through a group."""
        role = get_effective_role_in_group(db, user_id, group_namespace)
        if not role or not has_permission(role, GroupRole.Reporter):
            return []

        bindings = (
            db.query(Kind)
            .filter(
                Kind.kind == SKILL_BINDING_KIND,
                Kind.namespace == group_namespace,
                Kind.is_active == True,
            )
            .order_by(Kind.created_at.desc())
            .all()
        )
        return [
            binding
            for binding in bindings
            if self._is_group_binding(binding, group_namespace)
            and self._extract_skill_id(binding) is not None
        ]

    def remove_group_skill(
        self,
        db: Session,
        *,
        group_namespace: str,
        skill_id: int,
        removed_by: int,
        commit: bool = True,
    ) -> None:
        """Soft-delete a SkillBinding shared by a group."""
        from app.services.group_permission import check_group_permission

        if not check_group_permission(
            db, removed_by, group_namespace, GroupRole.Developer
        ):
            raise HTTPException(
                status_code=403,
                detail="Developer role is required to remove a group Skill",
            )

        binding = self._get_group_binding(
            db,
            group_namespace=group_namespace,
            skill_id=skill_id,
            include_inactive=False,
        )
        if binding:
            binding.is_active = False
            db.flush()

        if commit:
            db.commit()

    def list_group_skill_ids(
        self, db: Session, group_namespace: str, user_id: int
    ) -> set[int]:
        """Return active Skill ids installed in a group."""
        skill_ids: set[int] = set()
        for binding in self.list_group_bindings(db, group_namespace, user_id):
            skill_id = self._extract_skill_id(binding)
            if skill_id is None or not self._get_active_skill(db, skill_id):
                continue
            skill_ids.add(skill_id)
        return skill_ids

    def is_skill_available_to_group(
        self,
        db: Session,
        *,
        group_namespace: str,
        skill_id: int,
        user_id: int,
    ) -> bool:
        """Return whether a group has an active binding to a Skill."""
        return skill_id in self.list_group_skill_ids(
            db,
            group_namespace,
            user_id,
        )

    def add_user_default_skill(
        self,
        db: Session,
        *,
        user_id: int,
        skill_id: int,
        created_by: int,
        commit: bool = True,
    ) -> Kind:
        """Create or restore a SkillBinding for the user's default enabled Skills."""
        skill = self.get_accessible_skill(db, skill_id, user_id)
        binding_name = self.build_user_default_name(user_id, skill_id)
        target_id = self.get_user_default_target_id(user_id)
        binding_json = self._build_user_default_json(
            binding_name=binding_name,
            skill=skill,
            target_id=target_id,
            created_by=created_by,
        )

        binding = self._get_user_default_binding(
            db,
            user_id=user_id,
            skill_id=skill_id,
            include_inactive=True,
        )
        if binding:
            binding.name = binding_name
            binding.namespace = SKILL_BINDING_NAMESPACE
            binding.json = binding_json
            binding.is_active = True
            flag_modified(binding, "json")
        else:
            binding = Kind(
                user_id=user_id,
                kind=SKILL_BINDING_KIND,
                name=binding_name,
                namespace=SKILL_BINDING_NAMESPACE,
                json=binding_json,
                is_active=True,
            )
            db.add(binding)

        db.flush()
        if commit:
            db.commit()
            db.refresh(binding)
        return binding

    def remove_user_default_skill(
        self,
        db: Session,
        *,
        user_id: int,
        skill_id: int,
        commit: bool = True,
    ) -> None:
        """Soft-delete a user's default binding to a Skill."""
        binding = self._get_user_default_binding(
            db,
            user_id=user_id,
            skill_id=skill_id,
            include_inactive=False,
        )
        if binding:
            binding.is_active = False
            db.flush()

        if commit:
            db.commit()

    def update_user_default_skill_exceptions(
        self,
        db: Session,
        *,
        user_id: int,
        skill_id: int,
        exceptions: list[SkillBindingException],
        force_preload: bool | None = None,
        commit: bool = True,
    ) -> Kind:
        """Replace settings for an active user automatic Skill binding."""
        binding = self._get_user_default_binding(
            db,
            user_id=user_id,
            skill_id=skill_id,
            include_inactive=False,
        )
        if not binding:
            raise HTTPException(status_code=404, detail="Skill binding not found")

        binding_json = deepcopy(binding.json) if isinstance(binding.json, dict) else {}
        spec = binding_json.setdefault("spec", {})
        spec["exceptions"] = [
            item.model_dump() for item in self._normalize_exceptions(exceptions)
        ]
        if force_preload is not None:
            spec["forcePreload"] = bool(force_preload)
        binding.json = binding_json
        flag_modified(binding, "json")
        db.flush()
        if commit:
            db.commit()
            db.refresh(binding)
        return binding

    def list_user_default_bindings(self, db: Session, user_id: int) -> list[Kind]:
        """Return active SkillBinding rows for a user's default enabled Skills."""
        target_id = self.get_user_default_target_id(user_id)
        bindings = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == SKILL_BINDING_KIND,
                Kind.namespace == SKILL_BINDING_NAMESPACE,
                Kind.is_active == True,
            )
            .order_by(Kind.created_at.desc())
            .all()
        )
        accessible_bindings: list[Kind] = []
        for binding in bindings:
            if not self._is_user_default_binding(binding, target_id):
                continue

            skill_id = self._extract_skill_id(binding)
            if skill_id is None:
                continue

            skill = self._get_active_skill(db, skill_id)
            if not skill or not self.can_user_access_skill(
                db, skill=skill, user_id=user_id
            ):
                continue

            accessible_bindings.append(binding)

        return accessible_bindings

    def list_user_default_skill_ids(self, db: Session, user_id: int) -> set[int]:
        """Return Skill ids for the user's default enabled Skills."""
        skill_ids: set[int] = set()
        for binding in self.list_user_default_bindings(db, user_id):
            skill_id = self._extract_skill_id(binding)
            if skill_id is not None:
                skill_ids.add(skill_id)
        return skill_ids

    def list_user_default_skill_refs(
        self,
        db: Session,
        user_id: int,
        context: SkillBindingContext | None = None,
    ) -> list[dict[str, Any]]:
        """Return active runtime Skill refs for the user's default enabled Skills."""
        refs: list[dict[str, Any]] = []
        bindings = list(self.list_user_default_bindings(db, user_id))
        if context and context.group_namespace:
            bindings.extend(
                self.list_group_bindings(db, context.group_namespace, user_id)
            )

        seen_skill_ids: set[int] = set()
        for binding in bindings:
            skill_id = self._extract_skill_id(binding)
            if skill_id is None or skill_id in seen_skill_ids:
                continue
            seen_skill_ids.add(skill_id)

            if self._is_excluded_by_context(binding, context):
                continue

            skill = self._get_active_skill(db, skill_id)
            if not skill:
                continue
            ref = {
                "skill_id": skill.id,
                "name": skill.name,
                "namespace": skill.namespace,
                "is_public": skill.user_id == 0,
            }
            if self._extract_force_preload(binding):
                ref["force_preload"] = True
            refs.append(ref)
        return refs

    def to_response(self, binding: Kind) -> SkillBindingResponse:
        """Convert a SkillBinding Kind row to an API response."""
        spec = self._get_spec(binding)
        raw_ref = spec.get("skillRef", {})
        skill_ref = SkillBindingSkillRef(
            skill_id=int(raw_ref.get("skillId") or raw_ref.get("skill_id")),
            name=str(raw_ref.get("name") or ""),
            namespace=str(raw_ref.get("namespace") or "default"),
            is_public=bool(raw_ref.get("isPublic") or raw_ref.get("is_public")),
        )
        return SkillBindingResponse(
            id=binding.id,
            target_type=SkillBindingTargetType(spec.get("targetType", "user")),
            target_id=str(spec.get("targetId") or ""),
            skill_ref=skill_ref,
            exceptions=self._extract_exceptions(binding),
            force_preload=self._extract_force_preload(binding),
            created_at=binding.created_at,
            updated_at=binding.updated_at,
        )

    def _get_user_default_binding(
        self,
        db: Session,
        *,
        user_id: int,
        skill_id: int,
        include_inactive: bool,
    ) -> Kind | None:
        query = db.query(Kind).filter(
            Kind.user_id == user_id,
            Kind.kind == SKILL_BINDING_KIND,
            Kind.namespace == SKILL_BINDING_NAMESPACE,
            Kind.name == self.build_user_default_name(user_id, skill_id),
        )
        if not include_inactive:
            query = query.filter(Kind.is_active == True)

        return query.first()

    def _get_group_binding(
        self,
        db: Session,
        *,
        group_namespace: str,
        skill_id: int,
        include_inactive: bool,
    ) -> Kind | None:
        query = db.query(Kind).filter(
            Kind.kind == SKILL_BINDING_KIND,
            Kind.namespace == group_namespace,
            Kind.name == self.build_group_name(group_namespace, skill_id),
        )
        if not include_inactive:
            query = query.filter(Kind.is_active == True)
        return query.first()

    def _build_user_default_json(
        self,
        *,
        binding_name: str,
        skill: Kind,
        target_id: str,
        created_by: int,
    ) -> dict[str, Any]:
        return self._build_binding_json(
            binding_name=binding_name,
            binding_namespace=SKILL_BINDING_NAMESPACE,
            skill=skill,
            target_type=SkillBindingTargetType.USER,
            target_id=target_id,
            created_by=created_by,
        )

    def _build_binding_json(
        self,
        *,
        binding_name: str,
        binding_namespace: str,
        skill: Kind,
        target_type: SkillBindingTargetType,
        target_id: str,
        created_by: int,
    ) -> dict[str, Any]:
        return {
            "apiVersion": "agent.wecode.io/v1",
            "kind": SKILL_BINDING_KIND,
            "metadata": {
                "name": binding_name,
                "namespace": binding_namespace,
            },
            "spec": {
                "skillRef": {
                    "skillId": skill.id,
                    "name": skill.name,
                    "namespace": skill.namespace,
                    "isPublic": skill.user_id == 0,
                },
                "targetType": target_type.value,
                "targetId": target_id,
                "createdBy": created_by,
                "exceptions": [],
                "forcePreload": False,
            },
        }

    def _normalize_exceptions(
        self, exceptions: list[SkillBindingException]
    ) -> list[SkillBindingException]:
        normalized: list[SkillBindingException] = []
        seen: set[tuple[str, str]] = set()
        for item in exceptions:
            value = item.value.strip()
            key = (item.type.value, value)
            if not value or key in seen:
                continue
            seen.add(key)
            normalized.append(SkillBindingException(type=item.type, value=value))
        return normalized

    def _extract_exceptions(self, binding: Kind) -> list[SkillBindingException]:
        raw_exceptions = self._get_spec(binding).get("exceptions", [])
        if not isinstance(raw_exceptions, list):
            return []

        exceptions: list[SkillBindingException] = []
        for raw_exception in raw_exceptions:
            if not isinstance(raw_exception, dict):
                continue
            try:
                exceptions.append(SkillBindingException.model_validate(raw_exception))
            except Exception:
                continue
        return self._normalize_exceptions(exceptions)

    def _extract_force_preload(self, binding: Kind) -> bool:
        spec = self._get_spec(binding)
        return bool(spec.get("forcePreload") or spec.get("force_preload") or False)

    def _is_excluded_by_context(
        self, binding: Kind, context: SkillBindingContext | None
    ) -> bool:
        if not context:
            return False

        context_values: set[tuple[str, str]] = set()
        if context.mode:
            context_values.add(
                (SkillBindingExceptionType.MODE.value, str(context.mode))
            )
        if context.agent_id is not None:
            context_values.add(
                (SkillBindingExceptionType.AGENT.value, str(context.agent_id))
            )
        if context.project_id is not None:
            context_values.add(
                (SkillBindingExceptionType.PROJECT.value, str(context.project_id))
            )

        for item in self._extract_exceptions(binding):
            if (item.type.value, item.value) in context_values:
                return True
        return False

    def _extract_skill_id(self, binding: Kind) -> int | None:
        raw_ref = self._get_spec(binding).get("skillRef", {})
        raw_skill_id = raw_ref.get("skillId") or raw_ref.get("skill_id")
        if raw_skill_id is None:
            return None
        try:
            return int(raw_skill_id)
        except (TypeError, ValueError):
            return None

    def _get_spec(self, binding: Kind) -> dict[str, Any]:
        binding_json = deepcopy(binding.json) if isinstance(binding.json, dict) else {}
        spec = binding_json.get("spec", {})
        return spec if isinstance(spec, dict) else {}

    def _get_capability(self, skill: Kind) -> dict[str, Any]:
        payload = skill.json if isinstance(skill.json, dict) else {}
        spec = payload.get("spec", {})
        capability = spec.get("capability", {}) if isinstance(spec, dict) else {}
        return capability if isinstance(capability, dict) else {}

    def _get_active_skill(self, db: Session, skill_id: int) -> Kind | None:
        """Resolve an already-bound Skill even after its listing is archived."""
        return (
            db.query(Kind)
            .filter(
                Kind.id == skill_id,
                Kind.kind == "Skill",
                Kind.is_active == True,
            )
            .first()
        )

    def _is_user_default_binding(self, binding: Kind, target_id: str) -> bool:
        spec = self._get_spec(binding)
        return (
            spec.get("targetType") == SkillBindingTargetType.USER.value
            and spec.get("targetId") == target_id
        )

    def _is_group_binding(self, binding: Kind, group_namespace: str) -> bool:
        spec = self._get_spec(binding)
        return (
            spec.get("targetType") == SkillBindingTargetType.GROUP.value
            and spec.get("targetId") == group_namespace
        )


skill_binding_service = SkillBindingService()
