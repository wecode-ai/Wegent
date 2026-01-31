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
from typing import Any, Dict, List, Optional, Set, Tuple

import yaml
from fastapi import HTTPException


class SkillDependencyValidator:
    """Validator for skill dependencies.

    Provides methods to:
    - Validate that all dependencies exist in the system
    - Detect circular dependencies using graph traversal
    """

    @staticmethod
    def validate_dependencies(
        skill_name: str,
        dependencies: List[str],
        find_skill_func,
        db,
        user_id: int,
        namespace: str = "default",
    ) -> Tuple[List[str], Optional[List[str]]]:
        """
        Validate skill dependencies.

        Args:
            skill_name: Name of the skill being validated
            dependencies: List of dependency skill names
            find_skill_func: Function to find a skill by name
            db: Database session
            user_id: User ID for skill lookup
            namespace: Namespace for group skill lookup

        Returns:
            Tuple of (missing_dependencies, circular_dependency_chain)
            - missing_dependencies: List of dependencies that don't exist
            - circular_dependency_chain: List showing the circular path, or None

        Note:
            If circular_dependency_chain is not None, it shows the cycle path
            e.g., ["skill-a", "skill-b", "skill-c", "skill-a"]
        """
        missing = []

        # Check existence of each dependency
        for dep_name in dependencies:
            skill = find_skill_func(dep_name, db, user_id, namespace)
            if not skill:
                missing.append(dep_name)

        if missing:
            return missing, None

        # Check for circular dependencies using DFS
        circular_chain = SkillDependencyValidator._detect_circular_dependencies(
            skill_name, dependencies, find_skill_func, db, user_id, namespace
        )

        return [], circular_chain

    @staticmethod
    def _detect_circular_dependencies(
        skill_name: str,
        dependencies: List[str],
        find_skill_func,
        db,
        user_id: int,
        namespace: str,
    ) -> Optional[List[str]]:
        """
        Detect circular dependencies using DFS.

        Args:
            skill_name: Name of the skill being checked
            dependencies: Direct dependencies of the skill
            find_skill_func: Function to find a skill by name
            db: Database session
            user_id: User ID
            namespace: Namespace

        Returns:
            List showing the circular path if found, None otherwise
        """
        # Build a dependency graph starting from this skill
        # We'll treat the new skill's dependencies as if it's already in the graph

        def get_skill_dependencies(name: str) -> List[str]:
            """Get dependencies for an existing skill."""
            if name == skill_name:
                return dependencies

            skill = find_skill_func(name, db, user_id, namespace)
            if not skill or not skill.json:
                return []

            # Get dependencies directly from JSON to avoid full model validation
            spec = skill.json.get("spec", {})
            return spec.get("dependencies") or []

        # DFS to detect cycle
        visited: Set[str] = set()
        rec_stack: Set[str] = set()  # Recursion stack for cycle detection
        path: List[str] = []  # Track path for reporting

        def dfs(node: str) -> Optional[List[str]]:
            """DFS traversal to detect cycles."""
            visited.add(node)
            rec_stack.add(node)
            path.append(node)

            for dep in get_skill_dependencies(node):
                if dep not in visited:
                    result = dfs(dep)
                    if result:
                        return result
                elif dep in rec_stack:
                    # Found a cycle - build the cycle path
                    cycle_start = path.index(dep)
                    cycle_path = path[cycle_start:] + [dep]
                    return cycle_path

            path.pop()
            rec_stack.remove(node)
            return None

        return dfs(skill_name)


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
            - displayName: Optional[str]
            - prompt: Optional[str]
            - version: Optional[str]
            - author: Optional[str]
            - tags: Optional[List[str]]
            - bindShells: List[str]
            - config: Optional[Dict[str, Any]]
            - tools: Optional[List[Dict[str, Any]]]
            - provider: Optional[Dict[str, Any]]
            - preload: bool
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
                    "config": metadata.get("config"),  # Skill-level configuration
                    "tools": metadata.get(
                        "tools"
                    ),  # Tool declarations for skill-tool binding
                    "provider": metadata.get(
                        "provider"
                    ),  # Provider config for dynamic loading
                    "mcpServers": metadata.get(
                        "mcpServers"
                    ),  # MCP servers for skill-level tools
                    "dependencies": metadata.get(
                        "dependencies"
                    ),  # Skill dependencies for auto-loading
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
