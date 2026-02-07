# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Built-in filesystem tools for Chat Shell.

This module provides filesystem operation tools that can run in two modes:
- local: Direct filesystem access using shared/utils/filesystem.py
- remote: E2B sandbox access using existing sandbox infrastructure

The mode is determined by SANDBOX_MODE configuration setting.
"""

import json
import logging
from typing import Any, Optional

from langchain_core.callbacks import CallbackManagerForToolRun
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


# Input schemas for tools
class ReadFileInput(BaseModel):
    """Input schema for read_file tool."""

    file_path: str = Field(
        ...,
        description="Absolute or relative path to the file to read",
    )
    format: Optional[str] = Field(
        default="text",
        description="Format to read the file: 'text' (default) or 'bytes'",
    )


class WriteFileInput(BaseModel):
    """Input schema for write_file tool."""

    file_path: str = Field(
        ...,
        description="Absolute or relative path to the file to write",
    )
    content: str = Field(
        ...,
        description="REQUIRED: Content to write to the file. This parameter is mandatory.",
    )
    format: Optional[str] = Field(
        default="text",
        description="Format of content: 'text' (default) or 'bytes' (base64-encoded)",
    )
    create_dirs: Optional[bool] = Field(
        default=True,
        description="Create parent directories if they don't exist (default: True)",
    )


class ListFilesInput(BaseModel):
    """Input schema for list_files tool."""

    path: Optional[str] = Field(
        default="/home/user",
        description="Directory path to list (default: /home/user for remote, workspace root for local)",
    )
    depth: Optional[int] = Field(
        default=1,
        description="Depth of directory listing (default: 1). Use higher values for recursive listing.",
    )


class ExecuteCommandInput(BaseModel):
    """Input schema for exec tool."""

    command: str = Field(
        ...,
        description="The command to execute",
    )
    working_dir: Optional[str] = Field(
        default=None,
        description="Working directory for command execution",
    )
    timeout_seconds: Optional[int] = Field(
        default=None,
        description="Command timeout in seconds (overrides default)",
    )


class BaseFilesystemTool(BaseTool):
    """Base class for filesystem tools with dual-mode support.

    Supports both local filesystem operations and remote sandbox operations
    based on the sandbox_mode setting.

    Attributes:
        sandbox_mode: "local" or "remote"
        workspace_root: Base directory for local mode operations
        max_file_size: Maximum file size for read operations
        max_output_size: Maximum output size for command execution
        command_timeout: Default command timeout in seconds
        task_id: Task ID for sandbox operations
        subtask_id: Subtask ID for sandbox operations
        user_id: User ID for sandbox operations
        user_name: Username for sandbox operations
        ws_emitter: WebSocket emitter for status updates
        bot_config: Bot configuration list
        auth_token: API auth token
    """

    # Mode configuration
    sandbox_mode: str = "remote"  # "local" or "remote"
    workspace_root: str = "/workspace"
    max_file_size: int = 102400  # 100KB
    max_output_size: int = 65536  # 64KB
    command_timeout: int = 300  # 5 minutes

    # Sandbox dependencies (for remote mode)
    task_id: int = 0
    subtask_id: int = 0
    user_id: int = 0
    user_name: str = ""
    ws_emitter: Any = None
    bot_config: list = []
    auth_token: str = ""
    default_shell_type: str = "ClaudeCode"

    class Config:
        arbitrary_types_allowed = True

    def _format_error(self, error_message: str, **kwargs) -> str:
        """Format error response as JSON string."""
        response = {
            "success": False,
            "error": error_message,
        }
        response.update(kwargs)
        return json.dumps(response, ensure_ascii=False, indent=2)

    def _get_sandbox_manager(self):
        """Get sandbox manager for remote mode operations."""
        from chat_shell.tools.sandbox import SandboxManager

        return SandboxManager.get_instance(
            task_id=self.task_id,
            user_id=self.user_id,
            user_name=self.user_name,
            bot_config=self.bot_config,
            auth_token=self.auth_token,
        )

    async def _emit_tool_status(
        self, status: str, message: str = "", result: dict = None
    ) -> None:
        """Emit tool status update to frontend via WebSocket."""
        if not self.ws_emitter:
            return

        try:
            tool_output = {"message": message}
            if result:
                tool_output.update(result)

            await self.ws_emitter.emit_tool_call(
                task_id=self.task_id,
                tool_name=self.name,
                tool_input={},
                tool_output=tool_output,
                status=status,
            )
        except Exception as e:
            logger.warning(f"[{self.__class__.__name__}] Failed to emit tool status: {e}")


class ReadFileTool(BaseFilesystemTool):
    """Tool for reading files from local filesystem or remote sandbox."""

    name: str = "read_file"
    display_name: str = "Read File"
    description: str = """Read the contents of a file.

Use this tool to read files from the filesystem.

Parameters:
- file_path (required): Path to the file (absolute or relative)
- format (optional): Read format - 'text' (default) or 'bytes'

Size Limits:
- Text files: Maximum 100KB (102400 bytes)
- Binary files: Maximum 32KB (32768 bytes)

Returns:
- success: Whether the file was read successfully
- content: File contents as string (or base64 for bytes)
- size: File size in bytes
- path: Absolute path to the file
- format: Format used for reading

Example:
{
  "file_path": "/path/to/file.txt",
  "format": "text"
}"""

    args_schema: type[BaseModel] = ReadFileInput

    def _run(
        self,
        file_path: str,
        format: Optional[str] = "text",
        run_manager: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """Synchronous run - not implemented."""
        raise NotImplementedError("ReadFileTool only supports async execution")

    async def _arun(
        self,
        file_path: str,
        format: Optional[str] = "text",
        run_manager: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """Read file from filesystem or sandbox."""
        logger.info(
            f"[ReadFileTool] Reading file: {file_path}, format={format}, "
            f"mode={self.sandbox_mode}"
        )

        if self.sandbox_mode == "local":
            return await self._read_local(file_path, format)
        else:
            return await self._read_remote(file_path, format)

    async def _read_local(self, file_path: str, format: str) -> str:
        """Read file from local filesystem."""
        from shared.utils.filesystem import read_file

        result = await read_file(
            file_path=file_path,
            format=format,
            max_size=self.max_file_size,
            base_dir=self.workspace_root,
        )

        if result["success"]:
            await self._emit_tool_status(
                "completed",
                f"File read successfully ({result['size']} bytes)",
                result,
            )
        else:
            await self._emit_tool_status("failed", result.get("error", "Unknown error"))

        return json.dumps(result, ensure_ascii=False, indent=2)

    async def _read_remote(self, file_path: str, format: str) -> str:
        """Read file from remote sandbox using E2B SDK."""
        import base64

        try:
            sandbox_manager = self._get_sandbox_manager()
            sandbox, error = await sandbox_manager.get_or_create_sandbox(
                shell_type=self.default_shell_type,
                workspace_ref=None,
            )

            if error:
                return self._format_error(
                    f"Failed to create sandbox: {error}",
                    content="",
                    size=0,
                    path="",
                )

            # Normalize path for sandbox
            if not file_path.startswith("/"):
                file_path = f"/home/user/{file_path}"

            # Get file info
            try:
                file_info = await sandbox.files.get_info(file_path)
            except Exception:
                return self._format_error(
                    f"File not found: {file_path}",
                    content="",
                    size=0,
                    path=file_path,
                )

            # Check file type
            if file_info.type and file_info.type.value != "file":
                return self._format_error(
                    f"Path is a {file_info.type.value}, not a file",
                    content="",
                    size=0,
                    path=file_path,
                )

            # Check file size
            file_size = file_info.size
            max_size = 32768 if format == "bytes" else self.max_file_size
            if file_size > max_size:
                return self._format_error(
                    f"File too large: {file_size} bytes. Maximum: {max_size} bytes.",
                    content="",
                    size=file_size,
                    path=file_path,
                )

            # Read file
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

            await self._emit_tool_status(
                "completed",
                f"File read successfully ({file_size} bytes)",
                response,
            )

            return json.dumps(response, ensure_ascii=False, indent=2)

        except ImportError as e:
            logger.error(f"[ReadFileTool] E2B SDK import error: {e}")
            return self._format_error(
                "E2B SDK not available. Please install e2b-code-interpreter.",
                content="",
                size=0,
                path="",
            )
        except Exception as e:
            logger.error(f"[ReadFileTool] Read failed: {e}", exc_info=True)
            return self._format_error(
                f"Failed to read file: {e}",
                content="",
                size=0,
                path="",
            )


class WriteFileTool(BaseFilesystemTool):
    """Tool for writing files to local filesystem or remote sandbox."""

    name: str = "write_file"
    display_name: str = "Write File"
    description: str = """Write content to a file.

Use this tool to create or overwrite files in the filesystem.

IMPORTANT: Both file_path AND content are REQUIRED parameters.

Parameters:
- file_path (REQUIRED): Path to the file (absolute or relative)
- content (REQUIRED): Content to write (text or base64-encoded bytes)
- format (optional): Content format - 'text' (default) or 'bytes'
- create_dirs (optional): Create parent directories if needed (default: True)

Returns:
- success: Whether the file was written successfully
- path: Absolute path to the file
- size: Number of bytes written
- format: Format used for writing

Example:
{
  "file_path": "/path/to/file.txt",
  "content": "Hello, World!",
  "format": "text"
}"""

    args_schema: type[BaseModel] = WriteFileInput

    def _run(
        self,
        file_path: str,
        content: str,
        format: Optional[str] = "text",
        create_dirs: Optional[bool] = True,
        run_manager: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """Synchronous run - not implemented."""
        raise NotImplementedError("WriteFileTool only supports async execution")

    async def _arun(
        self,
        file_path: str,
        content: str,
        format: Optional[str] = "text",
        create_dirs: Optional[bool] = True,
        run_manager: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """Write file to filesystem or sandbox."""
        # Validate content
        if not content:
            error_msg = (
                "Missing required parameter 'content'. "
                "You MUST provide content to write to the file."
            )
            await self._emit_tool_status("failed", error_msg)
            return self._format_error(error_msg, path=file_path, size=0)

        logger.info(
            f"[WriteFileTool] Writing file: {file_path}, format={format}, "
            f"mode={self.sandbox_mode}"
        )

        if self.sandbox_mode == "local":
            return await self._write_local(file_path, content, format, create_dirs)
        else:
            return await self._write_remote(file_path, content, format, create_dirs)

    async def _write_local(
        self, file_path: str, content: str, format: str, create_dirs: bool
    ) -> str:
        """Write file to local filesystem."""
        from shared.utils.filesystem import write_file

        result = await write_file(
            file_path=file_path,
            content=content,
            format=format,
            create_dirs=create_dirs,
            base_dir=self.workspace_root,
        )

        if result["success"]:
            await self._emit_tool_status(
                "completed",
                f"File written successfully ({result['size']} bytes)",
                result,
            )
        else:
            await self._emit_tool_status("failed", result.get("error", "Unknown error"))

        return json.dumps(result, ensure_ascii=False, indent=2)

    async def _write_remote(
        self, file_path: str, content: str, format: str, create_dirs: bool
    ) -> str:
        """Write file to remote sandbox using E2B SDK."""
        import base64
        import os

        try:
            sandbox_manager = self._get_sandbox_manager()
            sandbox, error = await sandbox_manager.get_or_create_sandbox(
                shell_type=self.default_shell_type,
                workspace_ref=None,
            )

            if error:
                return self._format_error(
                    f"Failed to create sandbox: {error}",
                    path="",
                    size=0,
                )

            # Normalize path for sandbox
            if not file_path.startswith("/"):
                file_path = f"/home/user/{file_path}"

            # Prepare content
            if format == "bytes":
                try:
                    content_bytes = base64.b64decode(content)
                except Exception as e:
                    return self._format_error(
                        f"Invalid base64 content: {e}",
                        path="",
                        size=0,
                    )
            else:
                content_bytes = content.encode("utf-8")

            # Create parent directories if needed
            if create_dirs:
                parent_dir = os.path.dirname(file_path)
                if parent_dir and parent_dir != "/":
                    try:
                        await sandbox.files.make_dir(parent_dir)
                    except Exception:
                        pass  # Directory might already exist

            # Write file
            if format == "bytes":
                await sandbox.files.write(file_path, content_bytes)
            else:
                await sandbox.files.write(file_path, content)

            # Get file info
            file_info = await sandbox.files.get_info(file_path)

            response = {
                "success": True,
                "path": file_path,
                "size": file_info.size,
                "format": format,
                "modified_time": file_info.modified_time.isoformat(),
                "sandbox_id": sandbox.sandbox_id,
            }

            await self._emit_tool_status(
                "completed",
                f"File written successfully ({file_info.size} bytes)",
                response,
            )

            return json.dumps(response, ensure_ascii=False, indent=2)

        except ImportError as e:
            logger.error(f"[WriteFileTool] E2B SDK import error: {e}")
            return self._format_error(
                "E2B SDK not available. Please install e2b-code-interpreter.",
                path="",
                size=0,
            )
        except Exception as e:
            logger.error(f"[WriteFileTool] Write failed: {e}", exc_info=True)
            return self._format_error(
                f"Failed to write file: {e}",
                path="",
                size=0,
            )


class ListFilesTool(BaseFilesystemTool):
    """Tool for listing files in local filesystem or remote sandbox."""

    name: str = "list_files"
    display_name: str = "List Files"
    description: str = """List files and directories.

Use this tool to explore the filesystem structure.

Parameters:
- path (optional): Directory to list (default: workspace root for local, /home/user for remote)
- depth (optional): Depth of directory listing (default: 1)

Returns:
- success: Whether the listing was successful
- entries: List of file/directory entries with metadata
- total: Total number of entries

Example:
{
  "path": "/workspace",
  "depth": 2
}"""

    args_schema: type[BaseModel] = ListFilesInput

    def _run(
        self,
        path: Optional[str] = None,
        depth: Optional[int] = 1,
        run_manager: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """Synchronous run - not implemented."""
        raise NotImplementedError("ListFilesTool only supports async execution")

    async def _arun(
        self,
        path: Optional[str] = None,
        depth: Optional[int] = 1,
        run_manager: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """List files in filesystem or sandbox."""
        # Use default path based on mode
        if path is None:
            path = self.workspace_root if self.sandbox_mode == "local" else "/home/user"

        logger.info(
            f"[ListFilesTool] Listing: {path}, depth={depth}, mode={self.sandbox_mode}"
        )

        if self.sandbox_mode == "local":
            return await self._list_local(path, depth)
        else:
            return await self._list_remote(path, depth)

    async def _list_local(self, path: str, depth: int) -> str:
        """List files in local filesystem."""
        from shared.utils.filesystem import list_files

        result = await list_files(
            directory=path,
            depth=depth,
            base_dir=self.workspace_root,
        )

        if result["success"]:
            await self._emit_tool_status(
                "completed",
                f"Listed {result['total']} entries",
                result,
            )
        else:
            await self._emit_tool_status("failed", result.get("error", "Unknown error"))

        return json.dumps(result, ensure_ascii=False, indent=2)

    async def _list_remote(self, path: str, depth: int) -> str:
        """List files in remote sandbox using E2B SDK."""
        try:
            sandbox_manager = self._get_sandbox_manager()
            sandbox, error = await sandbox_manager.get_or_create_sandbox(
                shell_type=self.default_shell_type,
                workspace_ref=None,
            )

            if error:
                return self._format_error(
                    f"Failed to create sandbox: {error}",
                    entries=[],
                    total=0,
                    path="",
                )

            # Normalize path for sandbox
            if not path.startswith("/"):
                path = f"/home/user/{path}"

            # List files
            entries = await sandbox.files.list(path=path, depth=depth)

            # Convert to JSON-serializable format
            entries_data = []
            for entry in entries:
                entry_dict = {
                    "name": entry.name,
                    "path": entry.path,
                    "type": entry.type.value if entry.type else None,
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

            await self._emit_tool_status(
                "completed",
                f"Listed {len(entries_data)} entries",
                response,
            )

            return json.dumps(response, ensure_ascii=False, indent=2)

        except ImportError as e:
            logger.error(f"[ListFilesTool] E2B SDK import error: {e}")
            return self._format_error(
                "E2B SDK not available. Please install e2b-code-interpreter.",
                entries=[],
                total=0,
                path="",
            )
        except Exception as e:
            logger.error(f"[ListFilesTool] List failed: {e}", exc_info=True)
            return self._format_error(
                f"Failed to list files: {e}",
                entries=[],
                total=0,
                path="",
            )


class ExecuteCommandTool(BaseFilesystemTool):
    """Tool for executing commands in local environment or remote sandbox."""

    name: str = "exec"
    display_name: str = "Execute Command"
    description: str = """Execute a shell command.

Use this tool to run shell commands in the environment.

Parameters:
- command (required): The command to execute
- working_dir (optional): Working directory for execution
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
  "working_dir": "/workspace"
}"""

    args_schema: type[BaseModel] = ExecuteCommandInput

    def _run(
        self,
        command: str,
        working_dir: Optional[str] = None,
        timeout_seconds: Optional[int] = None,
        run_manager: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """Synchronous run - not implemented."""
        raise NotImplementedError("ExecuteCommandTool only supports async execution")

    async def _arun(
        self,
        command: str,
        working_dir: Optional[str] = None,
        timeout_seconds: Optional[int] = None,
        run_manager: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """Execute command in local environment or sandbox."""
        effective_timeout = timeout_seconds or self.command_timeout
        effective_cwd = working_dir or self.workspace_root

        logger.info(
            f"[ExecuteCommandTool] Executing: {command[:100]}, "
            f"mode={self.sandbox_mode}"
        )

        if self.sandbox_mode == "local":
            return await self._exec_local(command, effective_cwd, effective_timeout)
        else:
            return await self._exec_remote(command, effective_cwd, effective_timeout)

    async def _exec_local(self, command: str, cwd: str, timeout: int) -> str:
        """Execute command in local environment."""
        from shared.utils.filesystem import execute_command

        result = await execute_command(
            command=command,
            timeout=timeout,
            cwd=cwd,
            max_output_size=self.max_output_size,
        )

        if result["success"]:
            await self._emit_tool_status(
                "completed",
                "Command executed successfully",
                result,
            )
        else:
            await self._emit_tool_status(
                "failed",
                f"Command failed with exit code {result.get('exit_code', -1)}",
                result,
            )

        return json.dumps(result, ensure_ascii=False, indent=2)

    async def _exec_remote(self, command: str, cwd: str, timeout: int) -> str:
        """Execute command in remote sandbox using E2B SDK."""
        import re
        import time

        start_time = time.time()

        # Shell operators pattern for wrapping
        shell_operators = re.compile(
            r"&&|\|\||"
            r"\|(?!\|)|"
            r";|>>|>|<<|<|"
            r"\$\(|`"
        )

        # Wrap command if contains shell operators
        if shell_operators.search(command):
            escaped = command.replace("'", "'\"'\"'")
            command = f"bash -c '{escaped}'"

        try:
            sandbox_manager = self._get_sandbox_manager()
            sandbox, error = await sandbox_manager.get_or_create_sandbox(
                shell_type=self.default_shell_type,
                workspace_ref=None,
            )

            if error:
                return self._format_error(
                    f"Failed to create sandbox: {error}",
                    stdout="",
                    stderr=error,
                    exit_code=-1,
                    execution_time=time.time() - start_time,
                )

            # Execute command
            result = await sandbox.commands.run(
                cmd=command,
                cwd=cwd,
                timeout=timeout,
            )

            execution_time = time.time() - start_time

            # Truncate output if needed
            stdout = result.stdout or ""
            stderr = result.stderr or ""
            stdout_truncated = False
            stderr_truncated = False

            if len(stdout) > self.max_output_size:
                stdout = stdout[: self.max_output_size]
                stdout_truncated = True

            if len(stderr) > self.max_output_size:
                stderr = stderr[: self.max_output_size]
                stderr_truncated = True

            response = {
                "success": result.exit_code == 0,
                "stdout": stdout,
                "stderr": stderr,
                "exit_code": result.exit_code,
                "execution_time": execution_time,
                "sandbox_id": sandbox.sandbox_id,
            }

            if stdout_truncated or stderr_truncated:
                response["truncated"] = True
                response["truncation_info"] = {
                    "stdout_truncated": stdout_truncated,
                    "stderr_truncated": stderr_truncated,
                    "max_output_size": self.max_output_size,
                }

            if result.exit_code == 0:
                await self._emit_tool_status(
                    "completed",
                    "Command executed successfully",
                    response,
                )
            else:
                await self._emit_tool_status(
                    "failed",
                    f"Command failed with exit code {result.exit_code}",
                    response,
                )

            return json.dumps(response, ensure_ascii=False, indent=2)

        except ImportError as e:
            logger.error(f"[ExecuteCommandTool] E2B SDK import error: {e}")
            return self._format_error(
                "E2B SDK not available. Please install e2b-code-interpreter.",
                stdout="",
                stderr="",
                exit_code=-1,
                execution_time=time.time() - start_time,
            )
        except Exception as e:
            logger.error(f"[ExecuteCommandTool] Execution failed: {e}", exc_info=True)
            return self._format_error(
                f"Command execution failed: {e}",
                stdout="",
                stderr=str(e),
                exit_code=-1,
                execution_time=time.time() - start_time,
            )


def get_filesystem_tools(
    sandbox_mode: str = "remote",
    workspace_root: str = "/workspace",
    max_file_size: int = 102400,
    max_output_size: int = 65536,
    command_timeout: int = 300,
    task_id: int = 0,
    subtask_id: int = 0,
    user_id: int = 0,
    user_name: str = "",
    ws_emitter: Any = None,
    bot_config: list = None,
    auth_token: str = "",
    default_shell_type: str = "ClaudeCode",
) -> list[BaseTool]:
    """Create filesystem tools with the specified configuration.

    Args:
        sandbox_mode: "local" or "remote" (default: "remote")
        workspace_root: Base directory for local mode
        max_file_size: Maximum file size for read operations
        max_output_size: Maximum output size for command execution
        command_timeout: Default command timeout in seconds
        task_id: Task ID for sandbox operations
        subtask_id: Subtask ID for sandbox operations
        user_id: User ID for sandbox operations
        user_name: Username for sandbox operations
        ws_emitter: WebSocket emitter for status updates
        bot_config: Bot configuration list
        auth_token: API auth token
        default_shell_type: Default shell type for sandbox

    Returns:
        List of configured filesystem tools
    """
    common_kwargs = {
        "sandbox_mode": sandbox_mode,
        "workspace_root": workspace_root,
        "max_file_size": max_file_size,
        "max_output_size": max_output_size,
        "command_timeout": command_timeout,
        "task_id": task_id,
        "subtask_id": subtask_id,
        "user_id": user_id,
        "user_name": user_name,
        "ws_emitter": ws_emitter,
        "bot_config": bot_config or [],
        "auth_token": auth_token,
        "default_shell_type": default_shell_type,
    }

    return [
        ReadFileTool(**common_kwargs),
        WriteFileTool(**common_kwargs),
        ListFilesTool(**common_kwargs),
        ExecuteCommandTool(**common_kwargs),
    ]


__all__ = [
    "ReadFileTool",
    "WriteFileTool",
    "ListFilesTool",
    "ExecuteCommandTool",
    "get_filesystem_tools",
    "BaseFilesystemTool",
]
