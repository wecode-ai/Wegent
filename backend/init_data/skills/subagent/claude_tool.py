# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Sandbox Claude command execution tool using E2B SDK.

This module provides the SandboxClaudeTool class that executes
Claude commands in an isolated sandbox environment with streaming output.
"""

import asyncio
import json
import logging
import re
import time
from typing import Optional

from langchain_core.callbacks import CallbackManagerForToolRun
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


class SandboxClaudeInput(BaseModel):
    """Input schema for sandbox_claude tool."""

    prompt: str = Field(
        ...,
        description="The task prompt to send to Claude",
    )
    allowed_tools: Optional[str] = Field(
        default="Edit,Write,MultiEdit,Bash(*),skills,Read,Glob,Grep,LS",
        description="Comma-separated list of allowed tools for Claude to use",
    )
    append_system_prompt: Optional[str] = Field(
        default=None,
        description="Additional system prompt to append to Claude's instructions",
    )
    working_dir: Optional[str] = Field(
        default="/home/user",
        description="Working directory for Claude execution (default: /home/user)",
    )
    timeout_seconds: Optional[int] = Field(
        default=None,
        description="Command timeout in seconds (overrides default)",
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


class SandboxClaudeTool(BaseSubAgentTool):
    """Tool for executing Claude commands in E2B sandbox with streaming output.

    This tool provides Claude command execution in an isolated
    sandbox environment using the E2B SDK, with support for
    streaming output to frontend via WebSocket.
    """

    name: str = "sandbox_claude"
    display_name: str = "Execute Claude Command"
    description: str = """Execute a Claude command in an isolated sandbox environment with streaming output.

Use this tool to delegate tasks to Claude in a containerized environment, such as generating presentations, writing code, or creating documents.

Parameters:
- prompt (required): The task prompt to send to Claude
- allowed_tools (optional): Comma-separated list of allowed tools (default: "Edit,Write,MultiEdit,Bash(*),skills,Read,Glob,Grep,LS")
- append_system_prompt (optional): Additional instructions for Claude
- working_dir (optional): Working directory (default: /home/user)
- timeout_seconds (optional): Command timeout in seconds

Returns:
- success: Whether the command executed successfully
- output: Combined output from Claude execution
- exit_code: Command exit code
- execution_time: Time taken to execute

Example:
{
  "prompt": "做一个chatgpt相关的ppt,5页左右，介绍chatgpt发展历史",
  "allowed_tools": "Edit,Write,MultiEdit,Bash(*),skills,Read,Glob,Grep,LS",
  "append_system_prompt": "执行任务时：\\n1. 首先检查并读取 .claude/skills/ 目录下的相关技能文件\\n2. 在回复开头明确说明【已加载的 Skill】和【应用的规范】\\n3. 如果没有找到相关 Skill，也请说明"
}"""

    args_schema: type[BaseModel] = SandboxClaudeInput

    # Default command timeout (30 minutes for Claude tasks)
    default_command_timeout: int = 1800

    def _run(
        self,
        prompt: str,
        allowed_tools: Optional[str] = None,
        append_system_prompt: Optional[str] = None,
        working_dir: Optional[str] = "/home/user",
        timeout_seconds: Optional[int] = None,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Synchronous run - not implemented."""
        raise NotImplementedError("SandboxClaudeTool only supports async execution")

    async def _arun(
        self,
        prompt: str,
        allowed_tools: Optional[str] = None,
        append_system_prompt: Optional[str] = None,
        working_dir: Optional[str] = "/home/user",
        timeout_seconds: Optional[int] = None,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Execute Claude command in E2B sandbox with streaming output.

        Args:
            prompt: Task prompt for Claude
            allowed_tools: Comma-separated list of allowed tools
            append_system_prompt: Additional system prompt
            working_dir: Working directory for execution
            timeout_seconds: Command timeout in seconds
            run_manager: Callback manager

        Returns:
            JSON string with execution result
        """
        start_time = time.time()
        effective_timeout = timeout_seconds or self.default_command_timeout

        logger.info(
            f"[SandboxClaudeTool] Executing Claude command: prompt={prompt[:100]}..., "
            f"working_dir={working_dir}, timeout={effective_timeout}s"
        )

        # Build Claude command
        command_parts = ["claude", "-p", f'"{prompt}"']

        if allowed_tools:
            command_parts.append("--allowedTools")
            command_parts.append(f'"{allowed_tools}"')

        if append_system_prompt:
            # Escape quotes and newlines in system prompt
            escaped_prompt = append_system_prompt.replace('"', '\\"').replace(
                "\n", "\\n"
            )
            command_parts.append("--append-system-prompt")
            command_parts.append(f'"{escaped_prompt}"')

        command_parts.append("--output-format stream-json")
        command_parts.append("--verbose")

        command = " ".join(command_parts)

        logger.info(f"[SandboxClaudeTool] Full command: {command}")

        # Emit status update via WebSocket if available
        if self.ws_emitter:
            try:
                await self.ws_emitter.emit_tool_call(
                    task_id=self.task_id,
                    tool_name=self.name,
                    tool_input={
                        "prompt": prompt[:200] + "..." if len(prompt) > 200 else prompt,
                        "allowed_tools": allowed_tools,
                        "working_dir": working_dir,
                    },
                    status="running",
                )
            except Exception as e:
                logger.warning(f"[SandboxClaudeTool] Failed to emit tool status: {e}")

        try:
            # Get sandbox manager from base class
            sandbox_manager = self._get_sandbox_manager()

            # Get or create sandbox
            logger.info(f"[SandboxClaudeTool] Getting or creating sandbox...")
            sandbox, error = await sandbox_manager.get_or_create_sandbox(
                shell_type=self.default_shell_type,
                workspace_ref=None,
                task_type="claude_command",
            )

            if error:
                logger.error(f"[SandboxClaudeTool] Failed to create sandbox: {error}")
                result = self._format_error(
                    error_message=f"Failed to create sandbox: {error}",
                    output="",
                    exit_code=-1,
                    execution_time=time.time() - start_time,
                    suggestion=(
                        "The Claude command could not be executed because the sandbox failed to start. "
                        "Check the sandbox availability."
                    ),
                )
                await self._emit_tool_status("failed", error)
                return result

            logger.info(
                f"[SandboxClaudeTool] Running Claude command in sandbox {sandbox.sandbox_id}"
            )

            # Execute command using sandbox.commands API
            # Run synchronous command in executor without callbacks to avoid event loop issues
            loop = asyncio.get_event_loop()

            # Start the command without streaming callbacks
            process = await loop.run_in_executor(
                None,
                lambda: sandbox.commands.run(
                    cmd=command,
                    cwd=working_dir,
                    timeout=effective_timeout,
                ),
            )

            execution_time = time.time() - start_time

            # Combine stdout and stderr
            combined_output = ""
            if process.stdout:
                combined_output += process.stdout
                # Parse and emit stdout data after completion
                await self._handle_stream_output_async(process.stdout, "stdout")
            if process.stderr:
                if combined_output:
                    combined_output += "\n"
                combined_output += process.stderr
                # Parse and emit stderr data after completion
                await self._handle_stream_output_async(process.stderr, "stderr")

            response = {
                "success": process.exit_code == 0,
                "output": combined_output,
                "exit_code": process.exit_code,
                "execution_time": execution_time,
                "sandbox_id": sandbox.sandbox_id,
            }

            logger.info(
                f"[SandboxClaudeTool] Claude command completed: exit_code={process.exit_code}, "
                f"time={execution_time:.2f}s"
            )

            # Emit success/failure status
            if process.exit_code == 0:
                await self._emit_tool_status(
                    "completed", "Claude command executed successfully", response
                )
            else:
                await self._emit_tool_status(
                    "failed",
                    f"Claude command failed with exit code {process.exit_code}",
                    response,
                )

            return json.dumps(response, ensure_ascii=False, indent=2)

        except ImportError as e:
            logger.error(f"[SandboxClaudeTool] E2B SDK import error: {e}")
            error_msg = "E2B SDK not available. Please install e2b-code-interpreter."
            result = self._format_error(
                error_message=error_msg,
                output="",
                exit_code=-1,
                execution_time=time.time() - start_time,
                suggestion=(
                    "The Claude command could not be executed. "
                    "Check the sandbox availability."
                ),
            )
            await self._emit_tool_status("failed", error_msg)
            return result
        except Exception as e:
            logger.error(f"[SandboxClaudeTool] Execution failed: {e}", exc_info=True)
            error_msg = f"Claude command execution failed: {e}"
            result = self._format_error(
                error_message=error_msg,
                output="",
                exit_code=-1,
                execution_time=time.time() - start_time,
                suggestion=(
                    "The Claude command could not be executed. "
                    "Check the command syntax and ensure the sandbox is available."
                ),
            )
            await self._emit_tool_status("failed", error_msg)
            return result

    async def _handle_stream_output_async(self, data: str, stream_type: str) -> None:
        """Handle streaming output from Claude command (async version).

        Args:
            data: Output data from the command
            stream_type: Type of stream ("stdout" or "stderr")
        """
        if not data:
            return

        logger.info(f"[SandboxClaudeTool] {stream_type}: {data[:200]}")

        # Try to parse as JSON if it's stream-json format
        try:
            # Split by newlines in case multiple JSON objects
            for line in data.strip().split("\n"):
                if not line.strip():
                    continue

                try:
                    json_data = json.loads(line)
                    # Emit parsed JSON data to frontend
                    await self._emit_stream_data(json_data, stream_type)
                except json.JSONDecodeError:
                    # Not JSON, emit as plain text
                    await self._emit_stream_data(
                        {"type": "text", "content": line}, stream_type
                    )
        except Exception as e:
            logger.warning(f"[SandboxClaudeTool] Failed to parse stream output: {e}")

    async def _emit_stream_data(self, data: dict, stream_type: str) -> None:
        """Emit streaming data to frontend via WebSocket.

        Args:
            data: Parsed data to emit
            stream_type: Type of stream ("stdout" or "stderr")
        """
        if not self.ws_emitter:
            return

        try:
            await self.ws_emitter.emit_tool_call(
                task_id=self.task_id,
                tool_name=self.name,
                tool_input={},
                tool_output={
                    "stream_type": stream_type,
                    "data": data,
                },
                status="streaming",
            )
        except Exception as e:
            logger.warning(f"[SandboxClaudeTool] Failed to emit stream data: {e}")
