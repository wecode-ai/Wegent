# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Sandbox file reading tool using E2B SDK.

This module provides the SandboxReadFileTool class that reads
file contents from the sandbox environment.
"""

import asyncio
import base64
import json
import logging
from typing import Optional

from langchain_core.callbacks import CallbackManagerForToolRun
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


class SandboxReadFileInput(BaseModel):
    """Input schema for sandbox_read_file tool."""

    file_path: str = Field(
        ...,
        description="Absolute or relative path to the file to read",
    )
    format: Optional[str] = Field(
        default="text",
        description="Format to read the file: 'text' (default) or 'bytes'",
    )
    offset: Optional[int] = Field(
        default=0,
        description="Starting byte position to read from (default: 0)",
    )
    limit: Optional[int] = Field(
        default=None,
        description="Maximum number of bytes to read (default: None, uses max_size)",
    )


# Import base class here - use try/except to handle both direct and dynamic loading
try:
    # Try relative import (for direct usage)
    from ._base import BaseSandboxTool
except ImportError:
    # Try absolute import (for dynamic loading as skill_pkg_sandbox)
    import sys

    # Get the package name dynamically
    package_name = __name__.rsplit(".", 1)[0]  # e.g., 'skill_pkg_sandbox'
    _base_module = sys.modules.get(f"{package_name}._base")
    if _base_module:
        BaseSandboxTool = _base_module.BaseSandboxTool
    else:
        raise ImportError(f"Cannot import _base from {package_name}")


class SandboxReadFileTool(BaseSandboxTool):
    """Tool for reading files from E2B sandbox.

    This tool reads file contents from the sandbox filesystem
    using E2B SDK's file operations.
    """

    name: str = "sandbox_read_file"
    display_name: str = "读取文件"
    description: str = """Read the contents of a file from the sandbox environment.

Use this tool to read files stored in the sandbox filesystem.

Parameters:
- file_path (required): Path to the file (absolute or relative to /home/user)
- format (optional): Read format - 'text' (default) or 'bytes'
- offset (optional): Starting byte position (default: 0)
- limit (optional): Maximum bytes to read (default: uses max_size)

Returns:
- success: Whether the file was read successfully
- content: File contents as string (or base64 for bytes)
- size: Total file size in bytes
- bytes_read: Number of bytes actually read
- truncated: Whether content was truncated
- path: Absolute path to the file
- format: Format used for reading

Example (read entire file):
{
  "file_path": "/home/user/data.txt",
  "format": "text"
}

Example (read first 1000 bytes):
{
  "file_path": "/home/user/large.log",
  "format": "text",
  "offset": 0,
  "limit": 1000
}

Example (read from middle):
{
  "file_path": "/home/user/large.log",
  "format": "text",
  "offset": 5000,
  "limit": 1000
}"""

    args_schema: type[BaseModel] = SandboxReadFileInput

    # Configuration
    max_size: int = 102400  # 100KB for text files
    max_size_bytes: int = 32768  # 32KB for binary files (base64 encoded is larger)
    smart_truncate_head: int = 45056  # 44KB from start (text)
    smart_truncate_tail: int = 45056  # 44KB from end (text)
    smart_truncate_head_bytes: int = 14336  # 14KB from start (binary)
    smart_truncate_tail_bytes: int = 14336  # 14KB from end (binary)

    def _run(
        self,
        file_path: str,
        format: Optional[str] = "text",
        offset: Optional[int] = 0,
        limit: Optional[int] = None,
        run_manager: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """Synchronous run - not implemented."""
        raise NotImplementedError("SandboxReadFileTool only supports async execution")

    async def _smart_truncate_file(
        self, sandbox, file_path: str, file_size: int, format: str
    ) -> tuple[str, bool]:
        """Smart truncate large files by reading head + tail.

        Note: This method is only called for text files. Binary files that exceed
        the limit are rejected before reaching this method.

        Args:
            sandbox: E2B sandbox instance
            file_path: Path to file
            file_size: Total file size
            format: Read format ('text' only, 'bytes' are rejected earlier)

        Returns:
            Tuple of (content, is_truncated)
        """
        # Use text file limits (binary files are rejected earlier)
        max_size = self.max_size
        truncate_head = self.smart_truncate_head
        truncate_tail = self.smart_truncate_tail

        if file_size <= max_size:
            # File is small enough, read entirely
            content = await sandbox.files.read(file_path, format=format)
            return content, False

        # File is too large, read head + tail
        logger.warning(
            f"[SandboxReadFileTool] Text file too large ({file_size} bytes), "
            f"applying smart truncation (head: {truncate_head}, tail: {truncate_tail})"
        )

        # Read head
        head_content = await self._read_file_range(
            sandbox, file_path, 0, truncate_head, format
        )

        # Read tail
        tail_offset = max(0, file_size - truncate_tail)
        tail_content = await self._read_file_range(
            sandbox, file_path, tail_offset, truncate_tail, format
        )

        # Combine with truncation marker
        truncation_marker = f"\n\n... [TRUNCATED {file_size - truncate_head - truncate_tail} bytes] ...\n\n"

        content = f"{head_content}{truncation_marker}{tail_content}"
        return content, True

    async def _read_file_range(
        self, sandbox, file_path: str, offset: int, limit: int, format: str
    ) -> str:
        """Read a specific byte range from file.

        Args:
            sandbox: E2B sandbox instance
            file_path: Path to file
            offset: Starting byte position
            limit: Maximum bytes to read
            format: Read format ('text' or 'bytes')

        Returns:
            File content as string (or base64 for bytes)
        """
        # E2B SDK doesn't support offset/limit directly, so we need to use command execution
        if format == "bytes":
            # Use dd to read specific byte range and encode to base64
            result = await sandbox.commands.run(
                cmd=f"dd if={file_path} bs=1 skip={offset} count={limit} 2>/dev/null | base64",
                cwd="/home/user",
            )
            return result.stdout.strip() if result.stdout else ""
        else:
            # Use dd to read specific byte range as text
            result = await sandbox.commands.run(
                cmd=f"dd if={file_path} bs=1 skip={offset} count={limit} 2>/dev/null",
                cwd="/home/user",
            )
            return result.stdout if result.stdout else ""

    async def _arun(
        self,
        file_path: str,
        format: Optional[str] = "text",
        offset: Optional[int] = 0,
        limit: Optional[int] = None,
        run_manager: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """Read file from E2B sandbox.

        Args:
            file_path: Path to file to read
            format: Format to read ('text' or 'bytes')
            offset: Starting byte position
            limit: Maximum bytes to read
            run_manager: Callback manager

        Returns:
            JSON string with file contents and metadata
        """
        logger.info(
            f"[SandboxReadFileTool] Reading file: {file_path}, format={format}, "
            f"offset={offset}, limit={limit}"
        )

        # Emit status update via WebSocket if available
        if self.ws_emitter:
            try:
                await self.ws_emitter.emit_tool_call(
                    task_id=self.task_id,
                    tool_name=self.name,
                    tool_input={
                        "file_path": file_path,
                        "format": format,
                        "offset": offset,
                        "limit": limit,
                    },
                    status="running",
                )
            except Exception as e:
                logger.warning(f"[SandboxReadFileTool] Failed to emit tool status: {e}")

        try:
            # Get sandbox manager from base class
            sandbox_manager = self._get_sandbox_manager()

            # Get or create sandbox
            logger.info(f"[SandboxReadFileTool] Getting or creating sandbox...")
            sandbox, error = await sandbox_manager.get_or_create_sandbox(
                shell_type=self.default_shell_type,
                workspace_ref=None,
            )

            if error:
                logger.error(f"[SandboxReadFileTool] Failed to create sandbox: {error}")
                result = self._format_error(
                    error_message=f"Failed to create sandbox: {error}",
                    content="",
                    size=0,
                    path="",
                )
                await self._emit_tool_status("failed", error)
                return result

            # Normalize path
            if not file_path.startswith("/"):
                file_path = f"/home/user/{file_path}"

            logger.info(
                f"[SandboxReadFileTool] Reading file in sandbox {sandbox.sandbox_id}"
            )

            # First, check if file exists and get its info
            try:
                file_info = await sandbox.files.get_info(file_path)
            except Exception as e:
                logger.warning(f"[SandboxReadFileTool] File not found: {file_path}")
                error_msg = f"File not found: {file_path}"
                result = self._format_error(
                    error_message=error_msg,
                    content="",
                    size=0,
                    path="",
                )
                await self._emit_tool_status("failed", error_msg)
                return result

            # Check if it's a file (not directory)
            if file_info.type and file_info.type.value != "file":
                error_msg = f"Path is a {file_info.type.value}, not a file"
                result = self._format_error(
                    error_message=error_msg,
                    content="",
                    size=0,
                    path="",
                )
                await self._emit_tool_status("failed", error_msg)
                return result

            # Determine bytes to read (use different limits for text vs binary)
            file_size = file_info.size
            max_size_for_format = (
                self.max_size_bytes if format == "bytes" else self.max_size
            )
            bytes_to_read = limit if limit is not None else max_size_for_format

            # Check if binary file exceeds limit (reject completely, no range reading allowed)
            if format == "bytes" and file_size > self.max_size_bytes:
                max_size_kb = self.max_size_bytes / 1024
                file_size_kb = file_size / 1024
                error_msg = (
                    f"Binary file too large: {file_size} bytes ({file_size_kb:.1f} KB). "
                    f"Maximum allowed size for binary files: {self.max_size_bytes} bytes ({max_size_kb:.0f} KB). "
                    f"Binary files that exceed the limit cannot be read (including range reading)."
                )
                result = self._format_error(
                    error_message=error_msg,
                    content="",
                    size=file_size,
                    path=file_path,
                )
                await self._emit_tool_status("failed", error_msg)
                return result

            # Handle offset/limit reading or smart truncation
            is_truncated = False
            if offset > 0 or limit is not None:
                # User specified offset/limit - do range read
                if offset >= file_size:
                    error_msg = f"Offset {offset} exceeds file size {file_size}"
                    result = self._format_error(
                        error_message=error_msg,
                        content="",
                        size=file_size,
                        path=file_path,
                    )
                    await self._emit_tool_status("failed", error_msg)
                    return result

                # Read the specified range
                actual_limit = min(bytes_to_read, file_size - offset)
                content_str = await self._read_file_range(
                    sandbox, file_path, offset, actual_limit, format
                )
                is_truncated = (offset + actual_limit) < file_size
                bytes_read = actual_limit

            elif file_size <= max_size_for_format:
                # File is small enough, read entirely
                if format == "bytes":
                    content = await sandbox.files.read(file_path, format="bytes")
                    content_str = base64.b64encode(content).decode("ascii")
                else:
                    content = await sandbox.files.read(file_path, format="text")
                    content_str = content
                bytes_read = file_size
                is_truncated = False

            else:
                # File is too large, apply smart truncation (text files only)
                # Note: Binary files are rejected earlier if they exceed limit
                content_str, is_truncated = await self._smart_truncate_file(
                    sandbox, file_path, file_size, format
                )
                # Calculate bytes read (only for text files at this point)
                bytes_read = self.smart_truncate_head + self.smart_truncate_tail

            response = {
                "success": True,
                "content": content_str,
                "size": file_size,
                "bytes_read": bytes_read,
                "truncated": is_truncated,
                "path": file_path,
                "format": format,
                "offset": offset,
                "modified_time": file_info.modified_time.isoformat(),
                "sandbox_id": sandbox.sandbox_id,
            }

            if is_truncated:
                response["truncation_info"] = (
                    f"File was truncated. Total size: {file_size} bytes, "
                    f"Read: {bytes_read} bytes. "
                    f"Use offset/limit parameters to read specific ranges."
                )

            logger.info(
                f"[SandboxReadFileTool] File read successfully: {bytes_read}/{file_size} bytes "
                f"(truncated: {is_truncated})"
            )

            # Emit success status
            await self._emit_tool_status(
                "completed",
                f"File read successfully ({bytes_read} bytes{', truncated' if is_truncated else ''})",
                response,
            )

            return json.dumps(response, ensure_ascii=False, indent=2)

        except ImportError as e:
            logger.error(f"[SandboxReadFileTool] E2B SDK import error: {e}")
            error_msg = "E2B SDK not available. Please install e2b-code-interpreter."
            result = self._format_error(
                error_message=error_msg,
                content="",
                size=0,
                path="",
            )
            await self._emit_tool_status("failed", error_msg)
            return result
        except Exception as e:
            logger.error(f"[SandboxReadFileTool] Read failed: {e}", exc_info=True)
            error_msg = f"Failed to read file: {e}"
            result = self._format_error(
                error_message=error_msg,
                content="",
                size=0,
                path="",
            )
            await self._emit_tool_status("failed", error_msg)
            return result
