# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Graceful shutdown management module.

This module provides process-safe service status management using Redis
to coordinate graceful shutdown across multiple FastAPI workers.

Features:
- Service status (200/503) management for load balancer health checks
- Active request tracking for ongoing HTTP requests (including streams)
- Process-safe state management via Redis

Usage:
1. Set service status to 503 before shutdown
2. Wait for active requests to complete
3. Shutdown the service
"""

import asyncio
import logging
from enum import Enum
from typing import Optional

import redis.asyncio as aioredis

from app.core.config import settings

logger = logging.getLogger(__name__)

# Redis keys for graceful shutdown management
REDIS_KEY_PREFIX = "wegent:graceful_shutdown:"
SERVICE_STATUS_KEY = f"{REDIS_KEY_PREFIX}service_status"
ACTIVE_REQUESTS_KEY = f"{REDIS_KEY_PREFIX}active_requests"
# TTL for service status key (1 hour) - prevents stale state if service crashes
SERVICE_STATUS_TTL = 3600


class ServiceStatus(str, Enum):
    """Service status enum for health check responses."""

    HEALTHY = "healthy"  # Returns 200
    DRAINING = "draining"  # Returns 503, service is preparing to shutdown


class GracefulShutdownManager:
    """
    Manager for graceful shutdown operations.

    This class uses Redis to maintain process-safe state that can be
    shared across multiple FastAPI workers. It provides:

    1. Service status management (healthy/draining)
    2. Active request counter for tracking in-flight requests
    3. Coordination for graceful shutdown process

    The state is stored in Redis with TTL to prevent stale data
    if the service crashes unexpectedly.
    """

    _instance: Optional["GracefulShutdownManager"] = None
    _redis_client: Optional[aioredis.Redis] = None
    _initialized: bool = False

    def __new__(cls):
        """Singleton pattern to ensure single manager instance per process."""
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    async def initialize(self) -> None:
        """
        Initialize the Redis connection for graceful shutdown management.

        Should be called during application startup.
        """
        if self._initialized:
            return

        try:
            self._redis_client = aioredis.from_url(
                settings.REDIS_URL,
                encoding="utf-8",
                decode_responses=True,
            )
            # Test connection
            await self._redis_client.ping()
            self._initialized = True
            logger.info("Graceful shutdown manager initialized with Redis")

            # Set initial status to healthy if not already set
            current_status = await self._redis_client.get(SERVICE_STATUS_KEY)
            if current_status is None:
                await self.set_service_status(ServiceStatus.HEALTHY)
                logger.info("Service status initialized to HEALTHY")

        except Exception as e:
            logger.warning(
                f"Failed to initialize Redis for graceful shutdown: {e}. "
                "Graceful shutdown features will be limited."
            )
            self._initialized = False

    async def close(self) -> None:
        """Close the Redis connection."""
        if self._redis_client:
            await self._redis_client.aclose()
            self._redis_client = None
            self._initialized = False
            logger.info("Graceful shutdown manager closed")

    async def set_service_status(self, status: ServiceStatus) -> bool:
        """
        Set the service status.

        Args:
            status: The service status to set (HEALTHY or DRAINING)

        Returns:
            True if status was set successfully, False otherwise
        """
        if not self._initialized or not self._redis_client:
            logger.warning("Graceful shutdown manager not initialized")
            return False

        try:
            await self._redis_client.set(
                SERVICE_STATUS_KEY,
                status.value,
                ex=SERVICE_STATUS_TTL,
            )
            logger.info(f"Service status set to {status.value}")
            return True
        except Exception as e:
            logger.error(f"Failed to set service status: {e}")
            return False

    async def get_service_status(self) -> ServiceStatus:
        """
        Get the current service status.

        Returns:
            ServiceStatus.HEALTHY or ServiceStatus.DRAINING
        """
        if not self._initialized or not self._redis_client:
            # Default to healthy if Redis is not available
            return ServiceStatus.HEALTHY

        try:
            status = await self._redis_client.get(SERVICE_STATUS_KEY)
            if status == ServiceStatus.DRAINING.value:
                return ServiceStatus.DRAINING
            return ServiceStatus.HEALTHY
        except Exception as e:
            logger.error(f"Failed to get service status: {e}")
            return ServiceStatus.HEALTHY

    async def increment_active_requests(self) -> int:
        """
        Increment the active request counter.

        Returns:
            The new count of active requests
        """
        if not self._initialized or not self._redis_client:
            return 0

        try:
            count = await self._redis_client.incr(ACTIVE_REQUESTS_KEY)
            # Set TTL on the key to auto-cleanup if service crashes
            # Use a reasonable TTL (e.g., 10 minutes) that's longer than
            # the longest expected request duration
            await self._redis_client.expire(ACTIVE_REQUESTS_KEY, 600)
            return count
        except Exception as e:
            logger.error(f"Failed to increment active requests: {e}")
            return 0

    async def decrement_active_requests(self) -> int:
        """
        Decrement the active request counter.

        Returns:
            The new count of active requests (minimum 0)
        """
        if not self._initialized or not self._redis_client:
            return 0

        try:
            count = await self._redis_client.decr(ACTIVE_REQUESTS_KEY)
            # Ensure count doesn't go below 0
            if count < 0:
                await self._redis_client.set(ACTIVE_REQUESTS_KEY, 0)
                count = 0
            return count
        except Exception as e:
            logger.error(f"Failed to decrement active requests: {e}")
            return 0

    async def get_active_requests_count(self) -> int:
        """
        Get the current count of active requests.

        Returns:
            The number of active requests
        """
        if not self._initialized or not self._redis_client:
            return 0

        try:
            count = await self._redis_client.get(ACTIVE_REQUESTS_KEY)
            return int(count) if count else 0
        except Exception as e:
            logger.error(f"Failed to get active requests count: {e}")
            return 0

    async def reset_active_requests(self) -> bool:
        """
        Reset the active request counter to 0.

        This should typically only be used during service startup
        to clear any stale counters from previous runs.

        Returns:
            True if reset was successful, False otherwise
        """
        if not self._initialized or not self._redis_client:
            return False

        try:
            await self._redis_client.set(ACTIVE_REQUESTS_KEY, 0)
            logger.info("Active requests counter reset to 0")
            return True
        except Exception as e:
            logger.error(f"Failed to reset active requests counter: {e}")
            return False

    async def wait_for_requests_completion(
        self,
        timeout: float = 30.0,
        poll_interval: float = 0.5,
    ) -> bool:
        """
        Wait for all active requests to complete.

        Args:
            timeout: Maximum time to wait in seconds
            poll_interval: Time between checks in seconds

        Returns:
            True if all requests completed within timeout, False otherwise
        """
        if not self._initialized:
            return True

        elapsed = 0.0
        while elapsed < timeout:
            count = await self.get_active_requests_count()
            if count <= 0:
                logger.info("All active requests completed")
                return True

            logger.info(
                f"Waiting for {count} active requests to complete... "
                f"({elapsed:.1f}s/{timeout}s)"
            )
            await asyncio.sleep(poll_interval)
            elapsed += poll_interval

        remaining = await self.get_active_requests_count()
        logger.warning(
            f"Timeout waiting for requests to complete. "
            f"{remaining} requests still active after {timeout}s"
        )
        return False


# Global singleton instance
graceful_shutdown_manager = GracefulShutdownManager()
