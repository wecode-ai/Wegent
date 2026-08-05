# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Sandbox file reading tool using E2B SDK.

This module provides the SandboxReadFileTool class that reads
file contents from the sandbox environment.
"""

import base64
import json
import logging
import mimetypes
from typing import Any, Optional

from langchain_core.callbacks import CallbackManagerForToolRun
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

IMAGE_MIME_TYPES = frozenset(
    {
        "image/jpeg",
        "image/jpg",
        "image/png",
        "image/gif",
        "image/webp",
        "image/bmp",
        "image/tiff",
    }
)


class SandboxReadFileInput(BaseModel):
    """Input schema for read_file tool."""

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

    For image files (jpg, png, gif, webp, bmp, tiff), the tool
    returns base64-encoded image_url blocks for direct multimodal
    rendering instead of JSON text.
    """

    name: str = "read_file"
    display_name: str = "读取文件"
    description: str = """Read the contents of a file from the sandbox environment.

Use this tool to read files stored in the sandbox filesystem.

Parameters:
- file_path (required): Path to the file (absolute or relative to /home/user)
- format (optional): Read format - 'text' (default) or 'bytes'

Size Limits:
- Text files: Maximum 100KB (102400 bytes)
- Binary files: Maximum 32KB (32768 bytes)
- Image files: Maximum 2MB (2097152 bytes)
- Files exceeding limits will be rejected

Returns:
- For image files (jpg, png, gif, webp, bmp, tiff): Returns a list with
  an image_url block containing base64-encoded image data for direct rendering.
- For other files: JSON with success, content, size, path, format fields.

Example:
{
  "file_path": "/home/user/data.txt",
  "format": "text"
}"""

    args_schema: type[BaseModel] = SandboxReadFileInput

    # Configuration
    max_size: int = 102400  # 100KB for text files
    max_size_bytes: int = 32768  # 32KB for binary files
    max_image_size: int = 2097152  # 2MB for image files

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
    ) -> str | list[dict[str, Any]]:
        """Read file from E2B sandbox.

        Args:
            file_path: Path to file to read
            format: Format to read ('text' or 'bytes')
            run_manager: Callback manager

        Returns:
            For image files: List containing an image_url block.
            For other files: JSON string with file contents and metadata.
        """
        logger.info(
            "[SandboxReadFileTool] Reading file: %s, format=%s", file_path, format
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
                    },
                    status="running",
                )
            except Exception as e:
                logger.warning(
                    "[SandboxReadFileTool] Failed to emit tool status: %s", e
                )

        try:
            # Get sandbox manager from base class
            sandbox_manager = self._get_sandbox_manager()

            # Get or create sandbox
            logger.info("[SandboxReadFileTool] Getting or creating sandbox...")
            sandbox, error = await sandbox_manager.get_or_create_sandbox(
                shell_type=self.default_shell_type,
                workspace_ref=None,
            )

            if error:
                logger.error(
                    "[SandboxReadFileTool] Failed to create sandbox: %s", error
                )
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
                "[SandboxReadFileTool] Reading file in sandbox %s",
                sandbox.sandbox_id,
            )

            # First, check if file exists and get its info
            try:
                file_info = await sandbox.files.get_info(file_path)
            except Exception:
                logger.warning("[SandboxReadFileTool] File not found: %s", file_path)
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

            # Determine MIME type from path for image detection
            content_type = mimetypes.guess_type(file_path)[0]
            if not content_type:
                content_type = "application/octet-stream"

            is_image = content_type in IMAGE_MIME_TYPES

            # Check file size against appropriate limit
            file_size = file_info.size
            if is_image:
                max_size_for_format = self.max_image_size
            else:
                max_size_for_format = (
                    self.max_size_bytes if format == "bytes" else self.max_size
                )

            # Reject files that exceed the limit
            if file_size > max_size_for_format:
                max_size_mb = max_size_for_format / (1024 * 1024)
                max_size_kb = max_size_for_format / 1024
                file_size_kb = file_size / 1024
                if is_image:
                    file_type = "Image"
                    size_str = f"{max_size_for_format} bytes ({max_size_mb:.0f} MB)"
                else:
                    file_type = "Binary" if format == "bytes" else "Text"
                    size_str = f"{max_size_for_format} bytes ({max_size_kb:.0f} KB)"
                error_msg = (
                    f"{file_type} file too large: {file_size} bytes ({file_size_kb:.1f} KB). "
                    f"Maximum allowed size for {file_type.lower()} files: {size_str}."
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
                "[SandboxReadFileTool] Reading file in sandbox %s",
                sandbox.sandbox_id,
            )

            # For image files, return image_url block directly
            if is_image:
                content = await sandbox.files.read(file_path, format="bytes")
                b64_data = base64.b64encode(content).decode("utf-8")
                await self._emit_tool_status("completed", f"Image loaded: {file_path}")
                return [
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:{content_type};base64,{b64_data}"},
                    }
                ]

            # For non-image files, return JSON response
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
                "[SandboxReadFileTool] File read successfully: %d bytes", file_size
            )

            # Emit success status
            await self._emit_tool_status(
                "completed",
                f"File read successfully ({file_size} bytes)",
                response,
            )

            return json.dumps(response, ensure_ascii=False, indent=2)

        except ImportError as e:
            logger.error("[SandboxReadFileTool] E2B SDK import error: %s", e)
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
            logger.error("[SandboxReadFileTool] Read failed: %s", e, exc_info=True)
            error_msg = f"Failed to read file: {e}"
            result = self._format_error(
                error_message=error_msg,
                content="",
                size=0,
                path="",
            )
            await self._emit_tool_status("failed", error_msg)
            return result
