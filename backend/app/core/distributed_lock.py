# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Distributed lock implementation using Redis for backend services.

This module provides Redis-based distributed locking for coordinating
operations across multiple service instances, such as Flow scheduler tasks.

Usage:
    from app.core.distributed_lock import distributed_lock

    # Acquire lock with context manager
    with distributed_lock.acquire_context("check_due_flows", expire_seconds=120) as acquired:
        if acquired:
            # Do work while holding the lock
            pass
        else:
            # Another instance is already doing this work
            pass

    # Or use acquire/release directly
    if distributed_lock.acquire("my_task", expire_seconds=60):
        try:
            # Do work
            pass
        finally:
            distributed_lock.release("my_task")
"""

import logging
from contextlib import contextmanager
from typing import Generator, Optional

import redis

from app.core.config import settings

logger = logging.getLogger(__name__)

# Lock key prefix
LOCK_KEY_PREFIX = "wegent:lock:"


class DistributedLock:
    """
    Redis-based distributed lock for multi-instance coordination.

    Uses Redis SET NX (set if not exists) with expiration for safe locking.
    This prevents multiple Celery workers from processing the same periodic
    task concurrently.
    """

    def __init__(self):
        """Initialize the distributed lock with lazy Redis client loading."""
        self._redis_client: Optional[redis.Redis] = None

    @property
    def redis_client(self) -> Optional[redis.Redis]:
        """Lazy-load Redis client from settings."""
        if self._redis_client is None:
            try:
                redis_url = getattr(settings, "CELERY_BROKER_URL", None) or getattr(
                    settings, "REDIS_URL", None
                )
                if redis_url:
                    self._redis_client = redis.from_url(
                        redis_url,
                        decode_responses=True,
                        socket_timeout=5,
                        socket_connect_timeout=5,
                    )
                    # Test connection
                    self._redis_client.ping()
            except Exception as e:
                logger.warning(f"[DistributedLock] Failed to connect to Redis: {e}")
                self._redis_client = None
        return self._redis_client

    def acquire(self, lock_name: str, expire_seconds: int = 60) -> bool:
        """
        Acquire a distributed lock.

        Args:
            lock_name: Name of the lock (will be prefixed with LOCK_KEY_PREFIX)
            expire_seconds: Lock expiration time in seconds (default 60s).
                           The lock will auto-expire after this time to prevent
                           deadlocks if the holder crashes.

        Returns:
            True if lock acquired, False if already held by another instance
        """
        if self.redis_client is None:
            # If Redis is not available, allow the operation to proceed
            # (single instance mode or degraded mode)
            logger.debug(f"[DistributedLock] Redis not available, allowing {lock_name}")
            return True

        lock_key = f"{LOCK_KEY_PREFIX}{lock_name}"
        try:
            # SET key value NX EX seconds - only set if not exists
            result = self.redis_client.set(lock_key, "1", nx=True, ex=expire_seconds)
            if result:
                logger.debug(f"[DistributedLock] Acquired lock: {lock_name}")
            else:
                logger.debug(
                    f"[DistributedLock] Lock {lock_name} already held by another instance"
                )
            return result is True
        except Exception as e:
            logger.error(f"[DistributedLock] Failed to acquire lock {lock_name}: {e}")
            # On error, allow operation to proceed (fail-open for availability)
            return True

    def release(self, lock_name: str) -> bool:
        """
        Release a distributed lock.

        Args:
            lock_name: Name of the lock to release

        Returns:
            True if released successfully, False otherwise
        """
        if self.redis_client is None:
            return True

        lock_key = f"{LOCK_KEY_PREFIX}{lock_name}"
        try:
            self.redis_client.delete(lock_key)
            logger.debug(f"[DistributedLock] Released lock: {lock_name}")
            return True
        except Exception as e:
            logger.error(f"[DistributedLock] Failed to release lock {lock_name}: {e}")
            return False

    def extend(self, lock_name: str, expire_seconds: int = 60) -> bool:
        """
        Extend the expiration time of a held lock.

        Useful for long-running operations that may exceed the initial lock timeout.

        Args:
            lock_name: Name of the lock to extend
            expire_seconds: New expiration time in seconds

        Returns:
            True if extended successfully, False otherwise
        """
        if self.redis_client is None:
            return True

        lock_key = f"{LOCK_KEY_PREFIX}{lock_name}"
        try:
            result = self.redis_client.expire(lock_key, expire_seconds)
            return result is True
        except Exception as e:
            logger.error(f"[DistributedLock] Failed to extend lock {lock_name}: {e}")
            return False

    def is_locked(self, lock_name: str) -> bool:
        """
        Check if a lock is currently held.

        Args:
            lock_name: Name of the lock to check

        Returns:
            True if locked, False otherwise
        """
        if self.redis_client is None:
            return False

        lock_key = f"{LOCK_KEY_PREFIX}{lock_name}"
        try:
            return self.redis_client.exists(lock_key) > 0
        except Exception as e:
            logger.error(f"[DistributedLock] Failed to check lock {lock_name}: {e}")
            return False

    @contextmanager
    def acquire_context(
        self, lock_name: str, expire_seconds: int = 60
    ) -> Generator[bool, None, None]:
        """
        Context manager for acquiring and releasing a lock.

        Usage:
            with distributed_lock.acquire_context("my_task", 120) as acquired:
                if acquired:
                    # Do work
                    pass

        Args:
            lock_name: Name of the lock
            expire_seconds: Lock expiration time

        Yields:
            True if lock was acquired, False otherwise
        """
        acquired = self.acquire(lock_name, expire_seconds)
        try:
            yield acquired
        finally:
            if acquired:
                self.release(lock_name)


# Singleton instance
distributed_lock = DistributedLock()
