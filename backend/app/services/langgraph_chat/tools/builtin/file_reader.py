# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""File reader skill for chunked reading of large files."""

import json
import os

from langchain_core.callbacks import CallbackManagerForToolRun
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field


class FileReaderInput(BaseModel):
    """Input schema for file reader tool."""

    file_path: str = Field(description="File path or attachment ID")
    offset: int = Field(default=0, description="Starting line number (0-indexed)")
    limit: int = Field(default=200, description="Number of lines to read")


class FileReaderSkill(BaseTool):
    """Skill for reading file contents with chunked pagination support.

    Allows agents to read large files in manageable chunks to avoid
    context window limitations.
    """

    name: str = "read_file"
    description: str = (
        "Read file content with pagination support for large files. Returns specified lines range with metadata about total lines and whether more content is available."
    )
    args_schema: type[BaseModel] = FileReaderInput

    # Instance attributes
    workspace_root: str = "/workspace"
    max_lines: int = 500

    def __init__(
        self,
        workspace_root: str = "/workspace",
        max_lines: int | None = None,
        **kwargs,
    ):
        """Initialize file reader skill.

        Args:
            workspace_root: Root directory for file access
            max_lines: Maximum lines to read in one call (overrides config)
        """
        super().__init__(**kwargs)
        self.workspace_root = workspace_root
        # Use default of 500 lines max if not specified
        self.max_lines = max_lines or 500

    def _run(
        self,
        file_path: str,
        offset: int = 0,
        limit: int = 200,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Execute file reading with pagination synchronously.

        Args:
            file_path: File path relative to workspace_root
            offset: Starting line number (0-indexed)
            limit: Number of lines to read
            run_manager: Callback manager

        Returns:
            JSON string with file content and metadata
        """
        try:
            # Sanitize and validate file path
            full_path = self._resolve_file_path(file_path)

            if not os.path.exists(full_path):
                return json.dumps({"error": f"File not found: {file_path}"})

            if not os.path.isfile(full_path):
                return json.dumps({"error": f"Path is not a file: {file_path}"})

            # Enforce limit cap
            limit = min(limit, self.max_lines)

            # Read file with pagination
            content, total_lines, has_more = self._read_file_chunk(
                full_path, offset, limit
            )

            return json.dumps(
                {
                    "content": content,
                    "file_path": file_path,
                    "offset": offset,
                    "lines_read": len(content.splitlines()),
                    "total_lines": total_lines,
                    "has_more": has_more,
                    "next_offset": offset + limit if has_more else None,
                },
                ensure_ascii=False,
            )

        except Exception as e:
            return json.dumps({"error": f"Failed to read file: {str(e)}"})

    async def _arun(
        self,
        file_path: str,
        offset: int = 0,
        limit: int = 200,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Execute file reading with pagination asynchronously.

        Args:
            file_path: File path relative to workspace_root
            offset: Starting line number (0-indexed)
            limit: Number of lines to read
            run_manager: Callback manager

        Returns:
            JSON string with file content and metadata
        """
        # File operations are synchronous, delegate to _run
        return self._run(file_path, offset, limit, run_manager)

    def _resolve_file_path(self, file_path: str) -> str:
        """Resolve and sanitize file path.

        Args:
            file_path: File path

        Returns:
            Absolute file path

        Raises:
            ValueError: If path is outside workspace root
        """
        # Remove leading slash if present
        file_path = file_path.lstrip("/")

        # Construct full path
        full_path = os.path.abspath(os.path.join(self.workspace_root, file_path))

        # Security check: ensure path is within workspace
        # Normalize both paths to absolute form and use os.path.commonpath for robust validation
        workspace_root_abs = os.path.abspath(self.workspace_root)

        try:
            # Verify full_path is inside workspace_root_abs
            common = os.path.commonpath([workspace_root_abs, full_path])
            if common != workspace_root_abs:
                raise ValueError(f"Path traversal detected: {file_path}")
        except ValueError:
            # commonpath raises ValueError if paths are on different drives (Windows)
            raise ValueError(f"Path traversal detected: {file_path}")

        return full_path

    def _read_file_chunk(
        self, file_path: str, offset: int, limit: int
    ) -> tuple[str, int, bool]:
        """Read a chunk of lines from file.

        Args:
            file_path: Absolute file path
            offset: Starting line number
            limit: Number of lines to read

        Returns:
            Tuple of (content, total_lines, has_more)
        """
        lines = []
        total_lines = 0

        with open(file_path, "r", encoding="utf-8", errors="replace") as f:
            # Collect target chunk and count total lines
            for i, line in enumerate(f):
                total_lines = (
                    i + 1
                )  # Update total_lines for each line (handles empty files)
                if i >= offset and i < offset + limit:
                    lines.append(line.rstrip("\n"))

        content = "\n".join(lines)
        has_more = offset + limit < total_lines

        return content, total_lines, has_more


class FileListInput(BaseModel):
    """Input schema for file list tool."""

    directory: str = Field(
        default=".", description="Directory path relative to workspace"
    )
    pattern: str | None = Field(
        default=None, description="Optional glob pattern to filter files"
    )


class FileListSkill(BaseTool):
    """Skill for listing files in a directory."""

    name: str = "list_files"
    description: str = (
        "List files in a directory with optional pattern filtering. Returns file names, sizes, and modification times."
    )
    args_schema: type[BaseModel] = FileListInput

    # Instance attributes
    workspace_root: str = "/workspace"

    def __init__(self, workspace_root: str = "/workspace", **kwargs):
        """Initialize file list skill.

        Args:
            workspace_root: Root directory for file access
        """
        super().__init__(**kwargs)
        self.workspace_root = workspace_root

    def _run(
        self,
        directory: str = ".",
        pattern: str | None = None,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Execute file listing synchronously.

        Args:
            directory: Directory path relative to workspace
            pattern: Optional glob pattern
            run_manager: Callback manager

        Returns:
            JSON string with file list
        """
        try:
            import glob

            # Resolve directory path
            full_dir = self._resolve_directory(directory)

            if not os.path.exists(full_dir):
                return json.dumps({"error": f"Directory not found: {directory}"})

            if not os.path.isdir(full_dir):
                return json.dumps({"error": f"Path is not a directory: {directory}"})

            # Validate glob pattern for directory traversal attempts
            if pattern and (".." in pattern or pattern.startswith("/")):
                return json.dumps(
                    {"error": "Invalid pattern: parent directory traversal not allowed"}
                )

            # List files
            if pattern:
                search_pattern = os.path.join(full_dir, pattern)
                file_paths = glob.glob(search_pattern, recursive=True)

                # Validate all matched paths are within workspace
                workspace_root_abs = os.path.abspath(self.workspace_root) + os.sep
                validated_paths = []
                for file_path in file_paths:
                    abs_path = os.path.abspath(file_path)
                    if abs_path.startswith(
                        workspace_root_abs
                    ) or abs_path == os.path.abspath(self.workspace_root):
                        validated_paths.append(file_path)
                file_paths = validated_paths
            else:
                file_paths = [os.path.join(full_dir, f) for f in os.listdir(full_dir)]

            # Collect file info
            files = []
            for file_path in sorted(file_paths):
                if os.path.isfile(file_path):
                    stat = os.stat(file_path)
                    rel_path = os.path.relpath(file_path, self.workspace_root)
                    files.append(
                        {
                            "path": rel_path,
                            "size": stat.st_size,
                            "modified": stat.st_mtime,
                        }
                    )

            return json.dumps(
                {
                    "files": files,
                    "directory": directory,
                    "pattern": pattern,
                    "file_count": len(files),
                },
                ensure_ascii=False,
            )

        except Exception as e:
            return json.dumps({"error": f"Failed to list files: {str(e)}"})

    async def _arun(
        self,
        directory: str = ".",
        pattern: str | None = None,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Execute file listing asynchronously.

        Args:
            directory: Directory path relative to workspace
            pattern: Optional glob pattern
            run_manager: Callback manager

        Returns:
            JSON string with file list
        """
        # File operations are synchronous, delegate to _run
        return self._run(directory, pattern, run_manager)

    def _resolve_directory(self, directory: str) -> str:
        """Resolve and sanitize directory path.

        Args:
            directory: Directory path

        Returns:
            Absolute directory path

        Raises:
            ValueError: If path is outside workspace root
        """
        directory = directory.lstrip("/")
        full_dir = os.path.abspath(os.path.join(self.workspace_root, directory))

        # Security check: ensure path is within workspace
        # Normalize both paths to absolute form and use os.path.commonpath for robust validation
        workspace_root_abs = os.path.abspath(self.workspace_root)

        try:
            # Verify full_dir is inside workspace_root_abs
            common = os.path.commonpath([workspace_root_abs, full_dir])
            if common != workspace_root_abs:
                raise ValueError(f"Path traversal detected: {directory}")
        except ValueError:
            # commonpath raises ValueError if paths are on different drives (Windows)
            raise ValueError(f"Path traversal detected: {directory}")

        return full_dir
