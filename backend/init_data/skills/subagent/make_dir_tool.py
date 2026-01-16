# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Sandbox directory creation tool using E2B SDK.

This module provides the SandboxMakeDirTool class that creates
directories in the sandbox environment.
"""

import asyncio
import json
import logging
from typing import Optional

from langchain_core.callbacks import CallbackManagerForToolRun
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


class SandboxMakeDirInput(BaseModel):
    """Input schema for sandbox_make_dir tool."""

    path: str = Field(
        ...,
        description="Path to the directory to create",
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


class SandboxMakeDirTool(BaseSubAgentTool):
    """Tool for creating directories in E2B sandbox.

    This tool creates directories (including parent directories if needed)
    using the E2B SDK's filesystem API.
    """

    name: str = "sandbox_make_dir"
    display_name: str = "Create Directory"
    description: str = """Create a new directory in the sandbox.

Use this tool to create directories. Parent directories will be created automatically if needed.

Parameters:
- path (required): Path to the directory to create (absolute or relative to /home/user)

Returns:
- success: Whether the directory was created
- path: Absolute path of the created directory
- message: Success message
- created: True if created, False if already exists

Example:
{
  "path": "/home/user/data/output"
}"""

    args_schema: type[BaseModel] = SandboxMakeDirInput

    def _run(
        self,
        path: str,
        run_manager: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """Synchronous run - not implemented."""
        raise NotImplementedError("SandboxMakeDirTool only supports async execution")

    async def _arun(
        self,
        path: str,
        run_manager: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """Create directory in E2B sandbox.

        Args:
            path: Path to create
            run_manager: Callback manager

        Returns:
            JSON string with creation result
        """
        logger.info(f"[SandboxMakeDirTool] Creating directory: {path}")

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
                logger.warning(f"[SandboxMakeDirTool] Failed to emit tool status: {e}")

        try:
            # Get sandbox manager from base class
            sandbox_manager = self._get_sandbox_manager()

            # Get or create sandbox
            logger.info(f"[SandboxMakeDirTool] Getting or creating sandbox...")
            sandbox, error = await sandbox_manager.get_or_create_sandbox(
                shell_type=self.default_shell_type,
                workspace_ref=None,
                task_type="make_dir",
            )

            if error:
                logger.error(f"[SandboxMakeDirTool] Failed to create sandbox: {error}")
                result = self._format_error(
                    error_message=f"Failed to create sandbox: {error}",
                    path="",
                    message="",
                    created=False,
                )
                await self._emit_tool_status("failed", error)
                return result

            # Normalize path
            if not path.startswith("/"):
                path = f"/home/user/{path}"

            logger.info(
                f"[SandboxMakeDirTool] Creating directory in sandbox {sandbox.sandbox_id}"
            )

            # Create directory using native API
            # Returns True if created, False if already exists
            loop = asyncio.get_event_loop()
            created = await loop.run_in_executor(
                None,
                lambda: sandbox.files.make_dir(path=path),
            )

            response = {
                "success": True,
                "path": path,
                "message": (
                    "Directory created successfully"
                    if created
                    else "Directory already exists"
                ),
                "created": created,
                "sandbox_id": sandbox.sandbox_id,
            }

            logger.info(
                f"[SandboxMakeDirTool] Directory {'created' if created else 'already exists'}: {path}"
            )

            # Emit success status
            await self._emit_tool_status(
                "completed",
                f"Directory {'created' if created else 'already exists'}",
                response,
            )

            return json.dumps(response, ensure_ascii=False, indent=2)

        except ImportError as e:
            logger.error(f"[SandboxMakeDirTool] E2B SDK import error: {e}")
            error_msg = "E2B SDK not available. Please install e2b-code-interpreter."
            result = self._format_error(
                error_message=error_msg,
                path="",
                message="",
                created=False,
            )
            await self._emit_tool_status("failed", error_msg)
            return result
        except Exception as e:
            logger.error(f"[SandboxMakeDirTool] Create failed: {e}", exc_info=True)
            error_msg = f"Failed to create directory: {e}"
            result = self._format_error(
                error_message=error_msg,
                path="",
                message="",
                created=False,
            )
            await self._emit_tool_status("failed", error_msg)
            return result
