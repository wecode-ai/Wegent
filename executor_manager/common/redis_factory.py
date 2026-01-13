# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Redis client factory for centralized connection management.

This module provides a factory for creating and managing Redis clients,
eliminating duplicate connection logic across service classes.
"""

import threading
from typing import Optional

import redis
import redis.asyncio as aioredis
from shared.logger import setup_logger

from executor_manager.common.config import RedisConfig, get_config

logger = setup_logger(__name__)


class RedisClientFactory:
    """Factory for creating and managing Redis clients.

    This class provides centralized Redis connection management with:
    - Thread-safe synchronous client creation
    - Async client creation for subscription operations
    - Connection health checking
    - Graceful error handling
    """

    _sync_client: Optional[redis.Redis] = None
    _async_client: Optional[aioredis.Redis] = None
    _lock = threading.Lock()
    _config: Optional[RedisConfig] = None

    @classmethod
    def _get_config(cls) -> RedisConfig:
        """Get Redis configuration."""
        if cls._config is None:
            cls._config = get_config().redis
        return cls._config

    @classmethod
    def get_sync_client(cls, verify_connection: bool = True) -> Optional[redis.Redis]:
        """Get or create a synchronous Redis client.

        Args:
            verify_connection: If True, verify the connection is working

        Returns:
            Redis client if successful, None if connection failed
        """
        if cls._sync_client is not None:
            return cls._sync_client

        with cls._lock:
            # Double-check after acquiring lock
            if cls._sync_client is not None:
                return cls._sync_client

            config = cls._get_config()
            try:
                client = redis.from_url(
                    config.url,
                    encoding=config.encoding,
                    decode_responses=config.decode_responses,
                    socket_timeout=config.socket_timeout,
                    socket_connect_timeout=config.connect_timeout,
                )

                if verify_connection:
                    client.ping()

                cls._sync_client = client
                logger.info("[RedisClientFactory] Sync Redis connection established")
                return client

            except Exception as e:
                logger.error(f"[RedisClientFactory] Failed to connect to Redis: {e}")
                return None

    @classmethod
    async def get_async_client(
        cls, verify_connection: bool = True
    ) -> Optional[aioredis.Redis]:
        """Get or create an async Redis client.

        Args:
            verify_connection: If True, verify the connection is working

        Returns:
            Async Redis client if successful, None if connection failed
        """
        if cls._async_client is not None:
            return cls._async_client

        config = cls._get_config()
        try:
            client = aioredis.from_url(
                config.url,
                encoding=config.encoding,
                decode_responses=config.decode_responses,
            )

            if verify_connection:
                await client.ping()

            cls._async_client = client
            logger.info("[RedisClientFactory] Async Redis connection established")
            return client

        except Exception as e:
            logger.error(
                f"[RedisClientFactory] Failed to create async Redis client: {e}"
            )
            return None

    @classmethod
    def create_client(cls, verify_connection: bool = True) -> Optional[redis.Redis]:
        """Create a new Redis client (not cached).

        Use this when you need a separate client instance that won't be
        shared with other parts of the application.

        Args:
            verify_connection: If True, verify the connection is working

        Returns:
            New Redis client if successful, None if connection failed
        """
        config = cls._get_config()
        try:
            client = redis.from_url(
                config.url,
                encoding=config.encoding,
                decode_responses=config.decode_responses,
                socket_timeout=config.socket_timeout,
                socket_connect_timeout=config.connect_timeout,
            )

            if verify_connection:
                client.ping()

            return client

        except Exception as e:
            logger.error(f"[RedisClientFactory] Failed to create Redis client: {e}")
            return None

    @classmethod
    def reset(cls) -> None:
        """Reset all cached clients.

        This is primarily useful for testing purposes.
        """
        with cls._lock:
            cls._sync_client = None
            cls._async_client = None
            cls._config = None

    @classmethod
    def is_connected(cls) -> bool:
        """Check if the sync client is connected and healthy.

        Returns:
            True if connected and can ping, False otherwise
        """
        if cls._sync_client is None:
            return False

        try:
            cls._sync_client.ping()
            return True
        except Exception:
            return False
