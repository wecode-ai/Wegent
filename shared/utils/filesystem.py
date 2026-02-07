# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Filesystem utilities for local file operations.

This module provides common file system operations that can be reused
by both executor and chat_shell modules. These utilities support:
- Async file reading and writing
- Directory listing with depth control
- Command execution with timeout and output limits

All functions return a unified JSON-serializable dict format:
{"success": bool, "data": ..., "error": ...}
"""

import asyncio
import base64
import fnmatch
import os
import re
import stat
from datetime import datetime
from pathlib import Path
from typing import Any, Optional, Union

import aiofiles

from shared.logger import setup_logger

logger = setup_logger(__name__)

# Default configuration constants
DEFAULT_MAX_FILE_SIZE = 102400  # 100KB
DEFAULT_MAX_OUTPUT_SIZE = 65536  # 64KB
DEFAULT_COMMAND_TIMEOUT = 300  # 5 minutes
DEFAULT_LIST_DEPTH = 1

# Shell operators that require bash -c wrapping
SHELL_OPERATORS_PATTERN = re.compile(
    r"&&|"  # AND operator
    r"\|\||"  # OR operator
    r"\|(?!\|)|"  # Pipe (but not ||)
    r";|"  # Command separator
    r">>|"  # Append redirect
    r">|"  # Output redirect
    r"<<|"  # Here document
    r"<|"  # Input redirect
    r"\$\(|"  # Command substitution $(...)
    r"`"  # Backtick command substitution
)


def normalize_path(path: str, base_dir: Optional[str] = None) -> str:
    """Normalize and resolve a file path.

    Args:
        path: The path to normalize (absolute or relative)
        base_dir: Optional base directory for relative paths

    Returns:
        Absolute path with user home expansion
    """
    # Expand user home directory
    expanded_path = os.path.expanduser(path)

    # If path is relative and base_dir is provided, join them
    if not os.path.isabs(expanded_path) and base_dir:
        expanded_path = os.path.join(base_dir, expanded_path)

    # Return absolute path
    return os.path.abspath(expanded_path)


def get_file_info(path: str) -> dict[str, Any]:
    """Get detailed information about a file or directory.

    Args:
        path: Path to the file or directory

    Returns:
        Dictionary with file metadata:
        - name: File/directory name
        - path: Absolute path
        - type: "file", "directory", or "symlink"
        - size: Size in bytes
        - permissions: Permission string (e.g., "-rw-r--r--")
        - mode: Numeric mode
        - modified_time: ISO format timestamp
        - is_symlink: Whether it's a symbolic link
        - symlink_target: Target path if symlink

    Raises:
        FileNotFoundError: If path doesn't exist
        PermissionError: If access is denied
    """
    path_obj = Path(path)

    if not path_obj.exists():
        raise FileNotFoundError(f"Path not found: {path}")

    # Use lstat to get info about symlink itself, not target
    stat_info = path_obj.lstat()

    # Determine file type
    if path_obj.is_symlink():
        file_type = "symlink"
    elif path_obj.is_dir():
        file_type = "directory"
    else:
        file_type = "file"

    # Build response
    info = {
        "name": path_obj.name,
        "path": str(path_obj.absolute()),
        "type": file_type,
        "size": stat_info.st_size,
        "permissions": stat.filemode(stat_info.st_mode),
        "mode": stat_info.st_mode,
        "modified_time": datetime.fromtimestamp(stat_info.st_mtime).isoformat(),
        "is_symlink": path_obj.is_symlink(),
    }

    # Add symlink target if applicable
    if path_obj.is_symlink():
        try:
            info["symlink_target"] = str(path_obj.readlink())
        except (OSError, PermissionError):
            info["symlink_target"] = None

    return info


async def read_file(
    file_path: str,
    format: str = "text",
    max_size: int = DEFAULT_MAX_FILE_SIZE,
    base_dir: Optional[str] = None,
) -> dict[str, Any]:
    """Read file contents asynchronously.

    Args:
        file_path: Path to the file to read
        format: Read format - "text" (default) or "bytes" (returns base64)
        max_size: Maximum file size to read in bytes
        base_dir: Optional base directory for relative paths

    Returns:
        Dictionary with:
        - success: Whether the operation succeeded
        - content: File contents (text or base64-encoded for bytes)
        - size: File size in bytes
        - path: Absolute path to the file
        - format: Format used for reading
        - modified_time: Last modification time (ISO format)
        - error: Error message if failed
    """
    try:
        # Normalize path
        abs_path = normalize_path(file_path, base_dir)

        # Check if file exists
        if not os.path.exists(abs_path):
            return {
                "success": False,
                "error": f"File not found: {abs_path}",
                "content": "",
                "size": 0,
                "path": abs_path,
                "format": format,
            }

        # Check if it's a file (not directory)
        if os.path.isdir(abs_path):
            return {
                "success": False,
                "error": f"Path is a directory, not a file: {abs_path}",
                "content": "",
                "size": 0,
                "path": abs_path,
                "format": format,
            }

        # Get file info
        stat_info = os.stat(abs_path)
        file_size = stat_info.st_size
        modified_time = datetime.fromtimestamp(stat_info.st_mtime).isoformat()

        # Check file size
        if file_size > max_size:
            max_kb = max_size / 1024
            file_kb = file_size / 1024
            return {
                "success": False,
                "error": (
                    f"File too large: {file_size} bytes ({file_kb:.1f} KB). "
                    f"Maximum allowed: {max_size} bytes ({max_kb:.0f} KB)."
                ),
                "content": "",
                "size": file_size,
                "path": abs_path,
                "format": format,
            }

        # Read file content
        if format == "bytes":
            async with aiofiles.open(abs_path, "rb") as f:
                content_bytes = await f.read()
            content = base64.b64encode(content_bytes).decode("ascii")
        else:
            async with aiofiles.open(abs_path, "r", encoding="utf-8") as f:
                content = await f.read()

        logger.debug(f"[read_file] Read {file_size} bytes from {abs_path}")

        return {
            "success": True,
            "content": content,
            "size": file_size,
            "path": abs_path,
            "format": format,
            "modified_time": modified_time,
        }

    except PermissionError as e:
        logger.error(f"[read_file] Permission denied: {file_path}")
        return {
            "success": False,
            "error": f"Permission denied: {e}",
            "content": "",
            "size": 0,
            "path": file_path,
            "format": format,
        }
    except UnicodeDecodeError as e:
        logger.error(f"[read_file] Encoding error reading {file_path}: {e}")
        return {
            "success": False,
            "error": f"File encoding error. Try using format='bytes' for binary files: {e}",
            "content": "",
            "size": 0,
            "path": file_path,
            "format": format,
        }
    except Exception as e:
        logger.error(f"[read_file] Error reading file {file_path}: {e}")
        return {
            "success": False,
            "error": f"Failed to read file: {e}",
            "content": "",
            "size": 0,
            "path": file_path,
            "format": format,
        }


async def write_file(
    file_path: str,
    content: str,
    format: str = "text",
    create_dirs: bool = True,
    base_dir: Optional[str] = None,
) -> dict[str, Any]:
    """Write content to a file asynchronously.

    Args:
        file_path: Path to the file to write
        content: Content to write (text or base64-encoded for bytes format)
        format: Content format - "text" (default) or "bytes" (content is base64)
        create_dirs: Create parent directories if they don't exist
        base_dir: Optional base directory for relative paths

    Returns:
        Dictionary with:
        - success: Whether the operation succeeded
        - path: Absolute path to the file
        - size: Number of bytes written
        - format: Format used for writing
        - modified_time: File modification time after write
        - error: Error message if failed
    """
    try:
        # Normalize path
        abs_path = normalize_path(file_path, base_dir)

        # Validate content
        if content is None:
            return {
                "success": False,
                "error": "Content cannot be None. You must provide content to write.",
                "path": abs_path,
                "size": 0,
                "format": format,
            }

        # Create parent directories if needed
        if create_dirs:
            parent_dir = os.path.dirname(abs_path)
            if parent_dir and not os.path.exists(parent_dir):
                os.makedirs(parent_dir, exist_ok=True)
                logger.debug(f"[write_file] Created directory: {parent_dir}")

        # Prepare content based on format
        if format == "bytes":
            try:
                content_bytes = base64.b64decode(content)
            except Exception as e:
                return {
                    "success": False,
                    "error": f"Invalid base64 content: {e}",
                    "path": abs_path,
                    "size": 0,
                    "format": format,
                }
            # Write binary file
            async with aiofiles.open(abs_path, "wb") as f:
                await f.write(content_bytes)
            written_size = len(content_bytes)
        else:
            # Write text file
            async with aiofiles.open(abs_path, "w", encoding="utf-8") as f:
                await f.write(content)
            written_size = len(content.encode("utf-8"))

        # Get updated file info
        stat_info = os.stat(abs_path)
        modified_time = datetime.fromtimestamp(stat_info.st_mtime).isoformat()

        logger.debug(f"[write_file] Wrote {written_size} bytes to {abs_path}")

        return {
            "success": True,
            "path": abs_path,
            "size": written_size,
            "format": format,
            "modified_time": modified_time,
        }

    except PermissionError as e:
        logger.error(f"[write_file] Permission denied: {file_path}")
        return {
            "success": False,
            "error": f"Permission denied: {e}",
            "path": file_path,
            "size": 0,
            "format": format,
        }
    except Exception as e:
        logger.error(f"[write_file] Error writing file {file_path}: {e}")
        return {
            "success": False,
            "error": f"Failed to write file: {e}",
            "path": file_path,
            "size": 0,
            "format": format,
        }


async def list_files(
    directory: str,
    depth: int = DEFAULT_LIST_DEPTH,
    pattern: Optional[str] = None,
    base_dir: Optional[str] = None,
) -> dict[str, Any]:
    """List files and directories asynchronously.

    Args:
        directory: Directory path to list
        depth: Depth of recursive listing (1 = current directory only)
        pattern: Optional glob pattern to filter results (e.g., "*.py")
        base_dir: Optional base directory for relative paths

    Returns:
        Dictionary with:
        - success: Whether the operation succeeded
        - entries: List of file/directory entries with metadata
        - total: Total number of entries
        - path: Directory path that was listed
        - error: Error message if failed
    """
    try:
        # Normalize path
        abs_path = normalize_path(directory, base_dir)

        # Check if directory exists
        if not os.path.exists(abs_path):
            return {
                "success": False,
                "error": f"Directory not found: {abs_path}",
                "entries": [],
                "total": 0,
                "path": abs_path,
            }

        # Check if it's a directory
        if not os.path.isdir(abs_path):
            return {
                "success": False,
                "error": f"Path is not a directory: {abs_path}",
                "entries": [],
                "total": 0,
                "path": abs_path,
            }

        entries = []

        # Walk directory tree up to specified depth
        for root, dirs, files in os.walk(abs_path, followlinks=False):
            # Calculate current depth
            rel_path = os.path.relpath(root, abs_path)
            if rel_path == ".":
                current_depth = 0
            else:
                current_depth = len(rel_path.split(os.sep))

            # Stop if exceeded depth
            if current_depth >= depth:
                dirs.clear()  # Don't descend further
                continue

            # Process directories and files at this level
            for name in sorted(dirs) + sorted(files):
                item_path = os.path.join(root, name)

                # Apply pattern filter if specified
                if pattern and not fnmatch.fnmatch(name, pattern):
                    continue

                try:
                    info = get_file_info(item_path)
                    entries.append(info)
                except (PermissionError, FileNotFoundError) as e:
                    logger.debug(f"[list_files] Skipping {item_path}: {e}")
                    continue

        logger.debug(f"[list_files] Listed {len(entries)} entries from {abs_path}")

        return {
            "success": True,
            "entries": entries,
            "total": len(entries),
            "path": abs_path,
        }

    except PermissionError as e:
        logger.error(f"[list_files] Permission denied: {directory}")
        return {
            "success": False,
            "error": f"Permission denied: {e}",
            "entries": [],
            "total": 0,
            "path": directory,
        }
    except Exception as e:
        logger.error(f"[list_files] Error listing directory {directory}: {e}")
        return {
            "success": False,
            "error": f"Failed to list directory: {e}",
            "entries": [],
            "total": 0,
            "path": directory,
        }


def _wrap_shell_command(command: str) -> str:
    """Wrap command with bash -c if it contains shell operators.

    E2B SDK and subprocess execute commands directly without a shell interpreter,
    so shell operators like &&, ||, |, ;, >, <, etc. are not recognized.
    This method detects such operators and wraps the command with bash -c.

    Args:
        command: The original command string

    Returns:
        The command wrapped with bash -c if needed, otherwise the original command
    """
    # Check if command contains shell operators
    if SHELL_OPERATORS_PATTERN.search(command):
        # Escape single quotes in the command for bash -c
        escaped_command = command.replace("'", "'\"'\"'")
        wrapped = f"bash -c '{escaped_command}'"
        logger.debug(
            f"[_wrap_shell_command] Command contains shell operators, "
            f"wrapping with bash -c: {wrapped[:100]}..."
        )
        return wrapped
    return command


async def execute_command(
    command: str,
    timeout: int = DEFAULT_COMMAND_TIMEOUT,
    cwd: Optional[str] = None,
    max_output_size: int = DEFAULT_MAX_OUTPUT_SIZE,
    env: Optional[dict[str, str]] = None,
) -> dict[str, Any]:
    """Execute a shell command asynchronously.

    Args:
        command: The command to execute
        timeout: Command timeout in seconds
        cwd: Working directory for command execution
        max_output_size: Maximum output size in bytes (per stream)
        env: Optional environment variables to set

    Returns:
        Dictionary with:
        - success: Whether the command executed successfully (exit_code == 0)
        - stdout: Standard output (truncated if too large)
        - stderr: Standard error (truncated if too large)
        - exit_code: Command exit code
        - execution_time: Time taken in seconds
        - truncated: Whether output was truncated
        - error: Error message if failed to execute
    """
    import time

    start_time = time.time()

    # Wrap command with bash -c if it contains shell operators
    wrapped_command = _wrap_shell_command(command)

    logger.info(
        f"[execute_command] Executing: {command[:100]}, cwd={cwd}, timeout={timeout}s"
    )

    try:
        # Prepare environment
        process_env = os.environ.copy()
        if env:
            process_env.update(env)

        # Create subprocess
        process = await asyncio.create_subprocess_shell(
            wrapped_command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
            env=process_env,
        )

        try:
            # Wait for completion with timeout
            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                process.communicate(), timeout=timeout
            )
        except asyncio.TimeoutError:
            # Kill process on timeout
            process.kill()
            await process.wait()
            execution_time = time.time() - start_time

            logger.warning(f"[execute_command] Command timed out after {timeout}s")

            return {
                "success": False,
                "error": f"Command timed out after {timeout} seconds",
                "stdout": "",
                "stderr": "",
                "exit_code": -1,
                "execution_time": execution_time,
                "timed_out": True,
            }

        execution_time = time.time() - start_time

        # Decode output
        stdout = stdout_bytes.decode("utf-8", errors="replace")
        stderr = stderr_bytes.decode("utf-8", errors="replace")

        # Track truncation
        stdout_truncated = False
        stderr_truncated = False

        # Truncate if needed
        if len(stdout) > max_output_size:
            stdout = stdout[:max_output_size]
            stdout_truncated = True
            logger.warning(
                f"[execute_command] stdout truncated "
                f"(original: {len(stdout_bytes)} bytes)"
            )

        if len(stderr) > max_output_size:
            stderr = stderr[:max_output_size]
            stderr_truncated = True
            logger.warning(
                f"[execute_command] stderr truncated "
                f"(original: {len(stderr_bytes)} bytes)"
            )

        exit_code = process.returncode or 0

        result = {
            "success": exit_code == 0,
            "stdout": stdout,
            "stderr": stderr,
            "exit_code": exit_code,
            "execution_time": execution_time,
        }

        # Add truncation info if applicable
        if stdout_truncated or stderr_truncated:
            result["truncated"] = True
            result["truncation_info"] = {
                "stdout_truncated": stdout_truncated,
                "stderr_truncated": stderr_truncated,
                "max_output_size": max_output_size,
                "message": f"Output truncated to {max_output_size} bytes per stream",
            }

        logger.info(
            f"[execute_command] Completed: exit_code={exit_code}, "
            f"time={execution_time:.2f}s"
        )

        return result

    except FileNotFoundError as e:
        execution_time = time.time() - start_time
        logger.error(f"[execute_command] Command not found: {e}")
        return {
            "success": False,
            "error": f"Command not found: {e}",
            "stdout": "",
            "stderr": str(e),
            "exit_code": -1,
            "execution_time": execution_time,
        }
    except PermissionError as e:
        execution_time = time.time() - start_time
        logger.error(f"[execute_command] Permission denied: {e}")
        return {
            "success": False,
            "error": f"Permission denied: {e}",
            "stdout": "",
            "stderr": str(e),
            "exit_code": -1,
            "execution_time": execution_time,
        }
    except Exception as e:
        execution_time = time.time() - start_time
        logger.error(f"[execute_command] Error executing command: {e}")
        return {
            "success": False,
            "error": f"Failed to execute command: {e}",
            "stdout": "",
            "stderr": str(e),
            "exit_code": -1,
            "execution_time": execution_time,
        }
