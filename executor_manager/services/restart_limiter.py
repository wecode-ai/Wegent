#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Restart limiter service for controlling executor container restart counts
"""

from typing import Tuple
from dataclasses import dataclass

from executor_manager.cache.redis_client import get_redis_client
from executor_manager.config.config import MAX_EXECUTOR_RESTART, RESTART_COUNT_TTL
from shared.logger import setup_logger

logger = setup_logger(__name__)


# Redis key prefix for restart counts
RESTART_COUNT_KEY_PREFIX = "executor_restart:"


@dataclass
class RestartCheckResult:
    """Result of restart limit check"""
    allowed: bool
    restart_count: int
    max_restart: int
    message: str = ""


class RestartLimiter:
    """
    Service for managing executor restart counts and limits.
    Uses Redis to track restart counts per subtask.
    """

    def __init__(self):
        """Initialize the restart limiter with Redis client"""
        self._redis = get_redis_client()
        self._max_restart = MAX_EXECUTOR_RESTART
        self._ttl = RESTART_COUNT_TTL

    def _get_key(self, subtask_id: int) -> str:
        """Generate Redis key for a subtask's restart count"""
        return f"{RESTART_COUNT_KEY_PREFIX}{subtask_id}"

    def check_and_increment(self, subtask_id: int) -> RestartCheckResult:
        """
        Check if restart is allowed and increment the counter atomically.

        This method:
        1. Increments the restart count for the subtask
        2. Sets TTL on the key (24 hours by default)
        3. Returns whether the restart is within limits

        Args:
            subtask_id: The subtask ID to check

        Returns:
            RestartCheckResult with allowed status and count information
        """
        key = self._get_key(subtask_id)

        # If Redis is not connected, allow execution (fail-open strategy)
        if not self._redis.is_connected:
            logger.warning(
                f"Redis not connected, allowing restart for subtask {subtask_id} (fail-open)"
            )
            return RestartCheckResult(
                allowed=True,
                restart_count=0,
                max_restart=self._max_restart,
                message="Redis unavailable, using fail-open strategy"
            )

        # Atomically increment the counter
        new_count = self._redis.incr(key)

        if new_count is None:
            # Increment failed, allow execution (fail-open)
            logger.warning(
                f"Failed to increment restart count for subtask {subtask_id}, allowing (fail-open)"
            )
            return RestartCheckResult(
                allowed=True,
                restart_count=0,
                max_restart=self._max_restart,
                message="Failed to track restart count, using fail-open strategy"
            )

        # Set TTL on the key (refreshed on each restart)
        self._redis.expire(key, self._ttl)

        # Check if within limits
        allowed = new_count <= self._max_restart

        if allowed:
            logger.info(
                f"Subtask {subtask_id} restart allowed: count={new_count}/{self._max_restart}"
            )
            return RestartCheckResult(
                allowed=True,
                restart_count=new_count,
                max_restart=self._max_restart,
                message=f"Restart #{new_count} allowed"
            )
        else:
            logger.warning(
                f"Subtask {subtask_id} restart limit exceeded: count={new_count}/{self._max_restart}"
            )
            return RestartCheckResult(
                allowed=False,
                restart_count=new_count,
                max_restart=self._max_restart,
                message=f"Executor restart limit exceeded (max: {self._max_restart} times)"
            )

    def get_restart_count(self, subtask_id: int) -> int:
        """
        Get the current restart count for a subtask.

        Args:
            subtask_id: The subtask ID

        Returns:
            Current restart count, or 0 if not found or Redis unavailable
        """
        key = self._get_key(subtask_id)
        value = self._redis.get(key)
        if value is None:
            return 0
        try:
            return int(value)
        except ValueError:
            return 0

    def clear_restart_count(self, subtask_id: int) -> bool:
        """
        Clear the restart count for a subtask (called when task completes).

        Args:
            subtask_id: The subtask ID

        Returns:
            True if successful, False otherwise
        """
        key = self._get_key(subtask_id)
        result = self._redis.delete(key)
        if result:
            logger.info(f"Cleared restart count for subtask {subtask_id}")
        return result

    def reset_restart_count(self, subtask_id: int) -> bool:
        """
        Reset the restart count to 0 for a subtask.

        Args:
            subtask_id: The subtask ID

        Returns:
            True if successful, False otherwise
        """
        key = self._get_key(subtask_id)
        result = self._redis.set(key, "0", self._ttl)
        if result:
            logger.info(f"Reset restart count for subtask {subtask_id}")
        return result


# Global instance for convenience
_restart_limiter = None


def get_restart_limiter() -> RestartLimiter:
    """Get the global RestartLimiter instance"""
    global _restart_limiter
    if _restart_limiter is None:
        _restart_limiter = RestartLimiter()
    return _restart_limiter
