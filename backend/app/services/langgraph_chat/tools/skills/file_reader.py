"""File reader skill for chunked reading of large files."""

import os
from typing import Optional

from pydantic import Field

from ...config import config
from ..base import BaseTool, ToolInput, ToolResult


class FileReaderInput(ToolInput):
    """Input schema for file reader tool."""

    file_path: str = Field(description="File path or attachment ID")
    offset: int = Field(default=0, description="Starting line number (0-indexed)")
    limit: int = Field(default=200, description="Number of lines to read")


class FileReaderSkill(BaseTool):
    """Skill for reading file contents with chunked pagination support.

    Allows agents to read large files in manageable chunks to avoid
    context window limitations.
    """

    name = "read_file"
    description = "Read file content with pagination support for large files. Returns specified lines range with metadata about total lines and whether more content is available."
    input_schema = FileReaderInput

    def __init__(
        self,
        workspace_root: str = "/workspace",
        max_lines: Optional[int] = None,
        timeout: int = 30,
    ):
        """Initialize file reader skill.

        Args:
            workspace_root: Root directory for file access
            max_lines: Maximum lines to read in one call (overrides config)
            timeout: Execution timeout
        """
        super().__init__(timeout)
        self.workspace_root = workspace_root
        self.max_lines = max_lines or config.FILE_READER_MAX_LINES

    async def execute(
        self, file_path: str, offset: int = 0, limit: int = 200
    ) -> ToolResult:
        """Execute file reading with pagination.

        Args:
            file_path: File path relative to workspace_root
            offset: Starting line number (0-indexed)
            limit: Number of lines to read

        Returns:
            ToolResult with file content and metadata
        """
        try:
            # Sanitize and validate file path
            full_path = self._resolve_file_path(file_path)

            if not os.path.exists(full_path):
                return ToolResult(
                    success=False, output=None, error=f"File not found: {file_path}"
                )

            if not os.path.isfile(full_path):
                return ToolResult(
                    success=False, output=None, error=f"Path is not a file: {file_path}"
                )

            # Enforce limit cap
            limit = min(limit, self.max_lines)

            # Read file with pagination
            content, total_lines, has_more = self._read_file_chunk(
                full_path, offset, limit
            )

            return ToolResult(
                success=True,
                output=content,
                metadata={
                    "file_path": file_path,
                    "offset": offset,
                    "lines_read": len(content.splitlines()),
                    "total_lines": total_lines,
                    "has_more": has_more,
                    "next_offset": offset + limit if has_more else None,
                },
            )

        except Exception as e:
            return ToolResult(
                success=False, output=None, error=f"Failed to read file: {str(e)}"
            )

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


class FileListInput(ToolInput):
    """Input schema for file list tool."""

    directory: str = Field(
        default=".", description="Directory path relative to workspace"
    )
    pattern: Optional[str] = Field(
        default=None, description="Optional glob pattern to filter files"
    )


class FileListSkill(BaseTool):
    """Skill for listing files in a directory."""

    name = "list_files"
    description = "List files in a directory with optional pattern filtering. Returns file names, sizes, and modification times."
    input_schema = FileListInput

    def __init__(self, workspace_root: str = "/workspace", timeout: int = 30):
        """Initialize file list skill.

        Args:
            workspace_root: Root directory for file access
            timeout: Execution timeout
        """
        super().__init__(timeout)
        self.workspace_root = workspace_root

    async def execute(
        self, directory: str = ".", pattern: Optional[str] = None
    ) -> ToolResult:
        """Execute file listing.

        Args:
            directory: Directory path relative to workspace
            pattern: Optional glob pattern

        Returns:
            ToolResult with file list
        """
        try:
            import glob

            # Resolve directory path
            full_dir = self._resolve_directory(directory)

            if not os.path.exists(full_dir):
                return ToolResult(
                    success=False,
                    output=None,
                    error=f"Directory not found: {directory}",
                )

            if not os.path.isdir(full_dir):
                return ToolResult(
                    success=False,
                    output=None,
                    error=f"Path is not a directory: {directory}",
                )

            # Validate glob pattern for directory traversal attempts
            if pattern and (".." in pattern or pattern.startswith("/")):
                return ToolResult(
                    success=False,
                    output=None,
                    error="Invalid pattern: parent directory traversal not allowed",
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

            return ToolResult(
                success=True,
                output=files,
                metadata={
                    "directory": directory,
                    "pattern": pattern,
                    "file_count": len(files),
                },
            )

        except Exception as e:
            return ToolResult(
                success=False, output=None, error=f"Failed to list files: {str(e)}"
            )

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
