# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Graceful shutdown manager for Kubernetes deployments.

This module provides a centralized shutdown state management system that:
1. Tracks application shutdown state
2. Monitors active streaming requests
3. Provides wait mechanism for graceful shutdown
4. Supports cross-worker communication via Redis

Usage:
    from app.core.shutdown import shutdown_manager

    # Check if shutting down
    if shutdown_manager.is_shutting_down:
        return Response(status_code=503)

    # Register a streaming request
    await shutdown_manager.register_stream(subtask_id)

    # Wait for all streams to complete during shutdown
    await shutdown_manager.wait_for_streams(timeout=30)
"""

import asyncio
import logging
import time
from typing import Optional, Set

logger = logging.getLogger(__name__)

# Redis key for shutdown state (cross-worker communication)
SHUTDOWN_STATE_KEY = "wegent:shutdown_state"
SHUTDOWN_STATE_TTL = 120  # 2 minutes TTL for shutdown state


class ShutdownManager:
    """
    Manages graceful shutdown state for the application.

    Tracks active streaming requests and provides mechanisms to:
    - Signal shutdown initiation
    - Wait for active streams to complete
    - Continue accepting new requests during shutdown (graceful)
    """

    def __init__(self):
        self._shutting_down: bool = False
        self._shutdown_event: asyncio.Event = asyncio.Event()
        self._active_streams: Set[int] = set()
        self._lock: asyncio.Lock = asyncio.Lock()
        self._shutdown_start_time: Optional[float] = None

    @property
    def is_shutting_down(self) -> bool:
        """Check if the application is in shutdown state."""
        return self._shutting_down

    @property
    def shutdown_duration(self) -> float:
        """Get the duration since shutdown started (in seconds)."""
        if self._shutdown_start_time is None:
            return 0.0
        return time.time() - self._shutdown_start_time

    def get_active_stream_count(self) -> int:
        """Get the number of active streaming requests."""
        return len(self._active_streams)

    def get_active_streams(self) -> Set[int]:
        """Get a copy of active stream IDs."""
        return self._active_streams.copy()

    async def initiate_shutdown(self) -> None:
        """
        Initiate graceful shutdown.

        This method:
        1. Sets the shutdown flag
        2. Records shutdown start time
        3. Optionally notifies other workers via Redis
        """
        async with self._lock:
            if self._shutting_down:
                logger.warning("Shutdown already initiated")
                return

            self._shutting_down = True
            self._shutdown_start_time = time.time()
            logger.info(
                "Graceful shutdown initiated. Active streams: %d",
                len(self._active_streams),
            )

            # Try to notify other workers via Redis
            await self._notify_shutdown_via_redis()

    async def _notify_shutdown_via_redis(self) -> None:
        """Notify other workers about shutdown via Redis."""
        try:
            from app.core.cache import cache_manager

            await cache_manager.set(
                SHUTDOWN_STATE_KEY,
                {"shutting_down": True, "timestamp": time.time()},
                expire=SHUTDOWN_STATE_TTL,
            )
            logger.debug("Shutdown state published to Redis")
        except Exception as e:
            logger.warning("Failed to publish shutdown state to Redis: %s", e)

    async def register_stream(self, subtask_id: int) -> bool:
        """
        Register a new streaming request.

        Note: During graceful shutdown, we still accept new streams from
        existing WebSocket connections. New WebSocket connections are rejected
        at the connection level (on_connect), but requests from already
        connected clients should be allowed to complete gracefully.

        Args:
            subtask_id: The subtask ID for the stream

        Returns:
            bool: Always True (registration always succeeds)
        """
        async with self._lock:
            # Reset shutdown event if we're adding a new stream during shutdown
            # This ensures wait_for_streams will wait for this new stream too
            if self._shutting_down and len(self._active_streams) == 0:
                self._shutdown_event.clear()

            self._active_streams.add(subtask_id)
            if self._shutting_down:
                logger.info(
                    "Registered stream during shutdown (from existing connection): "
                    "subtask_id=%d, active_count=%d",
                    subtask_id,
                    len(self._active_streams),
                )
            else:
                logger.debug(
                    "Registered stream: subtask_id=%d, active_count=%d",
                    subtask_id,
                    len(self._active_streams),
                )
            return True

    async def unregister_stream(self, subtask_id: int) -> None:
        """
        Unregister a streaming request.

        Args:
            subtask_id: The subtask ID to unregister
        """
        async with self._lock:
            self._active_streams.discard(subtask_id)
            logger.debug(
                "Unregistered stream: subtask_id=%d, active_count=%d",
                subtask_id,
                len(self._active_streams),
            )

            # If shutting down and no more streams, set the event
            if self._shutting_down and len(self._active_streams) == 0:
                self._shutdown_event.set()
                logger.info("All streams completed, shutdown can proceed")

    async def wait_for_streams(self, timeout: float = 30.0) -> bool:
        """
        Wait for all active streams to complete.

        Args:
            timeout: Maximum time to wait in seconds

        Returns:
            bool: True if all streams completed, False if timeout
        """
        if len(self._active_streams) == 0:
            logger.info("No active streams, proceeding with shutdown")
            return True

        logger.info(
            "Waiting for %d active streams to complete (timeout: %.1fs)",
            len(self._active_streams),
            timeout,
        )

        try:
            await asyncio.wait_for(self._shutdown_event.wait(), timeout=timeout)
            logger.info("All streams completed within timeout")
            return True
        except asyncio.TimeoutError:
            remaining = len(self._active_streams)
            logger.warning(
                "Timeout waiting for streams. %d streams still active: %s",
                remaining,
                list(self._active_streams),
            )
            return False

    async def cancel_all_streams(self) -> int:
        """
        Cancel all active streaming requests.

        This is called when timeout is reached and we need to force shutdown.

        Returns:
            int: Number of streams that were cancelled
        """
        from app.services.chat.storage import session_manager

        cancelled_count = 0
        streams_to_cancel = self._active_streams.copy()

        for subtask_id in streams_to_cancel:
            try:
                await session_manager.cancel_stream(subtask_id)
                cancelled_count += 1
                logger.info(
                    "Cancelled stream during shutdown: subtask_id=%d", subtask_id
                )
            except Exception as e:
                logger.error("Failed to cancel stream subtask_id=%d: %s", subtask_id, e)

        return cancelled_count

    def reset(self) -> None:
        """
        Reset shutdown state (for testing purposes).

        WARNING: This should only be used in tests.
        """
        self._shutting_down = False
        self._shutdown_event.clear()
        self._active_streams.clear()
        self._shutdown_start_time = None
        logger.debug("Shutdown manager state reset")


# Global shutdown manager instance
shutdown_manager = ShutdownManager()
