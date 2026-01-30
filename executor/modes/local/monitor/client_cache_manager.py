# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Client cache manager for local executor mode.

Manages Claude SDK client cache with TTL-based cleanup.
"""

import asyncio
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict, List, Optional

from executor.config import config
from shared.logger import setup_logger

logger = setup_logger("client_cache_manager")


@dataclass
class ClientEntry:
    """Cached client entry with metadata."""

    client: Any
    created_at: float
    last_used: float
    session_id: str


class ClientCacheManager:
    """
    Manages Claude SDK client cache with TTL-based cleanup.

    Features:
    - Track client creation time
    - Cleanup stale clients based on TTL
    - Run periodic cleanup
    """

    def __init__(
        self,
        ttl_seconds: int = None,
        cleanup_interval: int = 600,  # 10 minutes
    ):
        """
        Initialize the client cache manager.

        Args:
            ttl_seconds: Client TTL in seconds. Defaults to config value.
            cleanup_interval: Cleanup interval in seconds.
        """
        self.ttl_seconds = ttl_seconds or config.WEGENT_EXECUTOR_CLIENT_TTL_SECONDS
        self.cleanup_interval = cleanup_interval

        # Internal cache tracking creation times
        # Key: session_id, Value: ClientEntry
        self._client_metadata: Dict[str, ClientEntry] = {}

        self._running = False
        self._task: Optional[asyncio.Task] = None

    async def start(self) -> None:
        """Start the periodic cleanup task."""
        if self._running:
            logger.warning("Client cache manager already running")
            return

        self._running = True
        self._task = asyncio.create_task(self._cleanup_loop())
        logger.info(
            f"Client cache manager started: ttl={self.ttl_seconds}s, interval={self.cleanup_interval}s"
        )

    async def stop(self) -> None:
        """Stop the periodic cleanup task."""
        if not self._running:
            return

        self._running = False

        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

        logger.info("Client cache manager stopped")

    def register_client(self, session_id: str, client: Any) -> None:
        """
        Register a client in the cache with timestamp.

        Args:
            session_id: Client session ID
            client: The client object
        """
        now = time.time()
        self._client_metadata[session_id] = ClientEntry(
            client=client,
            created_at=now,
            last_used=now,
            session_id=session_id,
        )
        logger.debug(f"Registered client: session_id={session_id}")

    def touch_client(self, session_id: str) -> None:
        """
        Update last used time for a client.

        Args:
            session_id: Client session ID
        """
        if session_id in self._client_metadata:
            self._client_metadata[session_id].last_used = time.time()

    def unregister_client(self, session_id: str) -> None:
        """
        Remove a client from the cache.

        Args:
            session_id: Client session ID
        """
        if session_id in self._client_metadata:
            del self._client_metadata[session_id]
            logger.debug(f"Unregistered client: session_id={session_id}")

    async def cleanup_stale_clients(self, clients_dict: Dict[str, Any]) -> int:
        """
        Clean up stale clients based on TTL.

        Args:
            clients_dict: The ClaudeCodeAgent._clients static dict to clean

        Returns:
            Number of clients removed
        """
        now = time.time()
        stale_sessions = []

        # Find stale clients
        for session_id, entry in self._client_metadata.items():
            age = now - entry.created_at
            if age > self.ttl_seconds:
                stale_sessions.append(session_id)

        # Also check clients_dict for any not tracked
        for session_id in list(clients_dict.keys()):
            if session_id not in self._client_metadata:
                # Untracked client, add to metadata with current time
                # (will be cleaned up in next cycle if not used)
                self._client_metadata[session_id] = ClientEntry(
                    client=clients_dict[session_id],
                    created_at=now,
                    last_used=now,
                    session_id=session_id,
                )

        # Clean up stale clients
        removed = 0
        for session_id in stale_sessions:
            if session_id in clients_dict:
                try:
                    client = clients_dict[session_id]
                    # Close client if it has close method
                    if hasattr(client, "close"):
                        try:
                            await client.close()
                        except Exception as e:
                            logger.warning(f"Error closing client {session_id}: {e}")

                    del clients_dict[session_id]
                    removed += 1
                except Exception as e:
                    logger.warning(f"Error removing client {session_id}: {e}")

            # Remove from metadata
            if session_id in self._client_metadata:
                del self._client_metadata[session_id]

        if removed > 0:
            logger.info(f"[CLIENT_CLEANUP] Removed {removed} stale clients")

        return removed

    async def _cleanup_loop(self) -> None:
        """Periodic cleanup loop."""
        while self._running:
            try:
                await asyncio.sleep(self.cleanup_interval)

                if not self._running:
                    break

                # Get reference to ClaudeCodeAgent._clients
                try:
                    from executor.agents.claude_code.claude_code_agent import (
                        ClaudeCodeAgent,
                    )

                    await self.cleanup_stale_clients(ClaudeCodeAgent._clients)
                except ImportError:
                    logger.warning("Could not import ClaudeCodeAgent for cleanup")
                except Exception as e:
                    logger.error(f"Client cleanup error: {e}")

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Client cleanup loop error: {e}")

    def get_stats(self) -> Dict:
        """
        Get client cache statistics.

        Returns:
            Dict with client_count, oldest_client_age_seconds
        """
        now = time.time()
        oldest_age = 0

        for entry in self._client_metadata.values():
            age = now - entry.created_at
            if age > oldest_age:
                oldest_age = age

        return {
            "client_count": len(self._client_metadata),
            "oldest_client_age_seconds": int(oldest_age),
        }
