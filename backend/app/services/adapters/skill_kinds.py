# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Skill adapter service for managing Skills using kinds table
"""

import logging
from copy import deepcopy
from typing import Any, Dict, List, Optional

from fastapi import HTTPException
from sqlalchemy import and_, or_
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.kind import Kind
from app.models.skill_binary import SkillBinary
from app.schemas.kind import ObjectMeta, Skill, SkillList, SkillSpec, SkillStatus
from app.services.skill_service import SkillValidator

logger = logging.getLogger(__name__)


class SkillKindsService:
    """Service for managing Skills in kinds table"""

    @staticmethod
    def _get_ghost_spec(ghost: Kind) -> Dict[str, Any]:
        """Return the mutable Ghost spec dictionary."""
        ghost_json = ghost.json if isinstance(ghost.json, dict) else {}
        spec = ghost_json.get("spec", {})
        return spec if isinstance(spec, dict) else {}

    @staticmethod
    def _get_skill_ref_map(spec: Dict[str, Any], key: str) -> Dict[str, Dict[str, Any]]:
        """Return a normalized skill ref mapping from Ghost spec."""
        raw_value = spec.get(key, {})
        if isinstance(raw_value, dict):
            return raw_value
        return {}

    @staticmethod
    def _get_skill_name_list(spec: Dict[str, Any], key: str) -> List[str]:
        """Return a normalized skill name list from Ghost spec."""
        raw_value = spec.get(key, [])
        if isinstance(raw_value, list):
            return [value for value in raw_value if isinstance(value, str)]
        return []

    @staticmethod
    def _ref_matches_skill(ref_meta: Any, skill: Kind) -> bool:
        """Check whether a Ghost ref points to the target Skill row."""
        return isinstance(ref_meta, dict) and ref_meta.get("skill_id") == skill.id

    def _ghost_references_skill(self, ghost: Kind, skill: Kind) -> bool:
        """Check whether a Ghost references the exact Skill.

        Prefer exact skill_id matches from skill_refs/preload_skill_refs.
        Only fall back to legacy name-based matching when no explicit refs exist
        for the same skill name.
        """
        spec = self._get_ghost_spec(ghost)
        skill_name = skill.name
        skill_refs = self._get_skill_ref_map(spec, "skill_refs")
        preload_skill_refs = self._get_skill_ref_map(spec, "preload_skill_refs")

        if self._ref_matches_skill(skill_refs.get(skill_name), skill):
            return True
        if self._ref_matches_skill(preload_skill_refs.get(skill_name), skill):
            return True

        has_explicit_ref = skill_name in skill_refs or skill_name in preload_skill_refs
        if has_explicit_ref:
            return False

        ghost_skills = self._get_skill_name_list(spec, "skills")
        ghost_preload_skills = self._get_skill_name_list(spec, "preload_skills")
        return skill_name in ghost_skills or skill_name in ghost_preload_skills

    def _remove_ghost_skill_reference(self, ghost: Kind, skill: Kind) -> bool:
        """Remove an exact Skill reference from a Ghost.

        Returns True when the Ghost was mutated.
        """
        ghost_json = deepcopy(ghost.json) if isinstance(ghost.json, dict) else {}
        spec = ghost_json.get("spec", {})
        if not isinstance(spec, dict):
            return False

        skill_name = skill.name
        skill_refs = self._get_skill_ref_map(spec, "skill_refs")
        preload_skill_refs = self._get_skill_ref_map(spec, "preload_skill_refs")

        removed = False
        if self._ref_matches_skill(skill_refs.get(skill_name), skill):
            spec["skills"] = [
                name
                for name in self._get_skill_name_list(spec, "skills")
                if name != skill_name
            ]
            spec["skill_refs"] = {
                name: ref for name, ref in skill_refs.items() if name != skill_name
            }
            removed = True

        if self._ref_matches_skill(preload_skill_refs.get(skill_name), skill):
            spec["preload_skills"] = [
                name
                for name in self._get_skill_name_list(spec, "preload_skills")
                if name != skill_name
            ]
            spec["preload_skill_refs"] = {
                name: ref
                for name, ref in preload_skill_refs.items()
                if name != skill_name
            }
            removed = True

        has_explicit_ref = skill_name in skill_refs or skill_name in preload_skill_refs
        if not removed and not has_explicit_ref:
            current_skills = self._get_skill_name_list(spec, "skills")
            current_preload_skills = self._get_skill_name_list(spec, "preload_skills")
            if skill_name in current_skills:
                spec["skills"] = [name for name in current_skills if name != skill_name]
                removed = True
            if skill_name in current_preload_skills:
                spec["preload_skills"] = [
                    name for name in current_preload_skills if name != skill_name
                ]
                removed = True

        if removed:
            ghost.json = ghost_json
            flag_modified(ghost, "json")

        return removed

    def _list_candidate_ghosts_for_skill(self, db: Session, skill: Kind) -> List[Kind]:
        """List Ghosts that may reference the given Skill.

        Personal skills are only visible to the owner's Ghosts.
        Group skills are shared within the namespace, so inspect all active Ghosts
        in that namespace regardless of owner.
        """
        query = db.query(Kind).filter(Kind.kind == "Ghost", Kind.is_active == True)
        if skill.namespace == "default":
            query = query.filter(Kind.user_id == skill.user_id)
        else:
            query = query.filter(
                or_(Kind.namespace == skill.namespace, Kind.user_id == skill.user_id)
            )
        return query.all()

    def _get_candidate_ghost_for_skill(
        self, db: Session, skill: Kind, ghost_id: int
    ) -> Optional[Kind]:
        """Return a specific Ghost if it is in the candidate scope for this Skill."""
        query = db.query(Kind).filter(
            Kind.id == ghost_id, Kind.kind == "Ghost", Kind.is_active == True
        )
        if skill.namespace == "default":
            query = query.filter(Kind.user_id == skill.user_id)
        else:
            query = query.filter(
                or_(Kind.namespace == skill.namespace, Kind.user_id == skill.user_id)
            )
        return query.first()

    def _build_skill_references_payload(
        self, db: Session, skill: Kind
    ) -> Dict[str, Any]:
        """Build the referenced Ghost list payload for a Skill."""
        ghosts = self._list_candidate_ghosts_for_skill(db, skill)
        referenced_ghosts = []
        for ghost in ghosts:
            if self._ghost_references_skill(ghost, skill):
                referenced_ghosts.append(
                    {"id": ghost.id, "name": ghost.name, "namespace": ghost.namespace}
                )

        return {
            "skill_id": skill.id,
            "skill_name": skill.name,
            "referenced_ghosts": referenced_ghosts,
        }

    def get_skill_references(
        self, db: Session, *, skill_id: int, user_id: int
    ) -> Dict[str, Any]:
        """Return Ghost references for a Skill."""
        skill_kind = (
            db.query(Kind)
            .filter(
                Kind.id == skill_id,
                Kind.user_id == user_id,
                Kind.kind == "Skill",
                Kind.is_active == True,
            )
            .first()
        )

        if not skill_kind:
            raise HTTPException(status_code=404, detail="Skill not found")

        return self._build_skill_references_payload(db, skill_kind)

    def create_skill(
        self,
        db: Session,
        *,
        name: str,
        namespace: str,
        file_content: bytes,
        file_name: str,
        user_id: int,
        source: Optional[Dict[str, Any]] = None,
    ) -> Skill:
        """
        Create a new Skill with ZIP package.

        If a soft-deleted skill with the same name exists, it will be restored
        and updated with the new content.

        Args:
            db: Database session
            name: Skill name (unique per user)
            namespace: Namespace (default: "default")
            file_content: ZIP file binary content
            file_name: Original file name
            user_id: User ID
            source: Optional source information (for git-imported skills)

        Returns:
            Created Skill CRD

        Raises:
            HTTPException: If validation fails or name already exists (active)
        """
        # Check for existing skill (including soft-deleted ones)
        # For default namespace: check by (user_id, name, namespace) - personal space
        # For non-default namespace: check by (name, namespace) - shared group space
        logger.info(
            f"[create_skill] Checking for existing skill: name={name}, namespace={namespace}, user_id={user_id}"
        )
        if namespace == "default":
            # Personal namespace: each user can have their own skill with the same name
            existing = (
                db.query(Kind)
                .filter(
                    Kind.user_id == user_id,
                    Kind.kind == "Skill",
                    Kind.name == name,
                    Kind.namespace == namespace,
                )
                .first()
            )
            logger.info(
                f"[create_skill] Default namespace check: existing={existing is not None}, is_active={existing.is_active if existing else None}"
            )
        else:
            # Group namespace: allow different users to have skills with the same name
            # But check if this user already has a skill with this name in this namespace
            existing = (
                db.query(Kind)
                .filter(
                    Kind.user_id == user_id,
                    Kind.kind == "Skill",
                    Kind.name == name,
                    Kind.namespace == namespace,
                )
                .first()
            )
            logger.info(
                f"[create_skill] Group namespace check: existing={existing is not None}, is_active={existing.is_active if existing else None}"
            )

        if existing and existing.is_active:
            logger.warning(
                f"[create_skill] Skill already exists: name={name}, namespace={namespace}, user_id={user_id}"
            )
            raise HTTPException(
                status_code=400,
                detail=f"Skill name '{name}' already exists in namespace '{namespace}'",
            )

        # Validate ZIP package and extract metadata
        metadata = SkillValidator.validate_zip(file_content, file_name)

        # Build skill JSON
        skill_json = {
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Skill",
            "metadata": {"name": name, "namespace": namespace},
            "spec": {
                "description": metadata["description"],
                "displayName": metadata.get("displayName"),
                "prompt": metadata.get("prompt"),
                "version": metadata.get("version"),
                "author": metadata.get("author"),
                "tags": metadata.get("tags"),
                "bindShells": metadata.get("bindShells"),
                "config": metadata.get("config"),
                "tools": metadata.get("tools"),
                "provider": metadata.get("provider"),
                "mcpServers": metadata.get("mcpServers"),
                "preload": metadata.get("preload", False),
                "source": source,
            },
            "status": {
                "state": "Available",
                "fileSize": metadata["file_size"],
                "fileHash": metadata["file_hash"],
            },
        }

        if existing and not existing.is_active:
            # Restore soft-deleted skill and update with new content
            existing.json = skill_json
            existing.is_active = True
            flag_modified(existing, "json")
            db.flush()

            # Update or create SkillBinary
            skill_binary = (
                db.query(SkillBinary).filter(SkillBinary.kind_id == existing.id).first()
            )
            if skill_binary:
                skill_binary.binary_data = file_content
                skill_binary.file_size = metadata["file_size"]
                skill_binary.file_hash = metadata["file_hash"]
            else:
                skill_binary = SkillBinary(
                    kind_id=existing.id,
                    binary_data=file_content,
                    file_size=metadata["file_size"],
                    file_hash=metadata["file_hash"],
                )
                db.add(skill_binary)

            result = self._kind_to_skill(existing)
            db.commit()
            return result

        # Create new Skill Kind
        skill_kind = Kind(
            user_id=user_id,
            kind="Skill",
            name=name,
            namespace=namespace,
            json=skill_json,
            is_active=True,
        )
        db.add(skill_kind)
        db.flush()  # Get skill_kind.id

        # Create SkillBinary
        skill_binary = SkillBinary(
            kind_id=skill_kind.id,
            binary_data=file_content,
            file_size=metadata["file_size"],
            file_hash=metadata["file_hash"],
        )
        db.add(skill_binary)

        # Build result before commit to avoid lazy loading issues
        result = self._kind_to_skill(skill_kind)
        db.commit()

        return result

    def get_skill_by_id(
        self, db: Session, *, skill_id: int, user_id: int
    ) -> Optional[Skill]:
        """Get Skill by ID"""
        skill_kind = (
            db.query(Kind)
            .filter(
                Kind.id == skill_id,
                Kind.user_id == user_id,
                Kind.kind == "Skill",
                Kind.is_active == True,
            )
            .first()
        )

        if not skill_kind:
            return None

        return self._kind_to_skill(skill_kind)

    def get_skill_by_id_in_namespace(
        self, db: Session, *, skill_id: int, namespace: str
    ) -> Optional[Skill]:
        """
        Get Skill by ID within a namespace (for group skills).

        This method is used to access group-level skills where user_id doesn't matter,
        as long as the skill is in the correct namespace.

        Args:
            db: Database session
            skill_id: Skill ID
            namespace: Namespace to search in

        Returns:
            Skill if found, None otherwise
        """
        skill_kind = (
            db.query(Kind)
            .filter(
                Kind.id == skill_id,
                Kind.namespace == namespace,
                Kind.kind == "Skill",
                Kind.is_active == True,
            )
            .first()
        )

        if not skill_kind:
            return None

        return self._kind_to_skill(skill_kind)

    def get_skill_by_name(
        self, db: Session, *, name: str, namespace: str, user_id: int
    ) -> Optional[Skill]:
        """Get Skill by name and namespace"""
        skill_kind = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "Skill",
                Kind.name == name,
                Kind.namespace == namespace,
                Kind.is_active == True,
            )
            .first()
        )

        if not skill_kind:
            return None

        return self._kind_to_skill(skill_kind)

    def get_skill_by_name_in_namespace(
        self, db: Session, *, name: str, namespace: str
    ) -> Optional[Skill]:
        """
        Get Skill by name within a namespace (for group skills).

        This method is used to access group-level skills where user_id doesn't matter,
        as long as the skill is in the correct namespace.

        Args:
            db: Database session
            name: Skill name
            namespace: Namespace to search in

        Returns:
            Skill if found, None otherwise
        """
        skill_kind = (
            db.query(Kind)
            .filter(
                Kind.kind == "Skill",
                Kind.name == name,
                Kind.namespace == namespace,
                Kind.is_active == True,
            )
            .first()
        )

        if not skill_kind:
            return None

        return self._kind_to_skill(skill_kind)

    def list_skills(
        self,
        db: Session,
        *,
        user_id: int,
        skip: int = 0,
        limit: int = 100,
        namespace: str = "default",
    ) -> SkillList:
        """List all Skills for a user"""
        query = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "Skill",
                Kind.namespace == namespace,
                Kind.is_active == True,
            )
            .order_by(Kind.created_at.desc())
        )

        total = query.count()
        skills = query.offset(skip).limit(limit).all()

        return SkillList(items=[self._kind_to_skill(skill) for skill in skills])

    def list_skills_in_namespace(
        self,
        db: Session,
        *,
        namespace: str,
        skip: int = 0,
        limit: int = 100,
    ) -> SkillList:
        """
        List all Skills in a namespace (for group skills).

        This method is used to list group-level skills where user_id doesn't matter,
        returning all skills in the specified namespace.

        Args:
            db: Database session
            namespace: Namespace to search in
            skip: Number of items to skip
            limit: Maximum number of items to return

        Returns:
            SkillList containing all skills in the namespace
        """
        query = (
            db.query(Kind)
            .filter(
                Kind.kind == "Skill",
                Kind.namespace == namespace,
                Kind.is_active == True,
            )
            .order_by(Kind.created_at.desc())
        )

        total = query.count()
        skills = query.offset(skip).limit(limit).all()

        return SkillList(items=[self._kind_to_skill(skill) for skill in skills])

    def update_skill(
        self,
        db: Session,
        *,
        skill_id: int,
        user_id: int,
        file_content: bytes,
        file_name: str,
        source: Optional[Dict[str, Any]] = None,
    ) -> Skill:
        """
        Update Skill ZIP package.

        Args:
            db: Database session
            skill_id: Skill ID
            user_id: User ID
            file_content: New ZIP file content
            file_name: New file name
            source: Optional source information (for git-imported skills)

        Returns:
            Updated Skill CRD

        Raises:
            HTTPException: If skill not found or validation fails
        """
        skill_kind = (
            db.query(Kind)
            .filter(
                Kind.id == skill_id,
                Kind.user_id == user_id,
                Kind.kind == "Skill",
                Kind.is_active == True,
            )
            .first()
        )

        if not skill_kind:
            raise HTTPException(status_code=404, detail="Skill not found")

        # Validate new ZIP package
        metadata = SkillValidator.validate_zip(file_content, file_name)

        # Update skill_kind JSON
        skill_json = skill_kind.json
        skill_json["spec"].update(
            {
                "description": metadata["description"],
                "displayName": metadata.get("displayName"),
                "prompt": metadata.get("prompt"),
                "version": metadata.get("version"),
                "author": metadata.get("author"),
                "tags": metadata.get("tags"),
                "bindShells": metadata.get("bindShells"),
                "config": metadata.get("config"),
                "tools": metadata.get("tools"),
                "provider": metadata.get("provider"),
                "mcpServers": metadata.get("mcpServers"),
                "preload": metadata.get("preload", False),
            }
        )
        # Update source if provided (for git-imported skills)
        if source is not None:
            skill_json["spec"]["source"] = source
        skill_json["status"].update(
            {"fileSize": metadata["file_size"], "fileHash": metadata["file_hash"]}
        )
        skill_kind.json = skill_json
        # Mark JSON field as modified for SQLAlchemy to detect the change
        flag_modified(skill_kind, "json")

        # Update or create SkillBinary
        skill_binary = (
            db.query(SkillBinary).filter(SkillBinary.kind_id == skill_id).first()
        )

        if skill_binary:
            skill_binary.binary_data = file_content
            skill_binary.file_size = metadata["file_size"]
            skill_binary.file_hash = metadata["file_hash"]
        else:
            skill_binary = SkillBinary(
                kind_id=skill_id,
                binary_data=file_content,
                file_size=metadata["file_size"],
                file_hash=metadata["file_hash"],
            )
            db.add(skill_binary)

        # Build result before commit to avoid lazy loading issues
        result = self._kind_to_skill(skill_kind)
        db.commit()

        return result

    def delete_skill(self, db: Session, *, skill_id: int, user_id: int) -> None:
        """
        Delete Skill (soft delete for Kind, hard delete for SkillBinary).

        Checks if the Skill is referenced by any Ghost before deletion.

        Args:
            db: Database session
            skill_id: Skill ID
            user_id: User ID

        Raises:
            HTTPException: If skill not found or is referenced by Ghosts
        """
        skill_kind = (
            db.query(Kind)
            .filter(
                Kind.id == skill_id,
                Kind.user_id == user_id,
                Kind.kind == "Skill",
                Kind.is_active == True,
            )
            .first()
        )

        if not skill_kind:
            raise HTTPException(status_code=404, detail="Skill not found")

        skill_name = skill_kind.name
        logger.info(
            "[delete_skill] Checking references for skill_id=%s skill_name=%s namespace=%s owner_user_id=%s",
            skill_kind.id,
            skill_kind.name,
            skill_kind.namespace,
            skill_kind.user_id,
        )

        # Check if any Ghost references this Skill
        ghosts = self._list_candidate_ghosts_for_skill(db, skill_kind)
        logger.info(
            "[delete_skill] Scanning %s active ghosts for skill_id=%s namespace=%s",
            len(ghosts),
            skill_kind.id,
            skill_kind.namespace,
        )

        referenced_ghosts = []
        for ghost in ghosts:
            spec = self._get_ghost_spec(ghost)
            skill_refs = self._get_skill_ref_map(spec, "skill_refs")
            preload_skill_refs = self._get_skill_ref_map(spec, "preload_skill_refs")
            ghost_skills = self._get_skill_name_list(spec, "skills")
            ghost_preload_skills = self._get_skill_name_list(spec, "preload_skills")
            is_referenced = self._ghost_references_skill(ghost, skill_kind)
            logger.info(
                "[delete_skill] Ghost reference check: ghost_id=%s ghost_name=%s ghost_namespace=%s matches=%s has_skill_name=%s has_preload_skill_name=%s skill_ref=%s preload_skill_ref=%s",
                ghost.id,
                ghost.name,
                ghost.namespace,
                is_referenced,
                skill_name in ghost_skills,
                skill_name in ghost_preload_skills,
                skill_refs.get(skill_name),
                preload_skill_refs.get(skill_name),
            )
            if is_referenced:
                referenced_ghosts.append(
                    {"id": ghost.id, "name": ghost.name, "namespace": ghost.namespace}
                )

        if referenced_ghosts:
            logger.info(
                "[delete_skill] Blocked deletion for skill_id=%s referenced_ghosts=%s",
                skill_kind.id,
                referenced_ghosts,
            )
            raise HTTPException(
                status_code=400,
                detail={
                    "code": "SKILL_REFERENCED",
                    "message": f"Cannot delete Skill '{skill_name}' because it is referenced by Ghosts",
                    "skill_name": skill_name,
                    "referenced_ghosts": referenced_ghosts,
                },
            )

        logger.info(
            "[delete_skill] No ghost references found for skill_id=%s", skill_kind.id
        )

        # Delete associated SkillBinary (hard delete to free storage)
        db.query(SkillBinary).filter(SkillBinary.kind_id == skill_id).delete()

        # Soft delete the Kind record
        skill_kind.is_active = False
        db.commit()

    def remove_skill_references(
        self, db: Session, *, skill_id: int, user_id: int
    ) -> Dict[str, Any]:
        """
        Remove all Ghost references to a Skill.

        This allows the Skill to be deleted afterwards.

        Args:
            db: Database session
            skill_id: Skill ID
            user_id: User ID

        Returns:
            Dict with removed_count and affected_ghosts

        Raises:
            HTTPException: If skill not found
        """
        skill_kind = (
            db.query(Kind)
            .filter(
                Kind.id == skill_id,
                Kind.user_id == user_id,
                Kind.kind == "Skill",
                Kind.is_active == True,
            )
            .first()
        )

        if not skill_kind:
            raise HTTPException(status_code=404, detail="Skill not found")

        skill_name = skill_kind.name

        # Find all Ghosts that reference this Skill
        ghosts = self._list_candidate_ghosts_for_skill(db, skill_kind)

        affected_ghosts = []
        for ghost in ghosts:
            if self._remove_ghost_skill_reference(ghost, skill_kind):
                affected_ghosts.append(ghost.name)

        db.commit()

        return {
            "removed_count": len(affected_ghosts),
            "affected_ghosts": affected_ghosts,
        }

    def remove_single_skill_reference(
        self, db: Session, *, skill_id: int, ghost_id: int, user_id: int
    ) -> Dict[str, Any]:
        """
        Remove a Skill reference from a single Ghost.

        Args:
            db: Database session
            skill_id: Skill ID
            ghost_id: Ghost ID
            user_id: User ID

        Returns:
            Dict with success status and ghost name

        Raises:
            HTTPException: If skill or ghost not found
        """
        skill_kind = (
            db.query(Kind)
            .filter(
                Kind.id == skill_id,
                Kind.user_id == user_id,
                Kind.kind == "Skill",
                Kind.is_active == True,
            )
            .first()
        )

        if not skill_kind:
            raise HTTPException(status_code=404, detail="Skill not found")

        ghost = self._get_candidate_ghost_for_skill(db, skill_kind, ghost_id)

        if not ghost:
            raise HTTPException(status_code=404, detail="Ghost not found")

        if not self._ghost_references_skill(ghost, skill_kind):
            raise HTTPException(
                status_code=400,
                detail=f"Ghost '{ghost.name}' does not reference Skill '{skill_kind.name}'",
            )

        self._remove_ghost_skill_reference(ghost, skill_kind)

        db.commit()

        return {"success": True, "ghost_name": ghost.name}

    def get_skill_binary(
        self, db: Session, *, skill_id: int, user_id: int
    ) -> Optional[bytes]:
        """
        Get Skill ZIP binary data.

        Args:
            db: Database session
            skill_id: Skill ID
            user_id: User ID

        Returns:
            ZIP file binary content or None if not found
        """
        # Verify ownership
        skill_kind = (
            db.query(Kind)
            .filter(
                Kind.id == skill_id,
                Kind.user_id == user_id,
                Kind.kind == "Skill",
                Kind.is_active == True,
            )
            .first()
        )

        if not skill_kind:
            return None

        # Get binary data
        skill_binary = (
            db.query(SkillBinary).filter(SkillBinary.kind_id == skill_id).first()
        )

        if not skill_binary:
            return None

        return skill_binary.binary_data

    def get_skill_binary_in_namespace(
        self, db: Session, *, skill_id: int, namespace: str
    ) -> Optional[bytes]:
        """
        Get Skill ZIP binary data within a namespace (for group skills).

        This method is used to access group-level skill binaries where user_id doesn't matter,
        as long as the skill is in the correct namespace.

        Args:
            db: Database session
            skill_id: Skill ID
            namespace: Namespace to search in

        Returns:
            ZIP file binary content or None if not found
        """
        # Verify skill exists in namespace
        skill_kind = (
            db.query(Kind)
            .filter(
                Kind.id == skill_id,
                Kind.namespace == namespace,
                Kind.kind == "Skill",
                Kind.is_active == True,
            )
            .first()
        )

        if not skill_kind:
            return None

        # Get binary data
        skill_binary = (
            db.query(SkillBinary).filter(SkillBinary.kind_id == skill_id).first()
        )

        if not skill_binary:
            return None

        return skill_binary.binary_data

    def _kind_to_skill(self, kind: Kind) -> Skill:
        """Convert Kind model to Skill CRD"""
        metadata = ObjectMeta(
            name=kind.name,
            namespace=kind.namespace,
            labels={
                "id": str(kind.id),
                "user_id": str(kind.user_id),
            },  # Store database ID and user_id in labels
        )
        return Skill(
            apiVersion=kind.json.get("apiVersion", "agent.wecode.io/v1"),
            kind="Skill",
            metadata=metadata,
            spec=SkillSpec(**kind.json["spec"]),
            status=SkillStatus(**kind.json.get("status", {})),
        )


# Singleton instance
skill_kinds_service = SkillKindsService()
