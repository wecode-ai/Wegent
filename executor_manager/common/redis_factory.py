# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Redis client factory for centralized connection management.

This module provides a factory for creating and managing Redis clients,
eliminating duplicate connection logic across service classes.
"""

import asyncio
import threading
import time
from typing import Callable, Optional, TypeVar

import redis
import redis.asyncio as aioredis

from executor_manager.common.config import RedisConfig, get_config
from shared.logger import setup_logger

logger = setup_logger(__name__)

T = TypeVar("T", redis.Redis, aioredis.Redis)


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
    def _create_sync_client(cls, config: RedisConfig) -> redis.Redis:
        """Create a synchronous Redis client instance."""
        return redis.from_url(
            config.url,
            encoding=config.encoding,
            decode_responses=config.decode_responses,
            socket_timeout=config.socket_timeout,
            socket_connect_timeout=config.connect_timeout,
        )

    @classmethod
    def _create_async_client(cls, config: RedisConfig) -> aioredis.Redis:
        """Create an async Redis client instance."""
        return aioredis.from_url(
            config.url,
            encoding=config.encoding,
            decode_responses=config.decode_responses,
        )

    @classmethod
    def _retry_sync(
        cls,
        create_fn: Callable[[], T],
        verify_fn: Callable[[T], None],
        verify_connection: bool,
        client_type: str,
    ) -> Optional[T]:
        """Execute sync client creation with retry logic.

        Args:
            create_fn: Function to create the client
            verify_fn: Function to verify the connection (e.g., ping)
            verify_connection: Whether to verify the connection
            client_type: Client type name for logging

        Returns:
            Client if successful, None if all retries failed
        """
        config = cls._get_config()
        last_error: Optional[Exception] = None

        for attempt in range(config.max_retries):
            try:
                client = create_fn()

                if verify_connection:
                    verify_fn(client)

                if attempt > 0:
                    logger.info(
                        f"[RedisClientFactory] {client_type} Redis connected after {attempt + 1} attempts"
                    )
                else:
                    logger.info(
                        f"[RedisClientFactory] {client_type} Redis connection established"
                    )
                return client

            except Exception as e:
                last_error = e
                if attempt < config.max_retries - 1:
                    logger.warning(
                        f"[RedisClientFactory] {client_type} connection attempt {attempt + 1}/{config.max_retries} "
                        f"failed: {e}, retrying in {config.retry_delay}s..."
                    )
                    time.sleep(config.retry_delay)

        logger.error(
            f"[RedisClientFactory] Failed to connect {client_type} after {config.max_retries} attempts: {last_error}"
        )
        return None

    @classmethod
    async def _retry_async(
        cls,
        create_fn: Callable[[], T],
        verify_fn: Callable[[T], any],
        verify_connection: bool,
        client_type: str,
    ) -> Optional[T]:
        """Execute async client creation with retry logic.

        Args:
            create_fn: Function to create the client
            verify_fn: Async function to verify the connection (e.g., ping)
            verify_connection: Whether to verify the connection
            client_type: Client type name for logging

        Returns:
            Client if successful, None if all retries failed
        """
        config = cls._get_config()
        last_error: Optional[Exception] = None

        for attempt in range(config.max_retries):
            try:
                client = create_fn()

                if verify_connection:
                    await verify_fn(client)

                if attempt > 0:
                    logger.info(
                        f"[RedisClientFactory] {client_type} Redis connected after {attempt + 1} attempts"
                    )
                else:
                    logger.info(
                        f"[RedisClientFactory] {client_type} Redis connection established"
                    )
                return client

            except Exception as e:
                last_error = e
                if attempt < config.max_retries - 1:
                    logger.warning(
                        f"[RedisClientFactory] {client_type} connection attempt {attempt + 1}/{config.max_retries} "
                        f"failed: {e}, retrying in {config.retry_delay}s..."
                    )
                    await asyncio.sleep(config.retry_delay)

        logger.error(
            f"[RedisClientFactory] Failed to connect {client_type} after {config.max_retries} attempts: {last_error}"
        )
        return None

    @classmethod
    def get_sync_client(cls, verify_connection: bool = True) -> Optional[redis.Redis]:
        """Get or create a synchronous Redis client with retry on failure.

        Args:
            verify_connection: If True, verify the connection is working

        Returns:
            Redis client if successful, None if connection failed
        """
        # Check if existing client is still connected
        if cls._sync_client is not None:
            try:
                cls._sync_client.ping()
                return cls._sync_client
            except Exception:
                logger.warning(
                    "[RedisClientFactory] Connection lost, attempting reconnect..."
                )
                cls._sync_client = None

        with cls._lock:
            # Double-check after acquiring lock
            if cls._sync_client is not None:
                return cls._sync_client

            config = cls._get_config()
            client = cls._retry_sync(
                create_fn=lambda: cls._create_sync_client(config),
                verify_fn=lambda c: c.ping(),
                verify_connection=verify_connection,
                client_type="Sync",
            )

            if client is not None:
                cls._sync_client = client

            return client

    @classmethod
    async def get_async_client(
        cls, verify_connection: bool = True
    ) -> Optional[aioredis.Redis]:
        """Get or create an async Redis client with retry on failure.

        Args:
            verify_connection: If True, verify the connection is working

        Returns:
            Async Redis client if successful, None if connection failed
        """
        # Check if existing client is still connected
        if cls._async_client is not None:
            try:
                await cls._async_client.ping()
                return cls._async_client
            except Exception:
                logger.warning(
                    "[RedisClientFactory] Async connection lost, attempting reconnect..."
                )
                cls._async_client = None

        config = cls._get_config()
        client = await cls._retry_async(
            create_fn=lambda: cls._create_async_client(config),
            verify_fn=lambda c: c.ping(),
            verify_connection=verify_connection,
            client_type="Async",
        )

        if client is not None:
            cls._async_client = client

        return client

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
        return cls._retry_sync(
            create_fn=lambda: cls._create_sync_client(config),
            verify_fn=lambda c: c.ping(),
            verify_connection=verify_connection,
            client_type="New",
        )

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
