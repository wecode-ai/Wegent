# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Distributed lock implementation using Redis.

This module provides a simple Redis-based distributed lock for coordinating
operations across multiple service replicas, such as GC tasks.
"""

from typing import Optional

import redis
from shared.logger import setup_logger

from executor_manager.common.redis_factory import RedisClientFactory

logger = setup_logger(__name__)

# Lock key prefix
LOCK_KEY_PREFIX = "wegent-sandbox:lock:"


class DistributedLock:
    """Redis-based distributed lock for multi-replica coordination.

    Uses Redis SET NX (set if not exists) with expiration for safe locking.
    """

    def __init__(self, redis_client: Optional[redis.Redis] = None):
        """Initialize the distributed lock.

        Args:
            redis_client: Optional Redis client. If not provided, will use
                         RedisClientFactory to get the shared client.
        """
        self._redis_client = redis_client

    @property
    def redis_client(self) -> Optional[redis.Redis]:
        """Lazy-load Redis client."""
        if self._redis_client is None:
            self._redis_client = RedisClientFactory.get_sync_client()
        return self._redis_client

    def acquire(self, lock_name: str, expire_seconds: int = 60) -> bool:
        """Acquire a distributed lock.

        Args:
            lock_name: Name of the lock (will be prefixed with LOCK_KEY_PREFIX)
            expire_seconds: Lock expiration time in seconds (default 60s).
                           The lock will auto-expire after this time to prevent
                           deadlocks if the holder crashes.

        Returns:
            True if lock acquired, False if already held by another instance
        """
        if self.redis_client is None:
            return False

        lock_key = f"{LOCK_KEY_PREFIX}{lock_name}"
        try:
            # SET key value NX EX seconds - only set if not exists
            result = self.redis_client.set(lock_key, "1", nx=True, ex=expire_seconds)
            return result is True
        except Exception as e:
            logger.error(f"[DistributedLock] Failed to acquire lock {lock_name}: {e}")
            return False

    def release(self, lock_name: str) -> bool:
        """Release a distributed lock.

        Args:
            lock_name: Name of the lock to release

        Returns:
            True if released successfully, False otherwise
        """
        if self.redis_client is None:
            return False

        lock_key = f"{LOCK_KEY_PREFIX}{lock_name}"
        try:
            self.redis_client.delete(lock_key)
            return True
        except Exception as e:
            logger.error(f"[DistributedLock] Failed to release lock {lock_name}: {e}")
            return False


# Singleton instance
_lock_instance: Optional[DistributedLock] = None


def get_distributed_lock() -> DistributedLock:
    """Get the global DistributedLock instance.

    Returns:
        The DistributedLock singleton
    """
    global _lock_instance
    if _lock_instance is None:
        _lock_instance = DistributedLock()
    return _lock_instance
