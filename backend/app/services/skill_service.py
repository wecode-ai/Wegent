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
from typing import Any, Dict, Optional

import yaml
from fastapi import HTTPException


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

                # Extract SKILL.md body as prompt content
                prompt_content = SkillValidator._extract_skill_body(skill_md_content)

                # Default bindShells to ["ClaudeCode"] if not specified
                bind_shells = metadata.get("bindShells")
                if bind_shells is None:
                    bind_shells = ["ClaudeCode"]

                # Default preload to False if not specified
                preload = metadata.get("preload", False)
                # Ensure preload is a boolean
                if not isinstance(preload, bool):
                    preload = False

                return {
                    "description": metadata.get("description", ""),
                    "displayName": metadata.get("displayName"),
                    "prompt": prompt_content,
                    "version": metadata.get("version"),
                    "author": metadata.get("author"),
                    "tags": metadata.get("tags"),
                    "bindShells": bind_shells,  # Shell types this skill is compatible with
                    "tools": metadata.get(
                        "tools"
                    ),  # Tool declarations for skill-tool binding
                    "provider": metadata.get(
                        "provider"
                    ),  # Provider config for dynamic loading
                    "preload": preload,  # Whether to preload into system prompt
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

    @staticmethod
    def _extract_skill_body(content: str) -> str:
        """
        Extract the body content from SKILL.md (after YAML frontmatter).

        Args:
            content: Full SKILL.md file content

        Returns:
            The markdown body content after the frontmatter, or empty string if none
        """
        # Remove YAML frontmatter, keep the body
        frontmatter_pattern = re.compile(
            r"^---\s*\n.*?\n---\s*\n", re.DOTALL | re.MULTILINE
        )
        body = frontmatter_pattern.sub("", content).strip()
        return body
