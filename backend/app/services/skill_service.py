# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Skill service for managing Claude Code Skills
"""

import hashlib
import io
import re
import stat
import zipfile
from pathlib import PurePosixPath
from typing import Any, Dict, Optional

import yaml
from fastapi import HTTPException


class SkillValidator:
    """Validator for Skill ZIP packages"""

    MAX_SIZE = 10 * 1024 * 1024  # 10MB
    MAX_UNCOMPRESSED_SIZE = 100 * 1024 * 1024
    MAX_ARCHIVE_ENTRIES = 1024
    MAX_SKILL_MD_SIZE = 1024 * 1024
    MAX_FRONTMATTER_SIZE = 256 * 1024
    COPY_CHUNK_SIZE = 1024 * 1024

    @staticmethod
    def _validate_archive_metadata(zip_file: zipfile.ZipFile) -> None:
        """Reject archive shapes that could escape paths or exhaust memory."""
        file_list = zip_file.infolist()
        if len(file_list) > SkillValidator.MAX_ARCHIVE_ENTRIES:
            raise HTTPException(status_code=400, detail="ZIP contains too many entries")

        total_uncompressed_size = 0
        seen_paths: set[str] = set()
        for file_info in file_list:
            normalized_path = file_info.filename.replace("\\", "/")
            path = PurePosixPath(normalized_path)
            if (
                file_info.filename.startswith(("/", "\\"))
                or "\\" in file_info.filename
                or any(part == ".." for part in path.parts)
                or (path.parts and path.parts[0].endswith(":"))
            ):
                raise HTTPException(
                    status_code=400,
                    detail=f"Unsafe file path detected in ZIP: {file_info.filename}",
                )
            if normalized_path in seen_paths:
                raise HTTPException(
                    status_code=400,
                    detail=f"Duplicate file path detected in ZIP: {file_info.filename}",
                )
            seen_paths.add(normalized_path)
            if file_info.flag_bits & 0x1:
                raise HTTPException(
                    status_code=400,
                    detail="Encrypted ZIP entries are not supported",
                )
            file_type = (file_info.external_attr >> 16) & 0o170000
            if file_type == stat.S_IFLNK:
                raise HTTPException(
                    status_code=400,
                    detail="Symbolic links are not allowed in Skill packages",
                )
            total_uncompressed_size += file_info.file_size
            if total_uncompressed_size > SkillValidator.MAX_UNCOMPRESSED_SIZE:
                raise HTTPException(
                    status_code=413,
                    detail="Uncompressed Skill package is too large",
                )

    @staticmethod
    def _read_entry_limited(
        zip_file: zipfile.ZipFile,
        file_info: zipfile.ZipInfo,
        limit: int,
    ) -> bytes:
        if file_info.file_size > limit:
            raise HTTPException(status_code=413, detail="SKILL.md is too large")
        with zip_file.open(file_info) as source:
            content = source.read(limit + 1)
            if len(content) > limit or source.read(1):
                raise HTTPException(status_code=413, detail="SKILL.md is too large")
            return content

    @staticmethod
    def _find_skill_markdown(
        zip_file: zipfile.ZipFile,
    ) -> tuple[str, str] | None:
        for file_info in zip_file.infolist():
            if file_info.is_dir():
                continue
            path_parts = file_info.filename.split("/")
            if len(path_parts) != 2 or path_parts[1] != "SKILL.md":
                continue
            content = SkillValidator._read_entry_limited(
                zip_file,
                file_info,
                SkillValidator.MAX_SKILL_MD_SIZE,
            ).decode("utf-8", errors="ignore")
            return path_parts[0], content
        return None

    @staticmethod
    def extract_skill_markdown(file_content: bytes) -> str:
        """Extract a bounded SKILL.md from a validated archive."""
        if len(file_content) > SkillValidator.MAX_SIZE:
            raise HTTPException(status_code=413, detail="Skill package is too large")
        try:
            with zipfile.ZipFile(io.BytesIO(file_content), "r") as zip_file:
                SkillValidator._validate_archive_metadata(zip_file)
                skill_markdown = SkillValidator._find_skill_markdown(zip_file)
        except zipfile.BadZipFile as exc:
            raise HTTPException(status_code=400, detail="Corrupted ZIP file") from exc
        if skill_markdown is None:
            raise HTTPException(
                status_code=404,
                detail="SKILL.md not found in skill package",
            )
        return skill_markdown[1]

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
                SkillValidator._validate_archive_metadata(zip_file)
                skill_markdown = SkillValidator._find_skill_markdown(zip_file)
                skill_folder_name, skill_md_content = (
                    skill_markdown if skill_markdown is not None else (None, None)
                )

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
                    "runtime": metadata.get(
                        "runtime"
                    ),  # Optional Chat runtime policies
                    "mcpServers": metadata.get(
                        "mcpServers"
                    ),  # MCP servers for skill-level tools
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
        if len(yaml_content.encode("utf-8")) > SkillValidator.MAX_FRONTMATTER_SIZE:
            raise HTTPException(
                status_code=413,
                detail="SKILL.md frontmatter is too large",
            )

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

    @staticmethod
    def sanitize_zip(file_content: bytes) -> bytes:
        """Rebuild ZIP with mcpServers stripped from SKILL.md frontmatter.

        Returns original bytes unchanged if ZIP has no SKILL.md or no mcpServers.
        """
        if len(file_content) > SkillValidator.MAX_SIZE:
            raise HTTPException(status_code=413, detail="Skill package is too large")

        frontmatter_pattern = re.compile(
            r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL | re.MULTILINE
        )

        try:
            archive = zipfile.ZipFile(io.BytesIO(file_content), "r")
        except zipfile.BadZipFile as exc:
            raise HTTPException(status_code=400, detail="Corrupted ZIP file") from exc

        with archive as zin:
            SkillValidator._validate_archive_metadata(zin)
            skill_markdown = SkillValidator._find_skill_markdown(zin)
            if skill_markdown is None:
                return file_content
            skill_folder, skill_md_content = skill_markdown
            skill_md_path = f"{skill_folder}/SKILL.md"
            metadata = SkillValidator._parse_skill_md(skill_md_content)
            if "mcpServers" not in metadata:
                return file_content

            # Strip mcpServers and rebuild SKILL.md
            metadata.pop("mcpServers")
            new_yaml = yaml.safe_dump(
                metadata,
                allow_unicode=True,
                sort_keys=False,
                default_flow_style=False,
            ).rstrip("\n")
            body = frontmatter_pattern.sub("", skill_md_content).strip()
            new_skill_md = f"---\n{new_yaml}\n---\n\n{body}\n"

            # Rebuild ZIP replacing SKILL.md entry
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zout:
                copied_bytes = 0
                for info in zin.infolist():
                    if info.is_dir():
                        continue
                    if info.filename == skill_md_path:
                        zout.writestr(info, new_skill_md)
                        copied_bytes += len(new_skill_md.encode("utf-8"))
                        continue
                    with (
                        zin.open(info) as source,
                        zout.open(
                            info,
                            "w",
                            force_zip64=True,
                        ) as target,
                    ):
                        while True:
                            chunk = source.read(SkillValidator.COPY_CHUNK_SIZE)
                            if not chunk:
                                break
                            copied_bytes += len(chunk)
                            if copied_bytes > SkillValidator.MAX_UNCOMPRESSED_SIZE:
                                raise HTTPException(
                                    status_code=413,
                                    detail="Uncompressed Skill package is too large",
                                )
                            target.write(chunk)

            sanitized = buf.getvalue()
            if len(sanitized) > SkillValidator.MAX_SIZE:
                raise HTTPException(
                    status_code=413,
                    detail="Sanitized Skill package is too large",
                )
            return sanitized
