# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Heartbeat Manager for executor container health monitoring.

This module handles executor heartbeat management:
- Storing heartbeat timestamps in Redis
- Checking heartbeat timeout to detect executor crashes

Supports two types of heartbeat keys:
- sandbox:heartbeat:{id} - For sandbox (long-lived) tasks
- task:heartbeat:{id} - For regular (online/offline) tasks

All methods are async to avoid blocking the event loop.
"""

import os
import threading
import time
from enum import Enum
from typing import Optional

import redis.asyncio as aioredis

from executor_manager.common.redis_factory import RedisClientFactory
from shared.logger import setup_logger

logger = setup_logger(__name__)


class HeartbeatType(Enum):
    """Type of heartbeat key to use."""

    SANDBOX = "sandbox"  # For sandbox tasks (long-lived)
    TASK = "task"  # For regular tasks (online/offline)


# Redis key patterns
SANDBOX_HEARTBEAT_KEY = "sandbox:heartbeat:{id}"
TASK_HEARTBEAT_KEY = "task:heartbeat:{id}"

# Heartbeat configuration
# Key TTL should be slightly longer than heartbeat interval to avoid false positives
HEARTBEAT_KEY_TTL = int(
    os.getenv("HEARTBEAT_KEY_TTL", "20")
)  # TTL for heartbeat key (seconds)
HEARTBEAT_TIMEOUT = int(
    os.getenv("HEARTBEAT_TIMEOUT", "30")
)  # Seconds before marking dead


def _get_heartbeat_key(heartbeat_id: str, heartbeat_type: HeartbeatType) -> str:
    """Get the Redis key for a heartbeat.

    Args:
        heartbeat_id: The ID (sandbox_id or task_id)
        heartbeat_type: Type of heartbeat (SANDBOX or TASK)

    Returns:
        The Redis key string
    """
    if heartbeat_type == HeartbeatType.SANDBOX:
        return SANDBOX_HEARTBEAT_KEY.format(id=heartbeat_id)
    else:
        return TASK_HEARTBEAT_KEY.format(id=heartbeat_id)


class HeartbeatManager:
    """Manager for executor heartbeat operations.

    This class provides async methods for:
    - Updating heartbeat timestamps
    - Checking heartbeat timeout
    - Getting last heartbeat time
    - Deleting heartbeat keys

    Supports both sandbox and regular task heartbeats with different key prefixes.

    All methods are async to avoid blocking the event loop.
    """

    _instance: Optional["HeartbeatManager"] = None
    _lock = threading.Lock()

    def __init__(self):
        """Initialize the HeartbeatManager."""
        self._async_client: Optional[aioredis.Redis] = None

    @classmethod
    def get_instance(cls) -> "HeartbeatManager":
        """Get the singleton instance of HeartbeatManager.

        Returns:
            The HeartbeatManager singleton
        """
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    async def _get_async_client(self) -> Optional[aioredis.Redis]:
        """Get or initialize async Redis client lazily.

        Returns:
            Async Redis client if available, None otherwise
        """
        if self._async_client is None:
            self._async_client = await RedisClientFactory.get_async_client()
            if self._async_client is not None:
                logger.info(
                    "[HeartbeatManager] Async Redis connection established via factory"
                )
            else:
                logger.error(
                    "[HeartbeatManager] Failed to connect async Redis via factory"
                )
        return self._async_client

    async def update_heartbeat(
        self,
        heartbeat_id: str,
        heartbeat_type: HeartbeatType = HeartbeatType.SANDBOX,
    ) -> bool:
        """Update heartbeat timestamp.

        Args:
            heartbeat_id: ID for heartbeat (sandbox_id or task_id)
            heartbeat_type: Type of heartbeat (SANDBOX or TASK)

        Returns:
            True if updated successfully
        """
        client = await self._get_async_client()
        if client is None:
            return False

        try:
            key = _get_heartbeat_key(heartbeat_id, heartbeat_type)
            timestamp = time.time()

            # Set heartbeat timestamp with TTL
            await client.setex(key, HEARTBEAT_KEY_TTL, str(timestamp))

            logger.debug(
                f"[HeartbeatManager] Heartbeat updated: type={heartbeat_type.value}, id={heartbeat_id}"
            )
            return True
        except Exception as e:
            logger.error(f"[HeartbeatManager] Failed to update heartbeat: {e}")
            return False

    async def check_heartbeat(
        self,
        heartbeat_id: str,
        heartbeat_type: HeartbeatType = HeartbeatType.SANDBOX,
    ) -> bool:
        """Check if executor heartbeat is within timeout threshold (async version).

        Use this method in async contexts (like APScheduler jobs) to avoid
        blocking the event loop.

        Args:
            heartbeat_id: ID for heartbeat (sandbox_id or task_id)
            heartbeat_type: Type of heartbeat (SANDBOX or TASK)

        Returns:
            True if heartbeat is recent (executor alive), False otherwise
        """
        client = await self._get_async_client()
        if client is None:
            return False

        try:
            key = _get_heartbeat_key(heartbeat_id, heartbeat_type)
            timestamp_str = await client.get(key)

            if timestamp_str is None:
                # No heartbeat recorded - executor might be new or dead
                return False

            timestamp = float(timestamp_str)
            elapsed = time.time() - timestamp

            is_alive = elapsed < HEARTBEAT_TIMEOUT
            if not is_alive:
                logger.warning(
                    f"[HeartbeatManager] Heartbeat timeout: type={heartbeat_type.value}, "
                    f"id={heartbeat_id}, elapsed={elapsed:.1f}s > timeout={HEARTBEAT_TIMEOUT}s"
                )

            return is_alive
        except Exception as e:
            logger.error(f"[HeartbeatManager] Failed to check heartbeat async: {e}")
            return False

    async def get_last_heartbeat(
        self,
        heartbeat_id: str,
        heartbeat_type: HeartbeatType = HeartbeatType.SANDBOX,
    ) -> Optional[float]:
        """Get the last heartbeat timestamp.

        Args:
            heartbeat_id: ID for heartbeat (sandbox_id or task_id)
            heartbeat_type: Type of heartbeat (SANDBOX or TASK)

        Returns:
            Last heartbeat timestamp, or None if not found
        """
        client = await self._get_async_client()
        if client is None:
            return None

        try:
            key = _get_heartbeat_key(heartbeat_id, heartbeat_type)
            timestamp_str = await client.get(key)

            if timestamp_str is None:
                return None

            return float(timestamp_str)
        except Exception as e:
            logger.error(f"[HeartbeatManager] Failed to get last heartbeat: {e}")
            return None

    async def delete_heartbeat(
        self,
        heartbeat_id: str,
        heartbeat_type: HeartbeatType = HeartbeatType.SANDBOX,
    ) -> bool:
        """Delete heartbeat key.

        Args:
            heartbeat_id: ID for heartbeat (sandbox_id or task_id)
            heartbeat_type: Type of heartbeat (SANDBOX or TASK)

        Returns:
            True if deleted successfully
        """
        client = await self._get_async_client()
        if client is None:
            return False

        try:
            key = _get_heartbeat_key(heartbeat_id, heartbeat_type)
            await client.delete(key)
            return True
        except Exception as e:
            logger.error(f"[HeartbeatManager] Failed to delete heartbeat: {e}")
            return False


# Global singleton instance
_heartbeat_manager: Optional[HeartbeatManager] = None


def get_heartbeat_manager() -> HeartbeatManager:
    """Get the global HeartbeatManager instance.

    Returns:
        The HeartbeatManager singleton
    """
    global _heartbeat_manager
    if _heartbeat_manager is None:
        _heartbeat_manager = HeartbeatManager.get_instance()
    return _heartbeat_manager
