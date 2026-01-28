# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Sandbox file writing tool using E2B SDK.

This module provides the SandboxWriteFileTool class that writes
file contents to the sandbox environment.
"""

import asyncio
import base64
import json
import logging
from typing import Optional

from langchain_core.callbacks import CallbackManagerForToolRun
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


class SandboxWriteFileInput(BaseModel):
    """Input schema for sandbox_write_file tool."""

    file_path: str = Field(
        ...,
        description="Absolute or relative path to the file to write",
    )
    content: str = Field(
        ...,
        description="REQUIRED: Content to write to the file (text or base64-encoded bytes). This parameter is mandatory and cannot be omitted.",
    )
    format: Optional[str] = Field(
        default="text",
        description="Format of content: 'text' (default) or 'bytes' (base64-encoded)",
    )
    create_dirs: Optional[bool] = Field(
        default=True,
        description="Create parent directories if they don't exist (default: True)",
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


class SandboxWriteFileTool(BaseSandboxTool):
    """Tool for writing files to E2B sandbox.

    This tool writes file contents to the sandbox filesystem
    using E2B SDK's file operations.
    """

    name: str = "sandbox_write_file"
    display_name: str = "写入文件"
    description: str = """Write content to a file in the sandbox environment.

Use this tool to create or overwrite files in the sandbox filesystem.

⚠️ IMPORTANT: Both file_path AND content are REQUIRED parameters. You MUST provide content to write.

Parameters:
- file_path (REQUIRED): Path to the file (absolute or relative to /home/user)
- content (REQUIRED): Content to write (text or base64-encoded bytes). MUST be provided, cannot be empty.
- format (optional): Content format - 'text' (default) or 'bytes' (base64-encoded)
- create_dirs (optional): Create parent directories if needed (default: True)

Returns:
- success: Whether the file was written successfully
- path: Absolute path to the file
- size: Number of bytes written
- format: Format used for writing

Example - Writing text file:
{
  "file_path": "/home/user/output.txt",
  "content": "Hello, World!",
  "format": "text"
}

Example - Writing HTML file:
{
  "file_path": "/home/user/index.html",
  "content": "<!DOCTYPE html><html><body><h1>Title</h1></body></html>"
}"""

    args_schema: type[BaseModel] = SandboxWriteFileInput

    # Configuration
    max_size: int = 10485760  # 10MB default

    def _run(
        self,
        file_path: str,
        content: str,
        format: Optional[str] = "text",
        create_dirs: Optional[bool] = True,
        run_manager: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """Synchronous run - not implemented."""
        raise NotImplementedError("SandboxWriteFileTool only supports async execution")

    async def _arun(
        self,
        file_path: str,
        content: str,
        format: Optional[str] = "text",
        create_dirs: Optional[bool] = True,
        run_manager: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """Write file to E2B sandbox.

        Args:
            file_path: Path to file to write
            content: Content to write (text or base64-encoded bytes)
            format: Format of content ('text' or 'bytes')
            create_dirs: Create parent directories if needed
            run_manager: Callback manager

        Returns:
            JSON string with write result and metadata
        """
        # Validate required parameters
        if not content:
            error_msg = (
                "Missing required parameter 'content'. "
                "You MUST provide content to write to the file. "
                "The 'content' parameter cannot be empty or omitted."
            )
            logger.error(f"[SandboxWriteFileTool] {error_msg}")
            result = self._format_error(
                error_message=error_msg,
                path=file_path,
                size=0,
            )
            await self._emit_tool_status("failed", error_msg)
            return result

        logger.info(
            f"[SandboxWriteFileTool] Writing file: {file_path}, format={format}, "
            f"content_len={len(content)}"
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
                        "size": len(content),
                    },
                    status="running",
                )
            except Exception as e:
                logger.warning(
                    f"[SandboxWriteFileTool] Failed to emit tool status: {e}"
                )

        try:
            # Get sandbox manager from base class
            sandbox_manager = self._get_sandbox_manager()

            # Get or create sandbox
            logger.info(f"[SandboxWriteFileTool] Getting or creating sandbox...")
            sandbox, error = await sandbox_manager.get_or_create_sandbox(
                shell_type=self.default_shell_type,
                workspace_ref=None,
            )

            if error:
                logger.error(
                    f"[SandboxWriteFileTool] Failed to create sandbox: {error}"
                )
                result = self._format_error(
                    error_message=f"Failed to create sandbox: {error}",
                    path="",
                    size=0,
                )
                await self._emit_tool_status("failed", error)
                return result

            # Normalize path
            if not file_path.startswith("/"):
                file_path = f"/home/user/{file_path}"

            # Prepare content based on format
            if format == "bytes":
                try:
                    content_bytes = base64.b64decode(content)
                except Exception as e:
                    error_msg = f"Invalid base64 content: {e}"
                    result = self._format_error(
                        error_message=error_msg,
                        path="",
                        size=0,
                    )
                    await self._emit_tool_status("failed", error_msg)
                    return result
            else:
                content_bytes = content.encode("utf-8")

            # Check size before writing
            if len(content_bytes) > self.max_size:
                error_msg = f"Content too large: {len(content_bytes)} bytes (max: {self.max_size} bytes)"
                result = self._format_error(
                    error_message=error_msg,
                    path="",
                    size=len(content_bytes),
                )
                await self._emit_tool_status("failed", error_msg)
                return result

            logger.info(
                f"[SandboxWriteFileTool] Writing file in sandbox {sandbox.sandbox_id}"
            )

            # Create parent directories if needed
            if create_dirs:
                import os

                parent_dir = os.path.dirname(file_path)
                if parent_dir and parent_dir != "/":
                    try:
                        await sandbox.files.make_dir(parent_dir)
                        logger.info(
                            f"[SandboxWriteFileTool] Created directory: {parent_dir}"
                        )
                    except Exception as e:
                        # Directory might already exist, that's okay
                        logger.debug(
                            f"[SandboxWriteFileTool] Directory creation skipped: {e}"
                        )

            # Write file using native async API
            if format == "bytes":
                await sandbox.files.write(file_path, content_bytes)
            else:
                await sandbox.files.write(file_path, content)

            # Get file info to confirm write
            file_info = await sandbox.files.get_info(file_path)

            response = {
                "success": True,
                "path": file_path,
                "size": file_info.size,
                "format": format,
                "modified_time": file_info.modified_time.isoformat(),
                "sandbox_id": sandbox.sandbox_id,
            }

            logger.info(
                f"[SandboxWriteFileTool] File written successfully: {file_info.size} bytes"
            )

            # Emit success status
            await self._emit_tool_status(
                "completed",
                f"File written successfully ({file_info.size} bytes)",
                response,
            )

            return json.dumps(response, ensure_ascii=False, indent=2)

        except ImportError as e:
            logger.error(f"[SandboxWriteFileTool] E2B SDK import error: {e}")
            error_msg = "E2B SDK not available. Please install e2b-code-interpreter."
            result = self._format_error(
                error_message=error_msg,
                path="",
                size=0,
            )
            await self._emit_tool_status("failed", error_msg)
            return result
        except Exception as e:
            logger.error(f"[SandboxWriteFileTool] Write failed: {e}", exc_info=True)
            error_msg = f"Failed to write file: {e}"
            result = self._format_error(
                error_message=error_msg,
                path="",
                size=0,
            )
            await self._emit_tool_status("failed", error_msg)
            return result
