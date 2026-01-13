# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Heartbeat Manager for executor container health monitoring.

This module handles executor heartbeat management:
- Storing heartbeat timestamps in Redis
- Checking heartbeat timeout to detect executor crashes
"""

import os
import threading
import time
from typing import Optional

import redis
from shared.logger import setup_logger

from executor_manager.common.redis_factory import RedisClientFactory

logger = setup_logger(__name__)

# Redis key pattern
SANDBOX_HEARTBEAT_KEY = "sandbox:heartbeat:{sandbox_id}"  # Key for heartbeat timestamp

# Heartbeat configuration
# Key TTL should be slightly longer than heartbeat interval to avoid false positives
HEARTBEAT_KEY_TTL = int(
    os.getenv("HEARTBEAT_KEY_TTL", "20")
)  # TTL for heartbeat key (seconds)
HEARTBEAT_TIMEOUT = int(
    os.getenv("HEARTBEAT_TIMEOUT", "30")
)  # Seconds before marking dead


class HeartbeatManager:
    """Manager for executor heartbeat operations.

    This class provides methods for:
    - Updating heartbeat timestamps
    - Checking heartbeat timeout
    - Getting last heartbeat time
    - Deleting heartbeat keys
    """

    _instance: Optional["HeartbeatManager"] = None
    _lock = threading.Lock()

    def __init__(self):
        """Initialize the HeartbeatManager."""
        self._sync_client: Optional[redis.Redis] = None
        self._init_sync_redis()

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

    def _init_sync_redis(self) -> None:
        """Initialize synchronous Redis connection."""
        self._sync_client = RedisClientFactory.get_sync_client()
        if self._sync_client is not None:
            logger.info(
                "[HeartbeatManager] Sync Redis connection established via factory"
            )
        else:
            logger.error("[HeartbeatManager] Failed to connect to Redis via factory")

    def update_heartbeat(self, sandbox_id: str) -> bool:
        """Update heartbeat timestamp for a sandbox.

        Args:
            sandbox_id: Sandbox ID

        Returns:
            True if updated successfully
        """
        if self._sync_client is None:
            return False

        try:
            key = SANDBOX_HEARTBEAT_KEY.format(sandbox_id=sandbox_id)
            timestamp = time.time()

            # Set heartbeat timestamp with TTL
            self._sync_client.setex(key, HEARTBEAT_KEY_TTL, str(timestamp))

            logger.debug(
                f"[HeartbeatManager] Heartbeat updated: sandbox_id={sandbox_id}"
            )
            return True
        except Exception as e:
            logger.error(f"[HeartbeatManager] Failed to update heartbeat: {e}")
            return False

    def check_heartbeat(self, sandbox_id: str) -> bool:
        """Check if executor heartbeat is within timeout threshold.

        Args:
            sandbox_id: Sandbox ID

        Returns:
            True if heartbeat is recent (executor alive), False otherwise
        """
        if self._sync_client is None:
            return False

        try:
            key = SANDBOX_HEARTBEAT_KEY.format(sandbox_id=sandbox_id)
            timestamp_str = self._sync_client.get(key)

            if timestamp_str is None:
                # No heartbeat recorded - executor might be new or dead
                return False

            timestamp = float(timestamp_str)
            elapsed = time.time() - timestamp

            is_alive = elapsed < HEARTBEAT_TIMEOUT
            if not is_alive:
                logger.warning(
                    f"[HeartbeatManager] Heartbeat timeout: sandbox_id={sandbox_id}, "
                    f"elapsed={elapsed:.1f}s > timeout={HEARTBEAT_TIMEOUT}s"
                )

            return is_alive
        except Exception as e:
            logger.error(f"[HeartbeatManager] Failed to check heartbeat: {e}")
            return False

    def get_last_heartbeat(self, sandbox_id: str) -> Optional[float]:
        """Get the last heartbeat timestamp for a sandbox.

        Args:
            sandbox_id: Sandbox ID

        Returns:
            Last heartbeat timestamp, or None if not found
        """
        if self._sync_client is None:
            return None

        try:
            key = SANDBOX_HEARTBEAT_KEY.format(sandbox_id=sandbox_id)
            timestamp_str = self._sync_client.get(key)

            if timestamp_str is None:
                return None

            return float(timestamp_str)
        except Exception as e:
            logger.error(f"[HeartbeatManager] Failed to get last heartbeat: {e}")
            return None

    def delete_heartbeat(self, sandbox_id: str) -> bool:
        """Delete heartbeat key for a sandbox.

        Args:
            sandbox_id: Sandbox ID

        Returns:
            True if deleted successfully
        """
        if self._sync_client is None:
            return False

        try:
            key = SANDBOX_HEARTBEAT_KEY.format(sandbox_id=sandbox_id)
            self._sync_client.delete(key)
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
