# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Skill adapter service for managing Skills using kinds table
"""
from typing import Any, Dict, List, Optional

from fastapi import HTTPException
from sqlalchemy import and_
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.kind import Kind
from app.models.skill_binary import SkillBinary
from app.schemas.kind import ObjectMeta, Skill, SkillList, SkillSpec, SkillStatus
from app.services.skill_service import SkillValidator


class SkillKindsService:
    """Service for managing Skills in kinds table"""

    def create_skill(
        self,
        db: Session,
        *,
        name: str,
        namespace: str,
        file_content: bytes,
        file_name: str,
        user_id: int,
    ) -> Skill:
        """
        Create a new Skill with ZIP package.

        Args:
            db: Database session
            name: Skill name (unique per user)
            namespace: Namespace (default: "default")
            file_content: ZIP file binary content
            file_name: Original file name
            user_id: User ID

        Returns:
            Created Skill CRD

        Raises:
            HTTPException: If validation fails or name already exists
        """
        # Check duplicate skill name
        existing = (
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

        if existing:
            raise HTTPException(
                status_code=400,
                detail=f"Skill name '{name}' already exists in namespace '{namespace}'",
            )

        # Validate ZIP package and extract metadata
        metadata = SkillValidator.validate_zip(file_content, file_name)

        # Create Skill Kind
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
                "tools": metadata.get("tools"),
                "provider": metadata.get("provider"),
            },
            "status": {
                "state": "Available",
                "fileSize": metadata["file_size"],
                "fileHash": metadata["file_hash"],
            },
        }

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

    def update_skill(
        self,
        db: Session,
        *,
        skill_id: int,
        user_id: int,
        file_content: bytes,
        file_name: str,
    ) -> Skill:
        """
        Update Skill ZIP package.

        Args:
            db: Database session
            skill_id: Skill ID
            user_id: User ID
            file_content: New ZIP file content
            file_name: New file name

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
                "tools": metadata.get("tools"),
                "provider": metadata.get("provider"),
            }
        )
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

        # Check if any Ghost references this Skill
        ghosts = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id, Kind.kind == "Ghost", Kind.is_active == True
            )
            .all()
        )

        referenced_ghosts = []
        for ghost in ghosts:
            ghost_skills = ghost.json.get("spec", {}).get("skills", [])
            if skill_name in ghost_skills:
                referenced_ghosts.append(
                    {"id": ghost.id, "name": ghost.name, "namespace": ghost.namespace}
                )

        if referenced_ghosts:
            raise HTTPException(
                status_code=400,
                detail={
                    "code": "SKILL_REFERENCED",
                    "message": f"Cannot delete Skill '{skill_name}' because it is referenced by Ghosts",
                    "skill_name": skill_name,
                    "referenced_ghosts": referenced_ghosts,
                },
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
        ghosts = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id, Kind.kind == "Ghost", Kind.is_active == True
            )
            .all()
        )

        affected_ghosts = []
        for ghost in ghosts:
            ghost_skills = ghost.json.get("spec", {}).get("skills", [])
            if skill_name in ghost_skills:
                # Remove the skill reference from Ghost
                new_skills = [s for s in ghost_skills if s != skill_name]
                ghost_json = ghost.json.copy()
                ghost_json["spec"]["skills"] = new_skills
                ghost.json = ghost_json
                # Mark JSON field as modified for SQLAlchemy to detect the change
                flag_modified(ghost, "json")
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

        ghost = (
            db.query(Kind)
            .filter(
                Kind.id == ghost_id,
                Kind.user_id == user_id,
                Kind.kind == "Ghost",
                Kind.is_active == True,
            )
            .first()
        )

        if not ghost:
            raise HTTPException(status_code=404, detail="Ghost not found")

        skill_name = skill_kind.name
        ghost_skills = ghost.json.get("spec", {}).get("skills", [])

        if skill_name not in ghost_skills:
            raise HTTPException(
                status_code=400,
                detail=f"Ghost '{ghost.name}' does not reference Skill '{skill_name}'",
            )

        # Remove the skill reference from Ghost
        new_skills = [s for s in ghost_skills if s != skill_name]
        ghost_json = ghost.json.copy()
        ghost_json["spec"]["skills"] = new_skills
        ghost.json = ghost_json
        # Mark JSON field as modified for SQLAlchemy to detect the change
        flag_modified(ghost, "json")

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

    def _kind_to_skill(self, kind: Kind) -> Skill:
        """Convert Kind model to Skill CRD"""
        metadata = ObjectMeta(
            name=kind.name,
            namespace=kind.namespace,
            labels={"id": str(kind.id)},  # Store database ID in labels
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
