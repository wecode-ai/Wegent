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
- Robust counter management with anomaly detection and auto-correction

Usage:
1. Set service status to 503 before shutdown
2. Wait for active requests to complete
3. Shutdown the service
"""

import asyncio
import logging
import time
from enum import Enum
from typing import Optional

import redis.asyncio as aioredis

from app.core.config import settings

logger = logging.getLogger(__name__)

# Redis keys for graceful shutdown management
REDIS_KEY_PREFIX = "wegent:graceful_shutdown:"
SERVICE_STATUS_KEY = f"{REDIS_KEY_PREFIX}service_status"
ACTIVE_REQUESTS_KEY = f"{REDIS_KEY_PREFIX}active_requests"
# Per-request tracking key prefix (for anomaly detection)
REQUEST_TRACKING_KEY_PREFIX = f"{REDIS_KEY_PREFIX}request:"
# TTL for service status key (1 hour) - prevents stale state if service crashes
SERVICE_STATUS_TTL = 3600
# TTL for active requests key (10 minutes) - auto-cleanup if service crashes
ACTIVE_REQUESTS_TTL = 600
# TTL for individual request tracking (5 minutes) - detect orphaned requests
REQUEST_TRACKING_TTL = 300
# Maximum allowed counter value (sanity check)
MAX_COUNTER_VALUE = 10000
# Counter anomaly threshold (if counter jumps by more than this, it's anomalous)
COUNTER_ANOMALY_THRESHOLD = 100


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
    4. Counter anomaly detection and auto-correction

    The state is stored in Redis with TTL to prevent stale data
    if the service crashes unexpectedly.
    """

    _instance: Optional["GracefulShutdownManager"] = None
    _redis_client: Optional[aioredis.Redis] = None
    _initialized: bool = False
    _last_known_count: int = 0
    _anomaly_count: int = 0

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
            self._last_known_count = 0
            self._anomaly_count = 0
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

    async def increment_active_requests(self, request_id: Optional[str] = None) -> int:
        """
        Increment the active request counter.

        Args:
            request_id: Optional unique request ID for tracking

        Returns:
            The new count of active requests
        """
        if not self._initialized or not self._redis_client:
            return 0

        try:
            # Use Lua script for atomic increment with bounds checking
            lua_script = """
            local current = redis.call('GET', KEYS[1])
            if current == false then
                current = 0
            else
                current = tonumber(current)
            end

            -- Sanity check: don't let counter exceed maximum
            if current >= tonumber(ARGV[1]) then
                return current
            end

            local new_count = redis.call('INCR', KEYS[1])
            redis.call('EXPIRE', KEYS[1], ARGV[2])
            return new_count
            """

            count = await self._redis_client.eval(
                lua_script,
                1,
                ACTIVE_REQUESTS_KEY,
                str(MAX_COUNTER_VALUE),
                str(ACTIVE_REQUESTS_TTL),
            )

            # Track individual request if request_id provided
            if request_id:
                request_key = f"{REQUEST_TRACKING_KEY_PREFIX}{request_id}"
                await self._redis_client.set(
                    request_key,
                    str(time.time()),
                    ex=REQUEST_TRACKING_TTL,
                )

            # Anomaly detection: check for unexpected jumps
            if count is not None:
                count = int(count)
                if (
                    count - self._last_known_count > COUNTER_ANOMALY_THRESHOLD
                    and self._last_known_count > 0
                ):
                    self._anomaly_count += 1
                    logger.warning(
                        f"Counter anomaly detected: jumped from {self._last_known_count} to {count}. "
                        f"Anomaly count: {self._anomaly_count}"
                    )
                self._last_known_count = count

            return count if count else 0

        except Exception as e:
            logger.error(f"Failed to increment active requests: {e}")
            return 0

    async def decrement_active_requests(self, request_id: Optional[str] = None) -> int:
        """
        Decrement the active request counter safely.

        Uses Lua script to ensure atomicity and prevent negative values.

        Args:
            request_id: Optional unique request ID for tracking

        Returns:
            The new count of active requests (minimum 0)
        """
        if not self._initialized or not self._redis_client:
            return 0

        try:
            # Use Lua script for atomic decrement with floor at 0
            lua_script = """
            local current = redis.call('GET', KEYS[1])
            if current == false or tonumber(current) <= 0 then
                redis.call('SET', KEYS[1], 0)
                redis.call('EXPIRE', KEYS[1], ARGV[1])
                return 0
            end

            local new_count = redis.call('DECR', KEYS[1])
            if new_count < 0 then
                redis.call('SET', KEYS[1], 0)
                new_count = 0
            end
            redis.call('EXPIRE', KEYS[1], ARGV[1])
            return new_count
            """

            count = await self._redis_client.eval(
                lua_script,
                1,
                ACTIVE_REQUESTS_KEY,
                str(ACTIVE_REQUESTS_TTL),
            )

            # Remove individual request tracking if request_id provided
            if request_id:
                request_key = f"{REQUEST_TRACKING_KEY_PREFIX}{request_id}"
                await self._redis_client.delete(request_key)

            if count is not None:
                count = int(count)
                self._last_known_count = count

            return count if count else 0

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
            result = int(count) if count else 0

            # Sanity check: if count is negative or unreasonably high, correct it
            if result < 0:
                logger.warning(f"Counter was negative ({result}), resetting to 0")
                await self.reset_active_requests()
                return 0

            if result > MAX_COUNTER_VALUE:
                logger.warning(
                    f"Counter exceeded maximum ({result} > {MAX_COUNTER_VALUE}), "
                    "this may indicate a leak. Consider resetting."
                )

            return result
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
            self._last_known_count = 0
            self._anomaly_count = 0
            logger.info("Active requests counter reset to 0")
            return True
        except Exception as e:
            logger.error(f"Failed to reset active requests counter: {e}")
            return False

    async def cleanup_orphaned_requests(self) -> int:
        """
        Clean up orphaned request tracking keys.

        This detects requests that were tracked but never completed
        (e.g., due to a crash or bug). If orphaned requests are found,
        the counter may be adjusted.

        Returns:
            Number of orphaned requests found and cleaned
        """
        if not self._initialized or not self._redis_client:
            return 0

        try:
            # Find all request tracking keys
            pattern = f"{REQUEST_TRACKING_KEY_PREFIX}*"
            orphaned_count = 0
            cursor = 0

            while True:
                cursor, keys = await self._redis_client.scan(
                    cursor=cursor, match=pattern, count=100
                )

                for key in keys:
                    timestamp_str = await self._redis_client.get(key)
                    if timestamp_str:
                        try:
                            timestamp = float(timestamp_str)
                            # If request has been tracked for too long, it's orphaned
                            if time.time() - timestamp > REQUEST_TRACKING_TTL:
                                await self._redis_client.delete(key)
                                orphaned_count += 1
                                logger.warning(f"Cleaned up orphaned request: {key}")
                        except (ValueError, TypeError):
                            await self._redis_client.delete(key)
                            orphaned_count += 1

                if cursor == 0:
                    break

            if orphaned_count > 0:
                logger.warning(
                    f"Found and cleaned {orphaned_count} orphaned request tracking keys. "
                    "Counter may need manual adjustment."
                )

            return orphaned_count

        except Exception as e:
            logger.error(f"Failed to cleanup orphaned requests: {e}")
            return 0

    async def get_diagnostics(self) -> dict:
        """
        Get diagnostic information about the counter state.

        Returns:
            Dictionary with diagnostic information
        """
        if not self._initialized or not self._redis_client:
            return {
                "initialized": False,
                "error": "Manager not initialized",
            }

        try:
            count = await self.get_active_requests_count()

            # Count tracked requests
            pattern = f"{REQUEST_TRACKING_KEY_PREFIX}*"
            tracked_count = 0
            cursor = 0
            while True:
                cursor, keys = await self._redis_client.scan(
                    cursor=cursor, match=pattern, count=100
                )
                tracked_count += len(keys)
                if cursor == 0:
                    break

            return {
                "initialized": True,
                "active_requests": count,
                "tracked_requests": tracked_count,
                "last_known_count": self._last_known_count,
                "anomaly_count": self._anomaly_count,
                "counter_matches_tracked": count == tracked_count,
                "max_counter_value": MAX_COUNTER_VALUE,
                "ttl_seconds": ACTIVE_REQUESTS_TTL,
            }
        except Exception as e:
            return {
                "initialized": True,
                "error": str(e),
            }

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
