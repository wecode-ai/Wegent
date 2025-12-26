# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Skill service for managing Skills (Claude Code Skills, MCP tools, and builtin tools)
"""
import hashlib
import io
import json
import logging
import re
import zipfile
from typing import Any, Dict, List, Optional, Tuple

import yaml
from fastapi import HTTPException
from shared.utils.crypto import decrypt_sensitive_data, encrypt_sensitive_data
from sqlalchemy.orm import Session

from app.core.exceptions import ConflictException, NotFoundException
from app.db.session import SessionLocal
from app.models.kind import Kind
from app.models.skill_secret import SkillSecret
from app.schemas.kind import Ghost, Skill, SkillSpec

logger = logging.getLogger(__name__)


class SkillValidator:
    """Validator for Skill ZIP packages"""

    MAX_SIZE = 10 * 1024 * 1024  # 10MB

    @staticmethod
    def validate_zip(file_content: bytes, file_name: str) -> Dict[str, Any]:
        """
        Validate Skill ZIP package and extract metadata.

        Args:
            file_content: ZIP file binary content
            file_name: Original file name

        Returns:
            Dictionary containing:
            - description: str
            - version: Optional[str]
            - author: Optional[str]
            - tags: Optional[List[str]]
            - file_size: int
            - file_hash: str (SHA256)

        Raises:
            HTTPException: If validation fails
        """
        # Check file size
        file_size = len(file_content)
        if file_size > SkillValidator.MAX_SIZE:
            raise HTTPException(
                status_code=413,
                detail=f"File size {file_size} bytes exceeds maximum allowed size of {SkillValidator.MAX_SIZE} bytes",
            )

        # Check if it's a valid ZIP file
        if not zipfile.is_zipfile(io.BytesIO(file_content)):
            raise HTTPException(status_code=400, detail="Invalid ZIP file format")

        # Calculate SHA256 hash
        file_hash = hashlib.sha256(file_content).hexdigest()

        # Open ZIP and validate structure
        try:
            with zipfile.ZipFile(io.BytesIO(file_content), "r") as zip_file:
                # Security check: prevent Zip Slip attacks
                for file_info in zip_file.filelist:
                    if file_info.filename.startswith("/") or ".." in file_info.filename:
                        raise HTTPException(
                            status_code=400,
                            detail=f"Unsafe file path detected in ZIP: {file_info.filename}",
                        )

                # Find SKILL.md file to determine the skill folder
                skill_folder_name = None
                skill_md_content = None

                for file_info in zip_file.filelist:
                    # Skip directory entries
                    if file_info.filename.endswith("/"):
                        continue

                    # Check if this is SKILL.md
                    if file_info.filename.endswith("SKILL.md"):
                        path_parts = file_info.filename.split("/")

                        # SKILL.md must be in a subdirectory (skill-folder/SKILL.md)
                        if len(path_parts) == 2:
                            skill_folder_name = path_parts[0]
                            with zip_file.open(file_info) as f:
                                skill_md_content = f.read().decode(
                                    "utf-8", errors="ignore"
                                )
                            break  # Found the skill folder, stop searching

                # Validate that SKILL.md was found
                if not skill_md_content or not skill_folder_name:
                    raise HTTPException(
                        status_code=400,
                        detail="SKILL.md not found in skill folder. Expected structure: skill-folder/SKILL.md",
                    )

                # Validate that the folder name matches the ZIP file name
                expected_folder_name = file_name.replace(".zip", "")
                if skill_folder_name != expected_folder_name:
                    raise HTTPException(
                        status_code=400,
                        detail=f"Skill folder name '{skill_folder_name}' must match ZIP file name '{expected_folder_name}'",
                    )

                # Parse YAML frontmatter from SKILL.md
                metadata = SkillValidator._parse_skill_md(skill_md_content)

                return {
                    "description": metadata.get("description", ""),
                    "version": metadata.get("version"),
                    "author": metadata.get("author"),
                    "tags": metadata.get("tags"),
                    "file_size": file_size,
                    "file_hash": file_hash,
                }

        except zipfile.BadZipFile:
            raise HTTPException(status_code=400, detail="Corrupted ZIP file")
        except Exception as e:
            if isinstance(e, HTTPException):
                raise
            raise HTTPException(
                status_code=400, detail=f"Failed to process ZIP file: {str(e)}"
            )

    @staticmethod
    def _parse_skill_md(content: str) -> Dict[str, Any]:
        """
        Parse YAML frontmatter from SKILL.md content.

        Expected format:
        ---
        description: "Skill description"
        version: "1.0.0"
        author: "Author name"
        tags: ["tag1", "tag2"]
        ---

        Args:
            content: SKILL.md file content

        Returns:
            Dictionary with parsed metadata
        """
        # Extract YAML frontmatter between --- markers
        frontmatter_pattern = re.compile(
            r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL | re.MULTILINE
        )
        match = frontmatter_pattern.search(content)

        if not match:
            raise HTTPException(
                status_code=400,
                detail="SKILL.md must contain YAML frontmatter between --- markers",
            )

        yaml_content = match.group(1)

        try:
            metadata = yaml.safe_load(yaml_content)
            if not isinstance(metadata, dict):
                raise ValueError("YAML frontmatter must be a dictionary")

            # Validate required field
            if "description" not in metadata:
                raise HTTPException(
                    status_code=400,
                    detail="SKILL.md frontmatter must include 'description' field",
                )

            return metadata

        except yaml.YAMLError as e:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid YAML frontmatter in SKILL.md: {str(e)}",
            )
        except Exception as e:
            if isinstance(e, HTTPException):
                raise
            raise HTTPException(
                status_code=400,
                detail=f"Failed to parse SKILL.md frontmatter: {str(e)}",
            )


class SkillService:
    """Service for managing Skills (MCP, builtin, skill types) and Ghost-Skill associations"""

    # Skill type constants
    SKILL_TYPE_SKILL = "skill"  # Claude Code ZIP skills
    SKILL_TYPE_MCP = "mcp"  # MCP server tools
    SKILL_TYPE_BUILTIN = "builtin"  # Builtin tools

    # Skill status in Ghost
    STATUS_AVAILABLE = "available"
    STATUS_PENDING_CONFIG = "pending_config"
    STATUS_DISABLED = "disabled"

    # Visibility levels
    VISIBILITY_PERSONAL = "personal"
    VISIBILITY_TEAM = "team"
    VISIBILITY_PUBLIC = "public"

    def __init__(self, db: Session):
        self.db = db

    # ==================== Market Operations ====================

    def list_market_skills(
        self,
        skill_type: Optional[str] = None,
        category: Optional[str] = None,
        visibility: str = "public",
        search: Optional[str] = None,
        page: int = 1,
        page_size: int = 20,
    ) -> Tuple[List[Dict[str, Any]], int]:
        """
        List skills available in the market.

        Args:
            skill_type: Filter by skill type (skill|mcp|builtin)
            category: Filter by category
            visibility: Filter by visibility (default: public)
            search: Search term for name/description
            page: Page number
            page_size: Items per page

        Returns:
            Tuple of (skills list, total count)
        """
        query = self.db.query(Kind).filter(Kind.kind == "Skill")

        # Apply filters
        if skill_type:
            query = query.filter(
                Kind.spec.like(f'%"skillType": "{skill_type}"%')
                | Kind.spec.like(f"%'skillType': '{skill_type}'%")
            )

        if category:
            query = query.filter(
                Kind.spec.like(f'%"category": "{category}"%')
                | Kind.spec.like(f"%'category': '{category}'%")
            )

        if visibility:
            query = query.filter(
                Kind.spec.like(f'%"visibility": "{visibility}"%')
                | Kind.spec.like(f"%'visibility': '{visibility}'%")
            )

        if search:
            query = query.filter(
                Kind.name.ilike(f"%{search}%")
                | Kind.spec.like(f'%"description": "%{search}%"%')
            )

        # Get total count
        total = query.count()

        # Apply pagination
        offset = (page - 1) * page_size
        skills = query.offset(offset).limit(page_size).all()

        # Convert to response format
        result = []
        for skill in skills:
            spec = json.loads(skill.spec) if isinstance(skill.spec, str) else skill.spec
            result.append(
                {
                    "id": skill.id,
                    "name": skill.name,
                    "description": spec.get("description", ""),
                    "version": spec.get("version"),
                    "author": spec.get("author"),
                    "tags": spec.get("tags", []),
                    "skillType": spec.get("skillType", self.SKILL_TYPE_SKILL),
                    "visibility": spec.get("visibility", self.VISIBILITY_PERSONAL),
                    "category": spec.get("category"),
                    "mcpConfig": spec.get("mcpConfig"),
                    "builtinConfig": spec.get("builtinConfig"),
                    "createdAt": skill.created_at.isoformat() if skill.created_at else None,
                    "updatedAt": skill.updated_at.isoformat() if skill.updated_at else None,
                }
            )

        return result, total

    def get_skill_by_name(self, name: str) -> Optional[Dict[str, Any]]:
        """
        Get a skill by name.

        Args:
            name: Skill name

        Returns:
            Skill data or None if not found
        """
        skill = (
            self.db.query(Kind)
            .filter(Kind.kind == "Skill", Kind.name == name)
            .first()
        )

        if not skill:
            return None

        spec = json.loads(skill.spec) if isinstance(skill.spec, str) else skill.spec
        return {
            "id": skill.id,
            "name": skill.name,
            "description": spec.get("description", ""),
            "version": spec.get("version"),
            "author": spec.get("author"),
            "tags": spec.get("tags", []),
            "skillType": spec.get("skillType", self.SKILL_TYPE_SKILL),
            "visibility": spec.get("visibility", self.VISIBILITY_PERSONAL),
            "category": spec.get("category"),
            "mcpConfig": spec.get("mcpConfig"),
            "builtinConfig": spec.get("builtinConfig"),
            "createdAt": skill.created_at.isoformat() if skill.created_at else None,
            "updatedAt": skill.updated_at.isoformat() if skill.updated_at else None,
        }

    def get_skill_by_id(self, skill_id: int) -> Optional[Dict[str, Any]]:
        """
        Get a skill by ID.

        Args:
            skill_id: Skill ID

        Returns:
            Skill data or None if not found
        """
        skill = (
            self.db.query(Kind)
            .filter(Kind.kind == "Skill", Kind.id == skill_id)
            .first()
        )

        if not skill:
            return None

        spec = json.loads(skill.spec) if isinstance(skill.spec, str) else skill.spec
        return {
            "id": skill.id,
            "name": skill.name,
            "description": spec.get("description", ""),
            "version": spec.get("version"),
            "author": spec.get("author"),
            "tags": spec.get("tags", []),
            "skillType": spec.get("skillType", self.SKILL_TYPE_SKILL),
            "visibility": spec.get("visibility", self.VISIBILITY_PERSONAL),
            "category": spec.get("category"),
            "mcpConfig": spec.get("mcpConfig"),
            "builtinConfig": spec.get("builtinConfig"),
            "createdAt": skill.created_at.isoformat() if skill.created_at else None,
            "updatedAt": skill.updated_at.isoformat() if skill.updated_at else None,
        }

    def get_categories(self) -> List[str]:
        """
        Get all unique skill categories.

        Returns:
            List of category names
        """
        skills = self.db.query(Kind).filter(Kind.kind == "Skill").all()

        categories = set()
        for skill in skills:
            spec = json.loads(skill.spec) if isinstance(skill.spec, str) else skill.spec
            category = spec.get("category")
            if category:
                categories.add(category)

        return sorted(list(categories))

    # ==================== Ghost-Skill Operations ====================

    def add_skill_to_ghost(
        self,
        ghost_id: int,
        skill_name: str,
        status: str = STATUS_PENDING_CONFIG,
    ) -> Dict[str, Any]:
        """
        Add a skill to a Ghost's skillRefs.

        Args:
            ghost_id: Ghost ID
            skill_name: Skill name to add
            status: Initial status (default: pending_config)

        Returns:
            Updated Ghost data

        Raises:
            NotFoundException: If Ghost or Skill not found
            ConflictException: If skill already added to Ghost
        """
        # Get Ghost
        ghost = (
            self.db.query(Kind)
            .filter(Kind.kind == "Ghost", Kind.id == ghost_id)
            .first()
        )
        if not ghost:
            raise NotFoundException(f"Ghost with id {ghost_id} not found")

        # Verify skill exists
        skill = self.get_skill_by_name(skill_name)
        if not skill:
            raise NotFoundException(f"Skill '{skill_name}' not found")

        # Parse Ghost spec
        spec = json.loads(ghost.spec) if isinstance(ghost.spec, str) else ghost.spec

        # Initialize skillRefs if not exists
        if "skillRefs" not in spec or spec["skillRefs"] is None:
            spec["skillRefs"] = []

        # Check if skill already added
        for ref in spec["skillRefs"]:
            if ref.get("skillRef") == skill_name:
                raise ConflictException(f"Skill '{skill_name}' already added to Ghost")

        # Determine initial status based on skill type
        skill_spec = skill
        if skill_spec.get("skillType") == self.SKILL_TYPE_MCP:
            mcp_config = skill_spec.get("mcpConfig", {})
            env_schema = mcp_config.get("envSchema", [])
            # Check if any required env vars need configuration
            has_required_env = any(
                item.get("required", False) for item in env_schema
            )
            if has_required_env:
                status = self.STATUS_PENDING_CONFIG
            else:
                status = self.STATUS_AVAILABLE
        elif skill_spec.get("skillType") == self.SKILL_TYPE_BUILTIN:
            status = self.STATUS_AVAILABLE

        # Add skill reference
        spec["skillRefs"].append({"skillRef": skill_name, "status": status})

        # Update Ghost
        ghost.spec = json.dumps(spec)
        self.db.commit()
        self.db.refresh(ghost)

        return {
            "id": ghost.id,
            "name": ghost.name,
            "skillRefs": spec["skillRefs"],
        }

    def remove_skill_from_ghost(self, ghost_id: int, skill_name: str) -> Dict[str, Any]:
        """
        Remove a skill from a Ghost's skillRefs.

        Args:
            ghost_id: Ghost ID
            skill_name: Skill name to remove

        Returns:
            Updated Ghost data

        Raises:
            NotFoundException: If Ghost not found or skill not in Ghost
        """
        # Get Ghost
        ghost = (
            self.db.query(Kind)
            .filter(Kind.kind == "Ghost", Kind.id == ghost_id)
            .first()
        )
        if not ghost:
            raise NotFoundException(f"Ghost with id {ghost_id} not found")

        # Parse Ghost spec
        spec = json.loads(ghost.spec) if isinstance(ghost.spec, str) else ghost.spec

        # Check if skillRefs exists
        if "skillRefs" not in spec or not spec["skillRefs"]:
            raise NotFoundException(f"Skill '{skill_name}' not found in Ghost")

        # Find and remove skill
        original_length = len(spec["skillRefs"])
        spec["skillRefs"] = [
            ref for ref in spec["skillRefs"] if ref.get("skillRef") != skill_name
        ]

        if len(spec["skillRefs"]) == original_length:
            raise NotFoundException(f"Skill '{skill_name}' not found in Ghost")

        # Also remove any associated secrets
        skill = self.get_skill_by_name(skill_name)
        if skill:
            self.db.query(SkillSecret).filter(
                SkillSecret.ghost_id == ghost_id,
                SkillSecret.skill_id == skill["id"],
            ).delete()

        # Update Ghost
        ghost.spec = json.dumps(spec)
        self.db.commit()
        self.db.refresh(ghost)

        return {
            "id": ghost.id,
            "name": ghost.name,
            "skillRefs": spec["skillRefs"],
        }

    def update_skill_status_in_ghost(
        self,
        ghost_id: int,
        skill_name: str,
        status: str,
    ) -> Dict[str, Any]:
        """
        Update a skill's status in a Ghost.

        Args:
            ghost_id: Ghost ID
            skill_name: Skill name
            status: New status (available|pending_config|disabled)

        Returns:
            Updated Ghost data

        Raises:
            NotFoundException: If Ghost not found or skill not in Ghost
        """
        # Validate status
        valid_statuses = [
            self.STATUS_AVAILABLE,
            self.STATUS_PENDING_CONFIG,
            self.STATUS_DISABLED,
        ]
        if status not in valid_statuses:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid status. Must be one of: {', '.join(valid_statuses)}",
            )

        # Get Ghost
        ghost = (
            self.db.query(Kind)
            .filter(Kind.kind == "Ghost", Kind.id == ghost_id)
            .first()
        )
        if not ghost:
            raise NotFoundException(f"Ghost with id {ghost_id} not found")

        # Parse Ghost spec
        spec = json.loads(ghost.spec) if isinstance(ghost.spec, str) else ghost.spec

        # Find and update skill status
        if "skillRefs" not in spec or not spec["skillRefs"]:
            raise NotFoundException(f"Skill '{skill_name}' not found in Ghost")

        found = False
        for ref in spec["skillRefs"]:
            if ref.get("skillRef") == skill_name:
                ref["status"] = status
                found = True
                break

        if not found:
            raise NotFoundException(f"Skill '{skill_name}' not found in Ghost")

        # Update Ghost
        ghost.spec = json.dumps(spec)
        self.db.commit()
        self.db.refresh(ghost)

        return {
            "id": ghost.id,
            "name": ghost.name,
            "skillRefs": spec["skillRefs"],
        }

    def list_skills_in_ghost(self, ghost_id: int) -> List[Dict[str, Any]]:
        """
        List all skills in a Ghost with their details.

        Args:
            ghost_id: Ghost ID

        Returns:
            List of skills with status and configuration info
        """
        # Get Ghost
        ghost = (
            self.db.query(Kind)
            .filter(Kind.kind == "Ghost", Kind.id == ghost_id)
            .first()
        )
        if not ghost:
            raise NotFoundException(f"Ghost with id {ghost_id} not found")

        # Parse Ghost spec
        spec = json.loads(ghost.spec) if isinstance(ghost.spec, str) else ghost.spec

        skill_refs = spec.get("skillRefs", [])
        if not skill_refs:
            return []

        result = []
        for ref in skill_refs:
            skill_name = ref.get("skillRef")
            skill_data = self.get_skill_by_name(skill_name)

            if skill_data:
                # Check if has secret configured
                has_secret = (
                    self.db.query(SkillSecret)
                    .filter(
                        SkillSecret.ghost_id == ghost_id,
                        SkillSecret.skill_id == skill_data["id"],
                    )
                    .first()
                    is not None
                )

                result.append(
                    {
                        **skill_data,
                        "status": ref.get("status", self.STATUS_PENDING_CONFIG),
                        "hassecret": has_secret,
                    }
                )

        return result

    # ==================== secret Operations ====================

    def set_skill_secrets(
        self,
        ghost_id: int,
        skill_name: str,
        env_values: Dict[str, str],
    ) -> Dict[str, Any]:
        """
        Set sensitive environment variables for a skill in a Ghost.

        Args:
            ghost_id: Ghost ID
            skill_name: Skill name
            env_values: Dictionary of env var name -> value

        Returns:
            Success response

        Raises:
            NotFoundException: If Ghost or Skill not found
        """
        # Get Ghost
        ghost = (
            self.db.query(Kind)
            .filter(Kind.kind == "Ghost", Kind.id == ghost_id)
            .first()
        )
        if not ghost:
            raise NotFoundException(f"Ghost with id {ghost_id} not found")

        # Get Skill
        skill = self.get_skill_by_name(skill_name)
        if not skill:
            raise NotFoundException(f"Skill '{skill_name}' not found")

        # Verify skill is in Ghost
        spec = json.loads(ghost.spec) if isinstance(ghost.spec, str) else ghost.spec
        skill_refs = spec.get("skillRefs", [])
        skill_in_ghost = any(
            ref.get("skillRef") == skill_name for ref in skill_refs
        )
        if not skill_in_ghost:
            raise NotFoundException(f"Skill '{skill_name}' not found in Ghost")

        # Encrypt the env values
        encrypted_env = encrypt_sensitive_data(json.dumps(env_values))

        # Upsert secret record
        existing = (
            self.db.query(SkillSecret)
            .filter(
                SkillSecret.ghost_id == ghost_id,
                SkillSecret.skill_id == skill["id"],
            )
            .first()
        )

        if existing:
            existing.encrypted_env = encrypted_env
        else:
            secret = SkillSecret(
                ghost_id=ghost_id,
                skill_id=skill["id"],
                encrypted_env=encrypted_env,
            )
            self.db.add(secret)

        # Update skill status to available if all required env vars are set
        mcp_config = skill.get("mcpConfig", {})
        env_schema = mcp_config.get("envSchema", []) if mcp_config else []
        required_vars = [
            item.get("name")
            for item in env_schema
            if item.get("required", False)
        ]

        all_required_set = all(
            var in env_values and env_values[var] for var in required_vars
        )
        if all_required_set:
            self.update_skill_status_in_ghost(
                ghost_id, skill_name, self.STATUS_AVAILABLE
            )

        self.db.commit()

        return {"success": True, "message": "secrets saved successfully"}

    def get_skill_secrets(
        self,
        ghost_id: int,
        skill_name: str,
        masked: bool = True,
    ) -> Dict[str, Any]:
        """
        Get sensitive environment variables for a skill in a Ghost.

        Args:
            ghost_id: Ghost ID
            skill_name: Skill name
            masked: Whether to mask sensitive values (default: True)

        Returns:
            Dictionary of env var configurations with values

        Raises:
            NotFoundException: If Ghost or Skill not found
        """
        # Get Skill
        skill = self.get_skill_by_name(skill_name)
        if not skill:
            raise NotFoundException(f"Skill '{skill_name}' not found")

        # Get secret record
        secret = (
            self.db.query(SkillSecret)
            .filter(
                SkillSecret.ghost_id == ghost_id,
                SkillSecret.skill_id == skill["id"],
            )
            .first()
        )

        # Get env schema from skill
        mcp_config = skill.get("mcpConfig", {})
        env_schema = mcp_config.get("envSchema", []) if mcp_config else []

        # Build response with schema and values
        result = {"envSchema": env_schema, "values": {}}

        if secret:
            # Decrypt the env values
            decrypted = json.loads(decrypt_sensitive_data(secret.encrypted_env))

            if masked:
                # Mask sensitive values
                for key, value in decrypted.items():
                    if value:
                        # Find if this is a secret field
                        is_secret = any(
                            item.get("name") == key and item.get("secret", False)
                            for item in env_schema
                        )
                        if is_secret:
                            # Show first 4 and last 4 chars
                            if len(value) > 8:
                                result["values"][key] = f"{value[:4]}****{value[-4:]}"
                            else:
                                result["values"][key] = "****"
                        else:
                            result["values"][key] = value
                    else:
                        result["values"][key] = ""
            else:
                result["values"] = decrypted

        return result

    def delete_skill_secrets(self, ghost_id: int, skill_name: str) -> Dict[str, Any]:
        """
        Delete secrets for a skill in a Ghost.

        Args:
            ghost_id: Ghost ID
            skill_name: Skill name

        Returns:
            Success response
        """
        # Get Skill
        skill = self.get_skill_by_name(skill_name)
        if not skill:
            raise NotFoundException(f"Skill '{skill_name}' not found")

        # Delete secret record
        deleted = (
            self.db.query(SkillSecret)
            .filter(
                SkillSecret.ghost_id == ghost_id,
                SkillSecret.skill_id == skill["id"],
            )
            .delete()
        )

        if deleted:
            # Update skill status to pending_config
            self.update_skill_status_in_ghost(
                ghost_id, skill_name, self.STATUS_PENDING_CONFIG
            )
            self.db.commit()

        return {"success": True, "deleted": deleted > 0}

    # ==================== Executor Support ====================

    def get_mcp_config_for_executor(
        self,
        ghost_id: int,
    ) -> Dict[str, Any]:
        """
        Get MCP configuration for executor with decrypted env vars.

        Args:
            ghost_id: Ghost ID

        Returns:
            Dictionary of MCP server configurations ready for executor
        """
        skills = self.list_skills_in_ghost(ghost_id)

        mcp_servers = {}
        for skill in skills:
            # Only include available MCP skills
            if (
                skill.get("skillType") != self.SKILL_TYPE_MCP
                or skill.get("status") != self.STATUS_AVAILABLE
            ):
                continue

            mcp_config = skill.get("mcpConfig", {})
            if not mcp_config:
                continue

            # Get decrypted env values
            secrets = self.get_skill_secrets(
                ghost_id, skill["name"], masked=False
            )
            env_values = secrets.get("values", {})

            # Build MCP server config
            server_config = {
                "type": mcp_config.get("serverType", "stdio"),
            }

            if mcp_config.get("args"):
                server_config["args"] = mcp_config["args"]

            if mcp_config.get("url"):
                server_config["url"] = mcp_config["url"]

            # Add environment variables
            if env_values:
                server_config["env"] = env_values

            mcp_servers[skill["name"]] = server_config

        return {"mcpServers": mcp_servers}

    def get_skills_for_executor(self, ghost_id: int) -> List[str]:
        """
        Get list of Claude Code skill names for executor.

        Args:
            ghost_id: Ghost ID

        Returns:
            List of skill names (only skill type, available status)
        """
        skills = self.list_skills_in_ghost(ghost_id)

        return [
            skill["name"]
            for skill in skills
            if skill.get("skillType") == self.SKILL_TYPE_SKILL
            and skill.get("status") == self.STATUS_AVAILABLE
        ]

    def get_builtin_tools_for_executor(self, ghost_id: int) -> List[str]:
        """
        Get list of builtin tool IDs for executor.

        Args:
            ghost_id: Ghost ID

        Returns:
            List of builtin tool IDs
        """
        skills = self.list_skills_in_ghost(ghost_id)

        result = []
        for skill in skills:
            if (
                skill.get("skillType") != self.SKILL_TYPE_BUILTIN
                or skill.get("status") != self.STATUS_AVAILABLE
            ):
                continue

            builtin_config = skill.get("builtinConfig", {})
            tool_id = builtin_config.get("toolId")
            if tool_id:
                result.append(tool_id)

        return result
