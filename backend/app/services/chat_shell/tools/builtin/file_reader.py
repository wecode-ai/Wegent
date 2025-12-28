# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""File skills for reading and listing files within a workspace."""

import json
from pathlib import Path

from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field


def _resolve_safe_path(workspace_root: str, relative_path: str) -> Path:
    """Resolve path safely within workspace bounds.

    Args:
        workspace_root: Root directory for file access
        relative_path: Path relative to workspace

    Returns:
        Resolved absolute Path

    Raises:
        ValueError: If path is outside workspace root
    """
    workspace = Path(workspace_root).resolve()
    target = (workspace / relative_path.lstrip("/")).resolve()

    if not target.is_relative_to(workspace):
        raise ValueError(f"Path traversal detected: {relative_path}")

    return target


class FileReaderInput(BaseModel):
    """Input schema for file reader tool."""

    file_path: str = Field(description="File path relative to workspace")
    offset: int = Field(default=0, description="Starting line number (0-indexed)")
    limit: int = Field(default=200, description="Number of lines to read")


class FileReaderSkill(BaseTool):
    """Read file contents with chunked pagination support."""

    name: str = "read_file"
    display_name: str = "读取文件"
    description: str = (
        "Read file content with pagination. Returns lines range with metadata."
    )
    args_schema: type[BaseModel] = FileReaderInput

    workspace_root: str = "/workspace"
    max_lines: int = 500

    def __init__(
        self, workspace_root: str = "/workspace", max_lines: int = 500, **kwargs
    ) -> None:
        super().__init__(**kwargs)
        self.workspace_root = workspace_root
        self.max_lines = max_lines

    def _run(self, file_path: str, offset: int = 0, limit: int = 200, **_) -> str:
        try:
            path = _resolve_safe_path(self.workspace_root, file_path)

            if not path.exists():
                return json.dumps({"error": f"File not found: {file_path}"})
            if not path.is_file():
                return json.dumps({"error": f"Not a file: {file_path}"})

            limit = min(limit, self.max_lines)
            content, total, has_more = self._read_chunk(path, offset, limit)

            return json.dumps(
                {
                    "content": content,
                    "file_path": file_path,
                    "offset": offset,
                    "lines_read": len(content.splitlines()) if content else 0,
                    "total_lines": total,
                    "has_more": has_more,
                    "next_offset": offset + limit if has_more else None,
                },
                ensure_ascii=False,
            )

        except Exception as e:
            return json.dumps({"error": f"Failed to read file: {e}"})

    async def _arun(
        self, file_path: str, offset: int = 0, limit: int = 200, **_
    ) -> str:
        return self._run(file_path, offset, limit)

    def _read_chunk(self, path: Path, offset: int, limit: int) -> tuple[str, int, bool]:
        """Read a chunk of lines from file."""
        lines = []
        lines_after = 0  # Track if there are more lines

        with path.open("r", encoding="utf-8", errors="replace") as f:
            for i, line in enumerate(f):
                if offset <= i < offset + limit:
                    lines.append(line.rstrip("\n"))
                elif i >= offset + limit:
                    lines_after += 1
                    if lines_after > 0:
                        break  # Found at least one more line

        return "\n".join(lines), -1, lines_after > 0  # -1 = unknown total


class FileListInput(BaseModel):
    """Input schema for file list tool."""

    directory: str = Field(
        default=".", description="Directory path relative to workspace"
    )
    pattern: str | None = Field(
        default=None, description="Glob pattern to filter files"
    )


class FileListSkill(BaseTool):
    """List files in a directory with optional pattern filtering."""

    name: str = "list_files"
    display_name: str = "列出文件"
    description: str = (
        "List files in a directory. Returns file names, sizes, and modification times."
    )
    args_schema: type[BaseModel] = FileListInput

    workspace_root: str = "/workspace"

    def __init__(self, workspace_root: str = "/workspace", **kwargs) -> None:
        super().__init__(**kwargs)
        self.workspace_root = workspace_root

    def _run(self, directory: str = ".", pattern: str | None = None, **_) -> str:
        try:
            dir_path = _resolve_safe_path(self.workspace_root, directory)

            if not dir_path.exists():
                return json.dumps({"error": f"Directory not found: {directory}"})
            if not dir_path.is_dir():
                return json.dumps({"error": f"Not a directory: {directory}"})

            # Validate pattern
            if pattern and (".." in pattern or pattern.startswith("/")):
                return json.dumps({"error": "Invalid pattern: traversal not allowed"})

            # Get files
            workspace = Path(self.workspace_root).resolve()
            if pattern:
                paths = [
                    p for p in dir_path.glob(pattern) if p.is_relative_to(workspace)
                ]
            else:
                paths = list(dir_path.iterdir())

            # Collect file info
            files = []
            for p in sorted(paths):
                if p.is_file():
                    stat = p.stat()
                    files.append(
                        {
                            "path": str(p.relative_to(workspace)),
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
            return json.dumps({"error": f"Failed to list files: {e}"})

    async def _arun(self, directory: str = ".", pattern: str | None = None, **_) -> str:
        return self._run(directory, pattern)
