# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Sandbox command execution tool using E2B SDK.

This module provides the SandboxCommandTool class that executes
commands in an isolated sandbox environment.
"""

import asyncio
import json
import logging
import time
from typing import Optional

from langchain_core.callbacks import CallbackManagerForToolRun
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


class SandboxCommandInput(BaseModel):
    """Input schema for sandbox_command tool."""

    command: str = Field(
        ...,
        description="The command to execute in the sandbox environment",
    )
    working_dir: Optional[str] = Field(
        default="/home/user",
        description="Working directory for command execution (default: /home/user)",
    )
    timeout_seconds: Optional[int] = Field(
        default=None,
        description="Command timeout in seconds (overrides default)",
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


class SandboxCommandTool(BaseSandboxTool):
    """Tool for executing commands in E2B sandbox.

    This tool provides direct command execution in an isolated
    sandbox environment using the E2B SDK.
    """

    name: str = "sandbox_command"
    display_name: str = "执行命令"
    description: str = """Execute a command in an isolated sandbox environment.

Use this tool to run shell commands safely in a containerized environment.

Parameters:
- command (required): The command to execute
- working_dir (optional): Working directory (default: /home/user)
- timeout_seconds (optional): Command timeout in seconds

Returns:
- success: Whether the command executed successfully
- stdout: Standard output from the command
- stderr: Standard error output
- exit_code: Command exit code
- execution_time: Time taken to execute

Example:
{
  "command": "ls -la",
  "working_dir": "/home/user"
}"""

    args_schema: type[BaseModel] = SandboxCommandInput

    # Default command timeout (5 minutes)
    default_command_timeout: int = 300

    def _run(
        self,
        command: str,
        working_dir: Optional[str] = "/home/user",
        timeout_seconds: Optional[int] = None,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Synchronous run - not implemented."""
        raise NotImplementedError("SandboxCommandTool only supports async execution")

    async def _arun(
        self,
        command: str,
        working_dir: Optional[str] = "/home/user",
        timeout_seconds: Optional[int] = None,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Execute command in E2B sandbox.

        Args:
            command: Command to execute
            working_dir: Working directory for execution
            timeout_seconds: Command timeout in seconds
            run_manager: Callback manager

        Returns:
            JSON string with execution result
        """
        start_time = time.time()
        effective_timeout = timeout_seconds or self.default_command_timeout

        logger.info(
            f"[SandboxCommandTool] Executing command: {command[:100]}, "
            f"working_dir={working_dir}, timeout={effective_timeout}s"
        )

        # Emit status update via WebSocket if available
        if self.ws_emitter:
            try:
                await self.ws_emitter.emit_tool_call(
                    task_id=self.task_id,
                    tool_name=self.name,
                    tool_input={
                        "command": (
                            command[:200] + "..." if len(command) > 200 else command
                        ),
                        "working_dir": working_dir,
                    },
                    status="running",
                )
            except Exception as e:
                logger.warning(f"[SandboxCommandTool] Failed to emit tool status: {e}")

        try:
            # Get sandbox manager from base class
            sandbox_manager = self._get_sandbox_manager()

            # Get or create sandbox
            logger.info(f"[SandboxCommandTool] Getting or creating sandbox...")
            sandbox, error = await sandbox_manager.get_or_create_sandbox(
                shell_type=self.default_shell_type,
                workspace_ref=None,
            )

            if error:
                logger.error(f"[SandboxCommandTool] Failed to create sandbox: {error}")
                result = self._format_error(
                    error_message=f"Failed to create sandbox: {error}",
                    stdout="",
                    stderr=error,
                    exit_code=-1,
                    execution_time=time.time() - start_time,
                    suggestion=(
                        "The command could not be executed because the sandbox failed to start. "
                        "Check the command syntax and ensure the sandbox is available."
                    ),
                )
                await self._emit_tool_status("failed", error)
                return result

            logger.info(
                f"[SandboxCommandTool] Running command in sandbox {sandbox.sandbox_id}"
            )

            # Execute command using sandbox.commands API with async
            result = await sandbox.commands.run(
                cmd=command,
                cwd=working_dir,
                timeout=effective_timeout,
            )

            execution_time = time.time() - start_time

            response = {
                "success": result.exit_code == 0,
                "stdout": result.stdout or "",
                "stderr": result.stderr or "",
                "exit_code": result.exit_code,
                "execution_time": execution_time,
                "sandbox_id": sandbox.sandbox_id,
            }

            logger.info(
                f"[SandboxCommandTool] Command completed: exit_code={result.exit_code}, "
                f"time={execution_time:.2f}s"
            )

            # Emit success/failure status
            if result.exit_code == 0:
                await self._emit_tool_status(
                    "completed", "Command executed successfully", response
                )
            else:
                await self._emit_tool_status(
                    "failed",
                    f"Command failed with exit code {result.exit_code}",
                    response,
                )

            return json.dumps(response, ensure_ascii=False, indent=2)

        except ImportError as e:
            logger.error(f"[SandboxCommandTool] E2B SDK import error: {e}")
            error_msg = "E2B SDK not available. Please install e2b-code-interpreter."
            result = self._format_error(
                error_message=error_msg,
                stdout="",
                stderr=error_msg,
                exit_code=-1,
                execution_time=time.time() - start_time,
                suggestion=(
                    "The command could not be executed. "
                    "Check the command syntax and ensure the sandbox is available."
                ),
            )
            await self._emit_tool_status("failed", error_msg)
            return result
        except Exception as e:
            logger.error(f"[SandboxCommandTool] Execution failed: {e}", exc_info=True)
            error_msg = f"Command execution failed: {e}"
            result = self._format_error(
                error_message=error_msg,
                stdout="",
                stderr=str(e),
                exit_code=-1,
                execution_time=time.time() - start_time,
                suggestion=(
                    "The command could not be executed. "
                    "Check the command syntax and ensure the sandbox is available."
                ),
            )
            await self._emit_tool_status("failed", error_msg)
            return result
