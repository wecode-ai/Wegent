# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Public Skill service for managing system-level Skills (user_id=0)
"""
from typing import Any, Dict, List, Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.schemas.kind import ObjectMeta, Skill, SkillSpec, SkillStatus


class PublicSkillAdapter:
    """Adapter to convert Kind (Skill) to Skill-like object for API compatibility"""

    @staticmethod
    def to_skill_dict(kind: Kind) -> Dict[str, Any]:
        """Convert Kind (Skill) to Skill-like dictionary"""
        spec = {}
        if isinstance(kind.json, dict):
            spec = kind.json.get("spec", {})

        return {
            "id": kind.id,
            "name": kind.name,
            "namespace": kind.namespace,
            "description": spec.get("description", ""),
            "displayName": spec.get("displayName"),
            "prompt": spec.get("prompt"),
            "version": spec.get("version"),
            "author": spec.get("author"),
            "tags": spec.get("tags"),
            "bindShells": spec.get("bindShells"),
            "is_active": kind.is_active,
            "is_public": True,
            "created_at": kind.created_at,
            "updated_at": kind.updated_at,
        }


class PublicSkillService:
    """
    Public Skill service class - queries kinds table with user_id=0

    System-level skills are stored with user_id=0, making them available
    to all users as shared resources.
    """

    def get_skills(
        self, db: Session, *, skip: int = 0, limit: int = 100
    ) -> List[Dict[str, Any]]:
        """Get active public skills"""
        public_skills = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Skill",
                Kind.namespace == "default",
                Kind.is_active == True,  # noqa: E712
            )
            .order_by(Kind.created_at.desc())
            .offset(skip)
            .limit(limit)
            .all()
        )
        return [PublicSkillAdapter.to_skill_dict(s) for s in public_skills]

    def get_skill_by_id(
        self, db: Session, *, skill_id: int
    ) -> Optional[Dict[str, Any]]:
        """Get public skill by ID"""
        skill = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Skill",
                Kind.id == skill_id,
                Kind.is_active == True,  # noqa: E712
            )
            .first()
        )
        if not skill:
            return None
        return PublicSkillAdapter.to_skill_dict(skill)

    def get_skill_by_name(
        self, db: Session, *, name: str, namespace: str = "default"
    ) -> Optional[Dict[str, Any]]:
        """Get public skill by name"""
        skill = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Skill",
                Kind.name == name,
                Kind.namespace == namespace,
                Kind.is_active == True,  # noqa: E712
            )
            .first()
        )
        if not skill:
            return None
        return PublicSkillAdapter.to_skill_dict(skill)

    def create_skill(
        self,
        db: Session,
        *,
        name: str,
        description: str,
        prompt: Optional[str] = None,
        version: Optional[str] = None,
        author: Optional[str] = None,
        tags: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """Create a public skill (admin only)"""
        # Check uniqueness
        existed = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Skill",
                Kind.name == name,
                Kind.namespace == "default",
            )
            .first()
        )
        if existed:
            raise HTTPException(status_code=400, detail="Skill name already exists")

        json_data = {
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Skill",
            "metadata": {"name": name, "namespace": "default"},
            "spec": {
                "description": description,
                "prompt": prompt,
                "version": version,
                "author": author,
                "tags": tags,
            },
            "status": {"state": "Available"},
        }

        db_obj = Kind(
            user_id=0,
            kind="Skill",
            name=name,
            namespace="default",
            json=json_data,
            is_active=True,
        )
        db.add(db_obj)
        db.commit()
        db.refresh(db_obj)
        return PublicSkillAdapter.to_skill_dict(db_obj)

    def update_skill(
        self,
        db: Session,
        *,
        skill_id: int,
        description: Optional[str] = None,
        prompt: Optional[str] = None,
        version: Optional[str] = None,
        author: Optional[str] = None,
        tags: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """Update a public skill"""
        skill = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Skill",
                Kind.id == skill_id,
                Kind.is_active == True,  # noqa: E712
            )
            .first()
        )
        if not skill:
            raise HTTPException(status_code=404, detail="Skill not found")

        # Update spec fields
        skill_json = skill.json
        if description is not None:
            skill_json["spec"]["description"] = description
        if prompt is not None:
            skill_json["spec"]["prompt"] = prompt
        if version is not None:
            skill_json["spec"]["version"] = version
        if author is not None:
            skill_json["spec"]["author"] = author
        if tags is not None:
            skill_json["spec"]["tags"] = tags

        skill.json = skill_json
        db.commit()
        db.refresh(skill)
        return PublicSkillAdapter.to_skill_dict(skill)

    def upsert_skill(
        self,
        db: Session,
        *,
        name: str,
        description: str,
        prompt: Optional[str] = None,
        version: Optional[str] = None,
        author: Optional[str] = None,
        tags: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """Create or update a public skill by name"""
        existing = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Skill",
                Kind.name == name,
                Kind.namespace == "default",
            )
            .first()
        )

        if existing:
            # Update existing
            existing.json["spec"] = {
                "description": description,
                "prompt": prompt,
                "version": version,
                "author": author,
                "tags": tags,
            }
            existing.is_active = True
            db.commit()
            db.refresh(existing)
            return PublicSkillAdapter.to_skill_dict(existing)
        else:
            # Create new
            return self.create_skill(
                db,
                name=name,
                description=description,
                prompt=prompt,
                version=version,
                author=author,
                tags=tags,
            )

    def delete_skill(self, db: Session, *, skill_id: int) -> None:
        """Delete a public skill"""
        skill = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Skill",
                Kind.id == skill_id,
            )
            .first()
        )
        if not skill:
            raise HTTPException(status_code=404, detail="Skill not found")
        db.delete(skill)
        db.commit()

    def to_skill_crd(self, kind: Kind) -> Skill:
        """Convert Kind model to Skill CRD"""
        metadata = ObjectMeta(
            name=kind.name,
            namespace=kind.namespace,
            labels={"id": str(kind.id), "is_public": "true"},
        )
        return Skill(
            apiVersion=kind.json.get("apiVersion", "agent.wecode.io/v1"),
            kind="Skill",
            metadata=metadata,
            spec=SkillSpec(**kind.json["spec"]),
            status=SkillStatus(**kind.json.get("status", {})),
        )


# Singleton instance
public_skill_service = PublicSkillService()
