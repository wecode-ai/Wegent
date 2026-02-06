# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Claude Code session management module.

Handles client connection caching, session ID persistence, and cleanup operations.
This module provides session lifecycle management for Claude Code agents.
"""

import asyncio
import os
from typing import Any, Dict, Optional

from claude_agent_sdk import ClaudeSDKClient

from executor.config import config
from shared.logger import setup_logger

logger = setup_logger("claude_code_session_manager")


class SessionManager:
    """
    Manages Claude Code client sessions.

    Provides:
    - Client connection caching and reuse
    - Session ID persistence to filesystem
    - Session cleanup operations
    - Active session tracking
    """

    # Class-level storage for client connections
    # Key: session_id (task_id:bot_id format), Value: ClaudeSDKClient
    _clients: Dict[str, ClaudeSDKClient] = {}

    # Mapping internal_session_key to actual Claude session_id
    # Key: internal_session_key (task_id:bot_id), Value: actual Claude session_id
    _session_id_map: Dict[str, str] = {}

    @staticmethod
    def get_session_id_file_path(task_id: int) -> str:
        """Get the path to the session ID file for a task.

        Args:
            task_id: Task ID

        Returns:
            Path to the session ID file
        """
        workspace_root = config.get_workspace_root()
        task_dir = os.path.join(workspace_root, str(task_id))
        return os.path.join(task_dir, ".claude_session_id")

    @classmethod
    def load_saved_session_id(cls, task_id: int) -> str | None:
        """Load saved Claude session ID for a task.

        Args:
            task_id: Task ID

        Returns:
            Saved session ID or None if not found
        """
        session_file = cls.get_session_id_file_path(task_id)
        try:
            if os.path.exists(session_file):
                with open(session_file, "r", encoding="utf-8") as f:
                    session_id = f.read().strip()
                    if session_id:
                        logger.info(
                            f"Loaded saved Claude session ID for task {task_id}: {session_id}"
                        )
                        return session_id
        except Exception as e:
            logger.warning(f"Failed to load saved session ID for task {task_id}: {e}")
        return None

    @classmethod
    def save_session_id(cls, task_id: int, claude_session_id: str) -> None:
        """Save Claude session ID for a task.

        Args:
            task_id: Task ID
            claude_session_id: Claude's actual session ID
        """
        session_file = cls.get_session_id_file_path(task_id)
        try:
            os.makedirs(os.path.dirname(session_file), exist_ok=True)
            with open(session_file, "w", encoding="utf-8") as f:
                f.write(claude_session_id)
            logger.info(
                f"Saved Claude session ID for task {task_id}: {claude_session_id}"
            )
        except Exception as e:
            logger.warning(f"Failed to save session ID for task {task_id}: {e}")

    @classmethod
    def get_client(cls, session_id: str) -> Optional[ClaudeSDKClient]:
        """Get cached client by session_id.

        Args:
            session_id: Session ID

        Returns:
            Cached client or None if not found
        """
        return cls._clients.get(session_id)

    @classmethod
    def set_client(cls, session_id: str, client: ClaudeSDKClient) -> None:
        """Cache a client connection.

        Args:
            session_id: Session ID
            client: ClaudeSDKClient instance
        """
        cls._clients[session_id] = client

    @classmethod
    def remove_client(cls, session_id: str) -> Optional[ClaudeSDKClient]:
        """Remove and return a cached client.

        Args:
            session_id: Session ID

        Returns:
            Removed client or None if not found
        """
        return cls._clients.pop(session_id, None)

    @classmethod
    def get_session_id(cls, internal_key: str) -> Optional[str]:
        """Get mapped session ID for an internal key.

        Args:
            internal_key: Internal session key (task_id:bot_id format)

        Returns:
            Mapped session ID or None
        """
        return cls._session_id_map.get(internal_key)

    @classmethod
    def set_session_id(cls, internal_key: str, session_id: str) -> None:
        """Map an internal key to a session ID.

        Args:
            internal_key: Internal session key
            session_id: Actual Claude session ID
        """
        cls._session_id_map[internal_key] = session_id

    @classmethod
    def remove_session_id(cls, internal_key: str) -> Optional[str]:
        """Remove and return a session ID mapping.

        Args:
            internal_key: Internal session key

        Returns:
            Removed session ID or None
        """
        return cls._session_id_map.pop(internal_key, None)

    @classmethod
    def get_active_task_ids(cls) -> list[int]:
        """Get list of active task IDs.

        Session keys can be in format:
        - "task_id:bot_id" for initial connections
        - "subtask_id" when new_session=True

        Returns:
            List of active task IDs
        """
        task_ids = []

        # Check _session_id_map for internal_key -> session_id mappings
        for internal_key in cls._session_id_map.keys():
            try:
                task_id_str = internal_key.split(":")[0]
                task_id = int(task_id_str)
                if task_id not in task_ids:
                    task_ids.append(task_id)
            except (ValueError, IndexError):
                continue

        # Also check _clients directly for session_ids in "task_id:bot_id" format
        for session_id in cls._clients.keys():
            try:
                if ":" in session_id:
                    task_id_str = session_id.split(":")[0]
                    task_id = int(task_id_str)
                    if task_id not in task_ids:
                        task_ids.append(task_id)
            except (ValueError, IndexError):
                continue

        return task_ids

    @classmethod
    def get_active_session_count(cls) -> int:
        """Get the number of active Claude Code sessions.

        Returns:
            Number of active sessions
        """
        return len(cls.get_active_task_ids())

    @classmethod
    async def close_client(cls, session_id: str) -> bool:
        """Close a specific client connection.

        Args:
            session_id: Session ID to close

        Returns:
            True if successfully closed, False otherwise
        """
        try:
            if session_id in cls._clients:
                client = cls._clients[session_id]
                await client.disconnect()
                del cls._clients[session_id]
                logger.info(f"Closed Claude client for session_id: {session_id}")
                return True
            return False
        except Exception as e:
            logger.exception(
                f"Error closing client for session_id {session_id}: {str(e)}"
            )
            return False

    @classmethod
    async def close_all_clients(cls) -> None:
        """Close all client connections."""
        for session_id, client in list(cls._clients.items()):
            try:
                await client.disconnect()
                logger.info(f"Closed Claude client for session_id: {session_id}")
            except Exception as e:
                logger.exception(
                    f"Error closing client for session_id {session_id}: {str(e)}"
                )
        cls._clients.clear()

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
    async def cleanup_task_clients(cls, task_id: int) -> int:
        """Close all client connections for a specific task_id.

        Session keys can be in two formats:
        1. "task_id:bot_id" - for initial connections
        2. "subtask_id" - when new_session=True

        Args:
            task_id: Task ID to cleanup clients for

        Returns:
            Number of clients cleaned up
        """
        cleaned_count = 0
        task_id_str = str(task_id)
        task_id_prefix = f"{task_id}:"

        logger.info(
            f"Starting cleanup for task_id={task_id}, "
            f"_session_id_map keys={list(cls._session_id_map.keys())}, "
            f"_clients keys={list(cls._clients.keys())}"
        )

        # Step 1: Check _session_id_map to find all session_ids for this task
        internal_keys_to_cleanup = []
        for internal_key, session_id in list(cls._session_id_map.items()):
            if internal_key.startswith(task_id_prefix) or internal_key == task_id_str:
                internal_keys_to_cleanup.append((internal_key, session_id))
                logger.info(
                    f"Found internal_key={internal_key} -> session_id={session_id} "
                    f"for task {task_id}"
                )

        # Clean up clients found in _session_id_map
        for internal_key, session_id in internal_keys_to_cleanup:
            if session_id in cls._clients:
                client = cls._clients[session_id]
                await cls._terminate_client_process(client, session_id)
                del cls._clients[session_id]
                cleaned_count += 1
            else:
                logger.warning(
                    f"session_id={session_id} not found in _clients "
                    f"for internal_key={internal_key}"
                )
            # Clean up the mapping
            cls._session_id_map.pop(internal_key, None)

        # Step 2: Check _clients directly for any unmatched session_ids
        already_cleaned = [sid for _, sid in internal_keys_to_cleanup]
        for session_id in list(cls._clients.keys()):
            if session_id in already_cleaned:
                continue
            if session_id.startswith(task_id_prefix) or session_id == task_id_str:
                client = cls._clients[session_id]
                await cls._terminate_client_process(client, session_id)
                del cls._clients[session_id]
                cleaned_count += 1

        if cleaned_count > 0:
            logger.info(f"Cleaned up {cleaned_count} client(s) for task_id={task_id}")
        else:
            logger.warning(f"No clients found to cleanup for task_id={task_id}")

        return cleaned_count


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
) -> tuple[str, str]:
    """Resolve session ID for a task.

    Args:
        task_id: Task ID
        bot_id: Bot ID (optional)
        new_session: Whether to create a new session

    Returns:
        Tuple of (internal_session_key, session_id)
    """
    internal_key = build_internal_session_key(task_id, bot_id)
    cached_session_id = SessionManager.get_session_id(internal_key)

    if not cached_session_id:
        # No cache -> use internal_session_key as session_id
        session_id = internal_key
        logger.info(f"No cache, using {session_id} as session_id (bot_id={bot_id})")
    elif new_session:
        # Has cache + new_session=True -> will create new session in execution
        session_id = cached_session_id
        logger.info(
            f"Has cache + new_session=True, will create new session for {session_id}"
        )
    else:
        # Has cache + new_session=False -> use cached session_id
        session_id = cached_session_id
        logger.info(
            f"Has cache, using cached session_id {session_id} (bot_id={bot_id})"
        )

    return internal_key, session_id
