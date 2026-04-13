# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Claude Code session management module.

Handles session ID persistence to filesystem for Claude Code conversation resumption.
Each subtask execution creates a new Agent instance and destroys it after completion,
so there's no in-memory client caching. Session continuity is maintained via
.claude_session_id files on disk.
"""

import asyncio
import json
import os
import signal
import time
from typing import Optional

from claude_agent_sdk import ClaudeSDKClient

from executor.config import config
from shared.logger import setup_logger

logger = setup_logger("claude_code_session_manager")


class SessionManager:
    """
    Manages Claude Code session persistence.

    Provides:
    - Session ID persistence to filesystem (for conversation resumption)
    - Process termination for cleanup

    Note: No in-memory client caching since each subtask creates a new Agent
    instance and destroys it after completion.
    """

    @staticmethod
    def get_session_id_file_path(task_id: int, bot_id: Optional[int] = None) -> str:
        """Get the path to the session ID file for a task and bot.

        For pipeline mode, each bot needs its own session file to maintain
        independent conversation history. The file is named:
        - .claude_session_id (when bot_id is None, for backward compatibility)
        - .claude_session_id_{bot_id} (when bot_id is specified)

        Args:
            task_id: Task ID
            bot_id: Bot ID (optional, for pipeline mode)

        Returns:
            Path to the session ID file
        """
        workspace_root = config.get_workspace_root()
        task_dir = os.path.join(workspace_root, str(task_id))
        if bot_id:
            return os.path.join(task_dir, f".claude_session_id_{bot_id}")
        return os.path.join(task_dir, ".claude_session_id")

    @staticmethod
    def get_process_info_file_path(task_id: int, bot_id: Optional[int] = None) -> str:
        """Get the path to tracked resume process info file."""
        workspace_root = config.get_workspace_root()
        task_dir = os.path.join(workspace_root, str(task_id))
        if bot_id:
            return os.path.join(task_dir, f".claude_resume_process_{bot_id}.json")
        return os.path.join(task_dir, ".claude_resume_process.json")

    @classmethod
    def load_saved_session_id(
        cls, task_id: int, bot_id: Optional[int] = None
    ) -> str | None:
        """Load saved Claude session ID for a task and bot.

        Args:
            task_id: Task ID
            bot_id: Bot ID (optional, for pipeline mode)

        Returns:
            Saved session ID or None if not found
        """
        session_file = cls.get_session_id_file_path(task_id, bot_id)
        try:
            if os.path.exists(session_file):
                with open(session_file, "r", encoding="utf-8") as f:
                    session_id = f.read().strip()
                    if session_id:
                        logger.info(
                            f"Loaded saved Claude session ID for task {task_id} "
                            f"(bot_id={bot_id}): {session_id}"
                        )
                        return session_id
        except Exception as e:
            logger.warning(
                f"Failed to load saved session ID for task {task_id} "
                f"(bot_id={bot_id}): {e}"
            )
        return None

    @classmethod
    def save_session_id(
        cls, task_id: int, claude_session_id: str, bot_id: Optional[int] = None
    ) -> None:
        """Save Claude session ID for a task and bot.

        Args:
            task_id: Task ID
            claude_session_id: Claude's actual session ID
            bot_id: Bot ID (optional, for pipeline mode)
        """
        session_file = cls.get_session_id_file_path(task_id, bot_id)
        try:
            os.makedirs(os.path.dirname(session_file), exist_ok=True)
            with open(session_file, "w", encoding="utf-8") as f:
                f.write(claude_session_id)
            logger.info(
                f"Saved Claude session ID for task {task_id} "
                f"(bot_id={bot_id}): {claude_session_id}"
            )
        except Exception as e:
            logger.warning(
                f"Failed to save session ID for task {task_id} (bot_id={bot_id}): {e}"
            )

    @classmethod
    def delete_saved_session_id(
        cls, task_id: int, bot_id: Optional[int] = None
    ) -> bool:
        """Delete saved Claude session ID file for a task and bot.

        This is used when a saved session ID is invalid or expired,
        allowing a fresh session to be created on retry.

        Args:
            task_id: Task ID
            bot_id: Bot ID (optional, for pipeline mode)

        Returns:
            True if file was deleted, False otherwise
        """
        session_file = cls.get_session_id_file_path(task_id, bot_id)
        process_info_file = cls.get_process_info_file_path(task_id, bot_id)
        try:
            deleted = False
            if os.path.exists(session_file):
                os.remove(session_file)
                logger.info(
                    f"Deleted invalid session ID file for task {task_id} "
                    f"(bot_id={bot_id}): {session_file}"
                )
                deleted = True

            if os.path.exists(process_info_file):
                os.remove(process_info_file)
                logger.info(
                    f"Deleted tracked resume process file for task {task_id} "
                    f"(bot_id={bot_id}): {process_info_file}"
                )
                deleted = True

            return deleted
        except Exception as e:
            logger.warning(
                f"Failed to delete session ID file for task {task_id} "
                f"(bot_id={bot_id}): {e}"
            )
            return False

    @staticmethod
    def _is_process_running(pid: int) -> bool:
        """Check whether a PID is currently alive."""
        try:
            os.kill(pid, 0)
            return True
        except (OSError, ProcessLookupError):
            return False

    @staticmethod
    def _read_process_cmdline(pid: int) -> str:
        """Read process command line from /proc when available (Unix-like systems)."""
        cmdline_path = f"/proc/{pid}/cmdline"
        try:
            if os.path.exists(cmdline_path):
                with open(cmdline_path, "rb") as f:
                    raw = f.read()
                return raw.replace(b"\x00", b" ").decode("utf-8", errors="ignore")
        except Exception:
            return ""
        return ""

    @classmethod
    def _is_expected_resume_process(cls, pid: int, session_id: str) -> bool:
        """Validate PID belongs to a Claude process resuming the target session."""
        cmdline = cls._read_process_cmdline(pid)
        if not cmdline:
            # Best-effort fallback for environments without /proc.
            return True
        return "claude" in cmdline and "--resume" in cmdline and session_id in cmdline

    @classmethod
    async def _terminate_pid(cls, pid: int, session_id: str) -> bool:
        """Terminate a process by PID with graceful shutdown then force-kill."""
        try:
            os.kill(pid, signal.SIGTERM)
            deadline = time.time() + 2.0
            while time.time() < deadline:
                if not cls._is_process_running(pid):
                    return True
                await asyncio.sleep(0.1)

            os.kill(pid, signal.SIGKILL)
            deadline = time.time() + 1.0
            while time.time() < deadline:
                if not cls._is_process_running(pid):
                    return True
                await asyncio.sleep(0.05)

            logger.warning(
                f"PID {pid} still running after SIGKILL for session_id={session_id}"
            )
            return False
        except ProcessLookupError:
            return True
        except Exception as e:
            logger.warning(
                f"Failed to terminate stale PID {pid} for session_id={session_id}: {e}"
            )
            return False

    @classmethod
    def register_client_process(
        cls, task_id: int, bot_id: Optional[int], session_id: str, pid: int
    ) -> None:
        """Persist PID info for resumed session cleanup on next run."""
        process_info_file = cls.get_process_info_file_path(task_id, bot_id)
        payload = {
            "session_id": session_id,
            "pid": pid,
            "updated_at": time.time(),
        }
        try:
            os.makedirs(os.path.dirname(process_info_file), exist_ok=True)
            with open(process_info_file, "w", encoding="utf-8") as f:
                json.dump(payload, f)
            if os.name != "nt":
                os.chmod(process_info_file, 0o600)
        except Exception as e:
            logger.warning(
                f"Failed to register process file for task {task_id} (bot_id={bot_id}): {e}"
            )

    @classmethod
    async def terminate_stale_resumed_process(
        cls, task_id: int, bot_id: Optional[int], session_id: str
    ) -> bool:
        """Terminate previously tracked process for the same resumed session."""
        process_info_file = cls.get_process_info_file_path(task_id, bot_id)
        try:
            if not os.path.exists(process_info_file):
                return False

            with open(process_info_file, "r", encoding="utf-8") as f:
                payload = json.load(f)

            tracked_session_id = str(payload.get("session_id") or "")
            tracked_pid = payload.get("pid")
            if tracked_session_id != session_id or not isinstance(tracked_pid, int):
                return False

            if not cls._is_process_running(tracked_pid):
                os.remove(process_info_file)
                return False

            if not cls._is_expected_resume_process(tracked_pid, session_id):
                logger.warning(
                    f"Tracked PID {tracked_pid} does not match expected Claude resume process "
                    f"for session_id={session_id}, skipping termination"
                )
                return False

            terminated = await cls._terminate_pid(tracked_pid, session_id)
            if terminated and os.path.exists(process_info_file):
                os.remove(process_info_file)
            return terminated
        except Exception as e:
            logger.warning(
                f"Failed to cleanup stale resumed process for task {task_id} "
                f"(bot_id={bot_id}, session_id={session_id}): {e}"
            )
            return False

    @classmethod
    def get_active_task_ids(cls) -> list[int]:
        """Get list of active task IDs.

        Note: Since we no longer use in-memory caching, this method
        returns an empty list. Active task tracking should be done
        at the AgentService level.

        Returns:
            Empty list (no in-memory tracking)
        """
        return []

    @classmethod
    def get_active_session_count(cls) -> int:
        """Get the number of active Claude Code sessions.

        Note: Since we no longer use in-memory caching, this returns 0.
        Active session counting should be done at the AgentService level.

        Returns:
            0 (no in-memory tracking)
        """
        return 0

    @classmethod
    async def _terminate_client_process(
        cls, client: ClaudeSDKClient, session_id: str
    ) -> bool:
        """Terminate the process of a client directly.

        Uses direct process termination instead of disconnect() to avoid
        cancel scope issues when called from different asyncio context.

        Args:
            client: ClaudeSDKClient instance
            session_id: Session ID for logging

        Returns:
            True if successfully terminated, False otherwise
        """
        if not hasattr(client, "_transport") or not client._transport:
            logger.warning(f"No transport found in client for session_id={session_id}")
            return False

        transport = client._transport
        if not hasattr(transport, "_process") or not transport._process:
            logger.warning(f"No process found in transport for session_id={session_id}")
            return False

        process = transport._process
        pid = process.pid if hasattr(process, "pid") else None

        try:
            # Try graceful termination first
            process.terminate()
            logger.debug(f"Sent SIGTERM to process PID={pid}")

            # Wait briefly for process to exit
            try:
                await asyncio.wait_for(process.wait(), timeout=2.0)
                logger.debug(f"Process PID={pid} exited gracefully")
            except asyncio.TimeoutError:
                # Force kill if it doesn't exit
                logger.debug(f"Process didn't exit, sending SIGKILL...")
                process.kill()
                await asyncio.wait_for(process.wait(), timeout=1.0)
                logger.debug(f"Process PID={pid} killed")

            logger.info(
                f"Terminated Claude Code process for session_id={session_id}, PID={pid}"
            )
            return True

        except Exception as e:
            logger.warning(
                f"Error terminating process for session_id={session_id}: {e}"
            )
            return False

    @classmethod
    async def close_client(cls, session_id: str) -> bool:
        """Close a specific client connection.

        Note: This method is kept for backward compatibility but does nothing
        since we no longer use in-memory client caching. Client cleanup should
        be done directly on the agent instance.

        Args:
            session_id: Session ID to close

        Returns:
            False (no in-memory tracking)
        """
        logger.debug(
            f"close_client called for session_id={session_id}, "
            f"but no in-memory caching is used"
        )
        return False

    @classmethod
    async def close_all_clients(cls) -> None:
        """Close all client connections.

        Note: This method is kept for backward compatibility but does nothing
        since we no longer use in-memory client caching.
        """
        logger.debug("close_all_clients called, but no in-memory caching is used")

    @classmethod
    async def cleanup_task_clients(cls, task_id: int) -> int:
        """Close all client connections for a specific task_id.

        Note: This method is kept for backward compatibility but does nothing
        since we no longer use in-memory client caching.

        Args:
            task_id: Task ID to cleanup clients for

        Returns:
            0 (no in-memory tracking)
        """
        logger.debug(
            f"cleanup_task_clients called for task_id={task_id}, "
            f"but no in-memory caching is used"
        )
        return 0


def build_internal_session_key(task_id: int, bot_id: Optional[int] = None) -> str:
    """Build internal session key from task_id and optional bot_id.

    Args:
        task_id: Task ID
        bot_id: Bot ID (optional)

    Returns:
        Internal session key in format "task_id:bot_id" or "task_id"
    """
    if bot_id:
        return f"{task_id}:{bot_id}"
    return str(task_id)


def resolve_session_id(
    task_id: int,
    bot_id: Optional[int] = None,
    new_session: bool = False,
    task_state_manager=None,
) -> tuple[str, str]:
    """Resolve session ID for a task.

    Since each subtask execution creates a new Agent instance and destroys it
    after completion, we simply return the internal key as the session ID.
    Session continuity is maintained via .claude_session_id file on disk,
    which allows Claude Code to resume conversation history.

    Args:
        task_id: Task ID
        bot_id: Bot ID (optional)
        new_session: Whether to create a new session (unused, kept for API compatibility)
        task_state_manager: TaskStateManager instance (unused, kept for API compatibility)

    Returns:
        Tuple of (internal_session_key, session_id)
    """
    internal_key = build_internal_session_key(task_id, bot_id)
    session_id = internal_key
    logger.info(f"Using {session_id} as session_id (bot_id={bot_id})")
    return internal_key, session_id
