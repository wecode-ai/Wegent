# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Sandbox file removal tool using E2B SDK.

This module provides the SandboxRemoveFileTool class that removes
files or directories in the sandbox environment.
"""

import asyncio
import json
import logging
from typing import Optional

from langchain_core.callbacks import CallbackManagerForToolRun
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


class SandboxRemoveFileInput(BaseModel):
    """Input schema for sandbox_remove_file tool."""

    path: str = Field(
        ...,
        description="Path to the file or directory to remove",
    )


# Import base class here - use try/except to handle both direct and dynamic loading
try:
    # Try relative import (for direct usage)
    from ._base import BaseSubAgentTool
except ImportError:
    # Try absolute import (for dynamic loading as skill_pkg_subagent)
    import sys

    # Get the package name dynamically
    package_name = __name__.rsplit(".", 1)[0]  # e.g., 'skill_pkg_subagent'
    _base_module = sys.modules.get(f"{package_name}._base")
    if _base_module:
        BaseSubAgentTool = _base_module.BaseSubAgentTool
    else:
        raise ImportError(f"Cannot import _base from {package_name}")


class SandboxRemoveFileTool(BaseSubAgentTool):
    """Tool for removing files/directories in E2B sandbox.

    This tool removes files or directories using the
    E2B SDK's filesystem API.
    """

    name: str = "sandbox_remove_file"
    display_name: str = "Remove File/Directory"
    description: str = """Remove a file or directory from the sandbox.

Use this tool to delete files or directories. Directories are removed recursively.

Parameters:
- path (required): Path to remove (absolute or relative to /home/user)

Returns:
- success: Whether the removal was successful
- path: Absolute path that was removed
- message: Success message

Example:
{
  "path": "/home/user/old_data.txt"
}"""

    args_schema: type[BaseModel] = SandboxRemoveFileInput

    def _run(
        self,
        path: str,
        run_manager: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """Synchronous run - not implemented."""
        raise NotImplementedError("SandboxRemoveFileTool only supports async execution")

    async def _arun(
        self,
        path: str,
        run_manager: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """Remove file/directory from E2B sandbox.

        Args:
            path: Path to remove
            run_manager: Callback manager

        Returns:
            JSON string with removal result
        """
        logger.info(f"[SandboxRemoveFileTool] Removing path: {path}")

        # Emit status update via WebSocket if available
        if self.ws_emitter:
            try:
                await self.ws_emitter.emit_tool_call(
                    task_id=self.task_id,
                    tool_name=self.name,
                    tool_input={
                        "path": path,
                    },
                    status="running",
                )
            except Exception as e:
                logger.warning(
                    f"[SandboxRemoveFileTool] Failed to emit tool status: {e}"
                )

        try:
            # Get sandbox manager from base class
            sandbox_manager = self._get_sandbox_manager()

            # Get or create sandbox
            logger.info(f"[SandboxRemoveFileTool] Getting or creating sandbox...")
            sandbox, error = await sandbox_manager.get_or_create_sandbox(
                shell_type=self.default_shell_type,
                workspace_ref=None,
                task_type="remove_file",
            )

            if error:
                logger.error(
                    f"[SandboxRemoveFileTool] Failed to create sandbox: {error}"
                )
                result = self._format_error(
                    error_message=f"Failed to create sandbox: {error}",
                    path="",
                    message="",
                )
                await self._emit_tool_status("failed", error)
                return result

            # Normalize path
            if not path.startswith("/"):
                path = f"/home/user/{path}"

            logger.info(
                f"[SandboxRemoveFileTool] Removing path in sandbox {sandbox.sandbox_id}"
            )

            # Remove file/directory using native API
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(
                None,
                lambda: sandbox.files.remove(path=path),
            )

            response = {
                "success": True,
                "path": path,
                "message": "File or directory removed successfully",
                "sandbox_id": sandbox.sandbox_id,
            }

            logger.info(f"[SandboxRemoveFileTool] Removed: {path}")

            # Emit success status
            await self._emit_tool_status(
                "completed",
                "File or directory removed successfully",
                response,
            )

            return json.dumps(response, ensure_ascii=False, indent=2)

        except ImportError as e:
            logger.error(f"[SandboxRemoveFileTool] E2B SDK import error: {e}")
            error_msg = "E2B SDK not available. Please install e2b-code-interpreter."
            result = self._format_error(
                error_message=error_msg,
                path="",
                message="",
            )
            await self._emit_tool_status("failed", error_msg)
            return result
        except Exception as e:
            logger.error(f"[SandboxRemoveFileTool] Remove failed: {e}", exc_info=True)
            error_msg = f"Failed to remove file or directory: {e}"
            result = self._format_error(
                error_message=error_msg,
                path="",
                message="",
            )
            await self._emit_tool_status("failed", error_msg)
            return result
