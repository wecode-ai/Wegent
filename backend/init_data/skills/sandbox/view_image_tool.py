# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Sandbox image viewer tool for reading image files from sandbox containers.

This module provides the SandboxViewImageTool class that reads image files
from the sandbox environment and returns their visual content as base64-encoded
image_url blocks for direct rendering by multimodal LLMs.
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


class SandboxViewImageInput(BaseModel):
    """Input schema for view_sandbox_image_file tool."""

    path: str = Field(
        description=(
            "Absolute or relative path to an image file in the sandbox "
            "(e.g., /home/user/image.png or chart.png). "
            "Relative paths are resolved against /home/user. "
            "Supported formats: jpg, png, gif, webp, bmp, tiff."
        )
    )


class SandboxViewImageTool(BaseSandboxTool):
    """View an image file from the sandbox filesystem.

    This tool reads image files from the sandbox environment and returns
    their visual content as base64-encoded image_url blocks for direct rendering.

    Supported formats: jpg, png, gif, webp, bmp, tiff.
    """

    name: str = "view_sandbox_image_file"
    display_name: str = "查看沙箱图片"
    description: str = (
        "View an image file from the sandbox filesystem. "
        "Supported formats: jpg, png, gif, webp, bmp, tiff. "
        "Returns the visual content so you can see the image."
    )
    args_schema: type[BaseModel] = SandboxViewImageInput

    def _run(
        self,
        path: str,
        run_manager: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """Synchronous run - not implemented."""
        raise NotImplementedError("SandboxViewImageTool only supports async execution")

    async def _arun(
        self,
        path: str,
        run_manager: Optional[CallbackManagerForToolRun] = None,
    ) -> str | list[dict[str, Any]]:
        """Read an image file from the sandbox and return its visual content.

        Args:
            path: Absolute path to the image file in the sandbox
            run_manager: Callback manager

        Returns:
            List containing an image_url block for multimodal rendering,
            or a JSON error string.
        """
        # Emit status update via WebSocket if available
        if self.ws_emitter:
            try:
                await self.ws_emitter.emit_tool_call(
                    task_id=self.task_id,
                    tool_name=self.name,
                    tool_input={"path": path},
                    status="running",
                )
            except Exception as e:
                logger.warning(
                    "[SandboxViewImageTool] Failed to emit tool status: %s", e
                )

        try:
            # Get sandbox manager from base class
            sandbox_manager = self._get_sandbox_manager()

            # Get or create sandbox
            sandbox, error = await sandbox_manager.get_or_create_sandbox(
                shell_type=self.default_shell_type,
                workspace_ref=None,
            )

            if error:
                error_msg = f"Failed to create sandbox: {error}"
                await self._emit_tool_status("failed", error_msg)
                return json.dumps({"error": error_msg})

            # Normalize path
            if not path.startswith("/"):
                path = f"/home/user/{path}"

            logger.info(
                "[SandboxViewImageTool] Reading image in sandbox %s",
                sandbox.sandbox_id,
            )

            # Check if file exists and get its info
            try:
                file_info = await sandbox.files.get_info(path)
            except Exception:
                logger.warning("[SandboxViewImageTool] File not found: %s", path)
                error_msg = f"File not found: {path}"
                await self._emit_tool_status("failed", error_msg)
                return json.dumps({"error": error_msg})

            # Check if it's a file (not directory)
            if file_info.type and file_info.type.value != "file":
                error_msg = f"Path is a {file_info.type.value}, not a file"
                await self._emit_tool_status("failed", error_msg)
                return json.dumps({"error": error_msg})

            # Read file as bytes
            content = await sandbox.files.read(path, format="bytes")

            # Determine MIME type from path
            content_type = mimetypes.guess_type(path)[0]
            if not content_type:
                content_type = "application/octet-stream"

            if content_type not in IMAGE_MIME_TYPES:
                error_msg = (
                    f"Not an image file: {path} "
                    f"(type: {content_type}). "
                    "Use the sandbox read_file tool to read non-image files."
                )
                await self._emit_tool_status("failed", error_msg)
                return json.dumps({"error": error_msg})

            # Encode to base64 and return as image_url block
            b64_data = base64.b64encode(content).decode("utf-8")
            await self._emit_tool_status("completed", f"Image loaded: {path}")
            return [
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:{content_type};base64,{b64_data}"},
                }
            ]

        except ImportError as e:
            logger.error("[SandboxViewImageTool] E2B SDK import error: %s", e)
            error_msg = "E2B SDK not available. Please install e2b-code-interpreter."
            await self._emit_tool_status("failed", error_msg)
            return json.dumps({"error": error_msg})
        except Exception as e:
            logger.error(
                "[SandboxViewImageTool] Failed to read %s: %s", path, e, exc_info=True
            )
            error_msg = f"Failed to read image: {e}"
            await self._emit_tool_status("failed", error_msg)
            return json.dumps({"error": error_msg})
