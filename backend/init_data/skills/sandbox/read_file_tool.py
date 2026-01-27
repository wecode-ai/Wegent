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

Size Limits:
- Text files: Maximum 100KB (102400 bytes)
- Binary files: Maximum 32KB (32768 bytes)
- Files exceeding limits will be rejected

Returns:
- success: Whether the file was read successfully
- content: File contents as string (or base64 for bytes)
- size: File size in bytes
- path: Absolute path to the file
- format: Format used for reading

Example:
{
  "file_path": "/home/user/data.txt",
  "format": "text"
}"""

    args_schema: type[BaseModel] = SandboxReadFileInput

    # Configuration
    max_size: int = 102400  # 100KB for text files
    max_size_bytes: int = 32768  # 32KB for binary files

    def _run(
        self,
        file_path: str,
        format: Optional[str] = "text",
        run_manager: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """Synchronous run - not implemented."""
        raise NotImplementedError("SandboxReadFileTool only supports async execution")

    async def _arun(
        self,
        file_path: str,
        format: Optional[str] = "text",
        run_manager: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """Read file from E2B sandbox.

        Args:
            file_path: Path to file to read
            format: Format to read ('text' or 'bytes')
            run_manager: Callback manager

        Returns:
            JSON string with file contents and metadata
        """
        logger.info(f"[SandboxReadFileTool] Reading file: {file_path}, format={format}")

        # Emit status update via WebSocket if available
        if self.ws_emitter:
            try:
                await self.ws_emitter.emit_tool_call(
                    task_id=self.task_id,
                    tool_name=self.name,
                    tool_input={
                        "file_path": file_path,
                        "format": format,
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

            # Check file size against limits
            file_size = file_info.size
            max_size_for_format = (
                self.max_size_bytes if format == "bytes" else self.max_size
            )

            # Reject files that exceed the limit
            if file_size > max_size_for_format:
                max_size_kb = max_size_for_format / 1024
                file_size_kb = file_size / 1024
                file_type = "Binary" if format == "bytes" else "Text"
                error_msg = (
                    f"{file_type} file too large: {file_size} bytes ({file_size_kb:.1f} KB). "
                    f"Maximum allowed size for {file_type.lower()} files: {max_size_for_format} bytes ({max_size_kb:.0f} KB)."
                )
                result = self._format_error(
                    error_message=error_msg,
                    content="",
                    size=file_size,
                    path=file_path,
                )
                await self._emit_tool_status("failed", error_msg)
                return result

            # Read file entirely
            logger.info(
                f"[SandboxReadFileTool] Reading file in sandbox {sandbox.sandbox_id}"
            )

            if format == "bytes":
                content = await sandbox.files.read(file_path, format="bytes")
                content_str = base64.b64encode(content).decode("ascii")
            else:
                content = await sandbox.files.read(file_path, format="text")
                content_str = content

            response = {
                "success": True,
                "content": content_str,
                "size": file_size,
                "path": file_path,
                "format": format,
                "modified_time": file_info.modified_time.isoformat(),
                "sandbox_id": sandbox.sandbox_id,
            }

            logger.info(
                f"[SandboxReadFileTool] File read successfully: {file_size} bytes"
            )

            # Emit success status
            await self._emit_tool_status(
                "completed",
                f"File read successfully ({file_size} bytes)",
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
