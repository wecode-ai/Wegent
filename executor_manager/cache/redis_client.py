#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Redis client module for executor_manager cache operations
"""

from typing import Optional
import redis
from urllib.parse import urlparse

from executor_manager.config.config import REDIS_URL
from shared.logger import setup_logger

logger = setup_logger(__name__)


class RedisClient:
    """Redis client wrapper for executor_manager operations"""

    _instance: Optional["RedisClient"] = None
    _client: Optional[redis.Redis] = None

    def __new__(cls):
        """Singleton pattern to ensure only one Redis connection"""
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __init__(self):
        """Initialize Redis client connection"""
        if self._client is None:
            self._connect()

    def _connect(self):
        """Establish Redis connection"""
        try:
            parsed = urlparse(REDIS_URL)
            self._client = redis.Redis(
                host=parsed.hostname or "localhost",
                port=parsed.port or 6379,
                db=int(parsed.path.lstrip("/") or 0),
                password=parsed.password,
                decode_responses=True,
                socket_timeout=5,
                socket_connect_timeout=5,
            )
            # Test connection
            self._client.ping()
            logger.info(f"Successfully connected to Redis at {parsed.hostname}:{parsed.port}")
        except redis.ConnectionError as e:
            logger.warning(f"Failed to connect to Redis: {e}. Operations will use fail-open strategy.")
            self._client = None
        except Exception as e:
            logger.warning(f"Unexpected error connecting to Redis: {e}. Operations will use fail-open strategy.")
            self._client = None

    @property
    def is_connected(self) -> bool:
        """Check if Redis connection is active"""
        if self._client is None:
            return False
        try:
            self._client.ping()
            return True
        except (redis.ConnectionError, redis.TimeoutError):
            return False

    def incr(self, key: str) -> Optional[int]:
        """
        Increment a key's value atomically

        Args:
            key: The Redis key to increment

        Returns:
            The new value after increment, or None if operation failed
        """
        if self._client is None:
            logger.warning(f"Redis not connected, cannot increment key: {key}")
            return None
        try:
            return self._client.incr(key)
        except redis.RedisError as e:
            logger.error(f"Failed to increment key {key}: {e}")
            return None

    def get(self, key: str) -> Optional[str]:
        """
        Get a key's value

        Args:
            key: The Redis key to get

        Returns:
            The value as string, or None if not found or operation failed
        """
        if self._client is None:
            logger.warning(f"Redis not connected, cannot get key: {key}")
            return None
        try:
            return self._client.get(key)
        except redis.RedisError as e:
            logger.error(f"Failed to get key {key}: {e}")
            return None

    def set(self, key: str, value: str, ttl: Optional[int] = None) -> bool:
        """
        Set a key's value with optional TTL

        Args:
            key: The Redis key to set
            value: The value to set
            ttl: Optional time-to-live in seconds

        Returns:
            True if successful, False otherwise
        """
        if self._client is None:
            logger.warning(f"Redis not connected, cannot set key: {key}")
            return False
        try:
            if ttl:
                self._client.setex(key, ttl, value)
            else:
                self._client.set(key, value)
            return True
        except redis.RedisError as e:
            logger.error(f"Failed to set key {key}: {e}")
            return False

    def expire(self, key: str, ttl: int) -> bool:
        """
        Set TTL for an existing key

        Args:
            key: The Redis key
            ttl: Time-to-live in seconds

        Returns:
            True if successful, False otherwise
        """
        if self._client is None:
            logger.warning(f"Redis not connected, cannot set expire for key: {key}")
            return False
        try:
            return bool(self._client.expire(key, ttl))
        except redis.RedisError as e:
            logger.error(f"Failed to set expire for key {key}: {e}")
            return False

    def delete(self, key: str) -> bool:
        """
        Delete a key

        Args:
            key: The Redis key to delete

        Returns:
            True if key was deleted, False otherwise
        """
        if self._client is None:
            logger.warning(f"Redis not connected, cannot delete key: {key}")
            return False
        try:
            return bool(self._client.delete(key))
        except redis.RedisError as e:
            logger.error(f"Failed to delete key {key}: {e}")
            return False

    def exists(self, key: str) -> bool:
        """
        Check if a key exists

        Args:
            key: The Redis key to check

        Returns:
            True if key exists, False otherwise
        """
        if self._client is None:
            logger.warning(f"Redis not connected, cannot check key existence: {key}")
            return False
        try:
            return bool(self._client.exists(key))
        except redis.RedisError as e:
            logger.error(f"Failed to check key existence {key}: {e}")
            return False


# Global instance for convenience
_redis_client: Optional[RedisClient] = None


def get_redis_client() -> RedisClient:
    """Get the global Redis client instance"""
    global _redis_client
    if _redis_client is None:
        _redis_client = RedisClient()
    return _redis_client
