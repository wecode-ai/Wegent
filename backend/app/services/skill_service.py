# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Skill service for managing Claude Code Skills
"""
import hashlib
import io
import re
import zipfile
from typing import Dict, Any, List
from fastapi import HTTPException
from sqlalchemy import and_
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.skill_binary import SkillBinary
from app.schemas.kind import Skill, SkillList, SkillSpec, SkillStatus, ObjectMeta


class SkillValidator:
    """Validator for Skill ZIP packages"""
    MAX_SIZE = 10 * 1024 * 1024  # 10MB

    @staticmethod
    def validate_zip(file_content: bytes) -> Dict[str, Any]:
        """
        Validate ZIP package and extract metadata from SKILL.md

        Args:
            file_content: ZIP file binary content

        Returns:
            Dict with keys: description, version, author, tags, file_size, file_hash

        Raises:
            HTTPException: If validation fails
        """
        # Check file size
        file_size = len(file_content)
        if file_size > SkillValidator.MAX_SIZE:
            raise HTTPException(
                status_code=413,
                detail=f"File size exceeds maximum limit of {SkillValidator.MAX_SIZE / 1024 / 1024}MB"
            )

        # Verify it's a valid ZIP file
        try:
            zip_buffer = io.BytesIO(file_content)
            with zipfile.ZipFile(zip_buffer, 'r') as zip_file:
                # Check for SKILL.md
                skill_md_found = False
                skill_md_content = None

                for name in zip_file.namelist():
                    # Prevent directory traversal attacks
                    if name.startswith('/') or '..' in name:
                        raise HTTPException(
                            status_code=400,
                            detail="Invalid file path in ZIP package"
                        )

                    if name.endswith('SKILL.md'):
                        skill_md_found = True
                        skill_md_content = zip_file.read(name).decode('utf-8', errors='ignore')
                        break

                if not skill_md_found:
                    raise HTTPException(
                        status_code=400,
                        detail="SKILL.md not found in ZIP package"
                    )

                # Parse YAML frontmatter from SKILL.md
                metadata = SkillValidator._parse_skill_md(skill_md_content)

        except zipfile.BadZipFile:
            raise HTTPException(
                status_code=400,
                detail="Invalid ZIP file format"
            )
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(
                status_code=400,
                detail=f"Failed to process ZIP file: {str(e)}"
            )

        # Calculate SHA256 hash
        file_hash = hashlib.sha256(file_content).hexdigest()

        return {
            "description": metadata.get("description", ""),
            "version": metadata.get("version"),
            "author": metadata.get("author"),
            "tags": metadata.get("tags", []),
            "file_size": file_size,
            "file_hash": file_hash
        }

    @staticmethod
    def _parse_skill_md(content: str) -> Dict[str, Any]:
        """
        Parse YAML frontmatter from SKILL.md

        Expected format:
        ---
        description: "Skill description"
        version: "1.0.0"
        author: "Author Name"
        tags: ["tag1", "tag2"]
        ---
        """
        # Extract YAML frontmatter
        frontmatter_pattern = r'^---\s*\n(.*?)\n---'
        match = re.search(frontmatter_pattern, content, re.DOTALL | re.MULTILINE)

        if not match:
            raise HTTPException(
                status_code=400,
                detail="SKILL.md must contain YAML frontmatter (---\\n...\\n---)"
            )

        yaml_content = match.group(1)
        metadata = {}

        # Simple YAML parser for basic key-value pairs
        for line in yaml_content.split('\n'):
            line = line.strip()
            if not line or line.startswith('#'):
                continue

            # Handle key: value format
            if ':' in line:
                key, value = line.split(':', 1)
                key = key.strip()
                value = value.strip()

                # Remove quotes
                if value.startswith('"') and value.endswith('"'):
                    value = value[1:-1]
                elif value.startswith("'") and value.endswith("'"):
                    value = value[1:-1]

                # Handle array format [item1, item2]
                if value.startswith('[') and value.endswith(']'):
                    items = value[1:-1].split(',')
                    value = [item.strip().strip('"').strip("'") for item in items if item.strip()]

                metadata[key] = value

        # Validate required fields
        if "description" not in metadata:
            raise HTTPException(
                status_code=400,
                detail="SKILL.md frontmatter must contain 'description' field"
            )

        return metadata


class SkillService:
    """Service for managing Skills"""

    @staticmethod
    def create_skill(
        db: Session,
        user_id: int,
        name: str,
        namespace: str,
        file_content: bytes
    ) -> Skill:
        """
        Create a new Skill

        Args:
            db: Database session
            user_id: User ID
            name: Skill name
            namespace: Namespace
            file_content: ZIP file binary content

        Returns:
            Skill CRD object

        Raises:
            HTTPException: If validation fails or name already exists
        """
        # Check if skill name already exists for this user
        existing = db.query(Kind).filter(
            and_(
                Kind.user_id == user_id,
                Kind.kind == "Skill",
                Kind.name == name,
                Kind.namespace == namespace
            )
        ).first()

        if existing:
            raise HTTPException(
                status_code=400,
                detail=f"Skill '{name}' already exists in namespace '{namespace}'"
            )

        # Validate ZIP package
        metadata = SkillValidator.validate_zip(file_content)

        # Create Kind record
        skill_crd = {
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Skill",
            "metadata": {
                "name": name,
                "namespace": namespace
            },
            "spec": {
                "description": metadata["description"],
                "version": metadata.get("version"),
                "author": metadata.get("author"),
                "tags": metadata.get("tags", [])
            },
            "status": {
                "state": "Available",
                "fileSize": metadata["file_size"],
                "fileHash": metadata["file_hash"]
            }
        }

        kind_record = Kind(
            user_id=user_id,
            kind="Skill",
            name=name,
            namespace=namespace,
            json=skill_crd
        )
        db.add(kind_record)
        db.flush()

        # Create SkillBinary record
        binary_record = SkillBinary(
            kind_id=kind_record.id,
            binary_data=file_content,
            file_size=metadata["file_size"],
            file_hash=metadata["file_hash"]
        )
        db.add(binary_record)
        db.commit()
        db.refresh(kind_record)

        return Skill(**kind_record.json)

    @staticmethod
    def get_skill(db: Session, user_id: int, skill_id: int) -> Skill:
        """Get Skill by ID"""
        kind = db.query(Kind).filter(
            and_(
                Kind.id == skill_id,
                Kind.user_id == user_id,
                Kind.kind == "Skill"
            )
        ).first()

        if not kind:
            raise HTTPException(status_code=404, detail="Skill not found")

        return Skill(**kind.json)

    @staticmethod
    def list_skills(
        db: Session,
        user_id: int,
        skip: int = 0,
        limit: int = 100
    ) -> SkillList:
        """List all Skills for a user"""
        kinds = db.query(Kind).filter(
            and_(
                Kind.user_id == user_id,
                Kind.kind == "Skill"
            )
        ).offset(skip).limit(limit).all()

        items = [Skill(**kind.json) for kind in kinds]
        return SkillList(items=items)

    @staticmethod
    def get_skill_binary(db: Session, user_id: int, skill_id: int) -> bytes:
        """Get Skill ZIP binary data"""
        kind = db.query(Kind).filter(
            and_(
                Kind.id == skill_id,
                Kind.user_id == user_id,
                Kind.kind == "Skill"
            )
        ).first()

        if not kind:
            raise HTTPException(status_code=404, detail="Skill not found")

        binary = db.query(SkillBinary).filter(
            SkillBinary.kind_id == skill_id
        ).first()

        if not binary:
            raise HTTPException(status_code=404, detail="Skill binary not found")

        return binary.binary_data

    @staticmethod
    def update_skill(
        db: Session,
        user_id: int,
        skill_id: int,
        file_content: bytes
    ) -> Skill:
        """Update Skill with new ZIP package"""
        kind = db.query(Kind).filter(
            and_(
                Kind.id == skill_id,
                Kind.user_id == user_id,
                Kind.kind == "Skill"
            )
        ).first()

        if not kind:
            raise HTTPException(status_code=404, detail="Skill not found")

        # Validate new ZIP package
        metadata = SkillValidator.validate_zip(file_content)

        # Update Kind record
        skill_crd = kind.json
        skill_crd["spec"]["description"] = metadata["description"]
        skill_crd["spec"]["version"] = metadata.get("version")
        skill_crd["spec"]["author"] = metadata.get("author")
        skill_crd["spec"]["tags"] = metadata.get("tags", [])
        skill_crd["status"]["fileSize"] = metadata["file_size"]
        skill_crd["status"]["fileHash"] = metadata["file_hash"]

        kind.json = skill_crd

        # Update SkillBinary record
        binary = db.query(SkillBinary).filter(
            SkillBinary.kind_id == skill_id
        ).first()

        if binary:
            binary.binary_data = file_content
            binary.file_size = metadata["file_size"]
            binary.file_hash = metadata["file_hash"]
        else:
            binary = SkillBinary(
                kind_id=skill_id,
                binary_data=file_content,
                file_size=metadata["file_size"],
                file_hash=metadata["file_hash"]
            )
            db.add(binary)

        db.commit()
        db.refresh(kind)

        return Skill(**kind.json)

    @staticmethod
    def delete_skill(db: Session, user_id: int, skill_id: int):
        """Delete Skill after checking references"""
        kind = db.query(Kind).filter(
            and_(
                Kind.id == skill_id,
                Kind.user_id == user_id,
                Kind.kind == "Skill"
            )
        ).first()

        if not kind:
            raise HTTPException(status_code=404, detail="Skill not found")

        skill_name = kind.name

        # Check if Skill is referenced by any Ghost
        ghosts = db.query(Kind).filter(
            and_(
                Kind.user_id == user_id,
                Kind.kind == "Ghost"
            )
        ).all()

        referenced_ghosts = []
        for ghost in ghosts:
            ghost_skills = ghost.json.get("spec", {}).get("skills", [])
            if skill_name in ghost_skills:
                referenced_ghosts.append(ghost.name)

        if referenced_ghosts:
            raise HTTPException(
                status_code=400,
                detail=f"Cannot delete Skill '{skill_name}'. It is referenced by Ghost(s): {', '.join(referenced_ghosts)}"
            )

        # Delete Kind record (SkillBinary will be cascaded)
        db.delete(kind)
        db.commit()

    @staticmethod
    def get_skill_by_name(
        db: Session,
        user_id: int,
        name: str,
        namespace: str = "default"
    ) -> Skill:
        """Get Skill by name"""
        kind = db.query(Kind).filter(
            and_(
                Kind.user_id == user_id,
                Kind.kind == "Skill",
                Kind.name == name,
                Kind.namespace == namespace
            )
        ).first()

        if not kind:
            raise HTTPException(
                status_code=404,
                detail=f"Skill '{name}' not found in namespace '{namespace}'"
            )

        return Skill(**kind.json)

    @staticmethod
    def validate_skill_references(
        db: Session,
        user_id: int,
        skill_names: List[str],
        namespace: str = "default"
    ):
        """
        Validate that all skill names exist for the user

        Raises:
            HTTPException: If any skill name doesn't exist
        """
        if not skill_names:
            return

        for skill_name in skill_names:
            exists = db.query(Kind).filter(
                and_(
                    Kind.user_id == user_id,
                    Kind.kind == "Skill",
                    Kind.name == skill_name,
                    Kind.namespace == namespace
                )
            ).first()

            if not exists:
                raise HTTPException(
                    status_code=400,
                    detail=f"Skill '{skill_name}' does not exist in namespace '{namespace}'"
                )
