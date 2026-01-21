# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Sandbox file listing tool using E2B SDK.

This module provides the SandboxListFilesTool class that lists
files and directories in the sandbox environment.
"""

import asyncio
import json
import logging
from typing import Optional

from langchain_core.callbacks import CallbackManagerForToolRun
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


class SandboxListFilesInput(BaseModel):
    """Input schema for sandbox_list_files tool."""

    path: Optional[str] = Field(
        default="/home/user",
        description="Directory path to list (default: /home/user)",
    )
    depth: Optional[int] = Field(
        default=1,
        description="Depth of directory listing (default: 1). Use higher values for recursive listing.",
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


class SandboxListFilesTool(BaseSandboxTool):
    """Tool for listing files in E2B sandbox.

    This tool lists files and directories in the sandbox filesystem
    using the native E2B filesystem API.
    """

    name: str = "sandbox_list_files"
    display_name: str = "列出文件"
    description: str = """List files and directories in the sandbox environment.

Use this tool to explore the sandbox filesystem structure.

Parameters:
- path (optional): Directory to list (default: /home/user)
- depth (optional): Depth of directory listing (default: 1)

Returns:
- success: Whether the listing was successful
- entries: List of file/directory entries with metadata
  - name: File/directory name
  - path: Absolute path
  - type: "file" or "directory" or "symlink"
  - size: Size in bytes
  - permissions: File permissions
  - owner: File owner
  - group: File group
  - modified_time: Last modified timestamp
- total: Total number of entries

Example:
{
  "path": "/home/user",
  "depth": 2
}"""

    args_schema: type[BaseModel] = SandboxListFilesInput

    def _run(
        self,
        path: Optional[str] = "/home/user",
        depth: Optional[int] = 1,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Synchronous run - not implemented."""
        raise NotImplementedError("SandboxListFilesTool only supports async execution")

    async def _arun(
        self,
        path: Optional[str] = "/home/user",
        depth: Optional[int] = 1,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """List files in E2B sandbox.

        Args:
            path: Directory to list
            depth: Depth of directory listing
            run_manager: Callback manager

        Returns:
            JSON string with file listing
        """
        logger.info(f"[SandboxListFilesTool] Listing directory: {path}, depth={depth}")

        # Emit status update via WebSocket if available
        if self.ws_emitter:
            try:
                await self.ws_emitter.emit_tool_call(
                    task_id=self.task_id,
                    tool_name=self.name,
                    tool_input={
                        "path": path,
                        "depth": depth,
                    },
                    status="running",
                )
            except Exception as e:
                logger.warning(
                    f"[SandboxListFilesTool] Failed to emit tool status: {e}"
                )

        try:
            # Get sandbox manager from base class
            sandbox_manager = self._get_sandbox_manager()

            # Get or create sandbox
            logger.info(f"[SandboxListFilesTool] Getting or creating sandbox...")
            sandbox, error = await sandbox_manager.get_or_create_sandbox(
                shell_type=self.default_shell_type,
                workspace_ref=None,
            )

            if error:
                logger.error(
                    f"[SandboxListFilesTool] Failed to create sandbox: {error}"
                )
                result = self._format_error(
                    error_message=f"Failed to create sandbox: {error}",
                    entries=[],
                    total=0,
                    path="",
                )
                await self._emit_tool_status("failed", error)
                return result

            # Normalize path
            if not path.startswith("/"):
                path = f"/home/user/{path}"

            logger.info(
                f"[SandboxListFilesTool] Listing files in sandbox {sandbox.sandbox_id}"
            )

            # Use native filesystem.list() API with async
            entries = await sandbox.files.list(path=path, depth=depth)

            # Convert entries to JSON-serializable format
            entries_data = []
            for entry in entries:
                entry_dict = {
                    "name": entry.name,
                    "path": entry.path,
                    "type": (
                        entry.type.value if entry.type else None
                    ),  # Convert enum to string
                    "size": entry.size,
                    "permissions": entry.permissions,
                    "owner": entry.owner,
                    "group": entry.group,
                    "modified_time": entry.modified_time.isoformat(),
                }
                if entry.symlink_target:
                    entry_dict["symlink_target"] = entry.symlink_target
                entries_data.append(entry_dict)

            response = {
                "success": True,
                "entries": entries_data,
                "total": len(entries_data),
                "path": path,
                "sandbox_id": sandbox.sandbox_id,
            }

            logger.info(f"[SandboxListFilesTool] Listed {len(entries_data)} entries")

            # Emit success status
            await self._emit_tool_status(
                "completed", f"Listed {len(entries_data)} entries", response
            )

            return json.dumps(response, ensure_ascii=False, indent=2)

        except ImportError as e:
            logger.error(f"[SandboxListFilesTool] E2B SDK import error: {e}")
            error_msg = "E2B SDK not available. Please install e2b-code-interpreter."
            result = self._format_error(
                error_message=error_msg,
                entries=[],
                total=0,
                path="",
            )
            await self._emit_tool_status("failed", error_msg)
            return result
        except Exception as e:
            logger.error(f"[SandboxListFilesTool] List failed: {e}", exc_info=True)
            error_msg = f"Failed to list files: {e}"
            result = self._format_error(
                error_message=error_msg,
                entries=[],
                total=0,
                path="",
            )
            await self._emit_tool_status("failed", error_msg)
            return result
