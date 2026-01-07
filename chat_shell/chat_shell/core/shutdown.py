# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Graceful shutdown manager for Kubernetes deployments.

This module provides a centralized shutdown state management system that:
1. Tracks application shutdown state
2. Monitors active streaming requests
3. Provides wait mechanism for graceful shutdown

Usage:
    from chat_shell.core.shutdown import shutdown_manager

    # Check if shutting down
    if shutdown_manager.is_shutting_down:
        return Response(status_code=503)

    # Register a streaming request
    await shutdown_manager.register_stream(request_id)

    # Wait for all streams to complete during shutdown
    await shutdown_manager.wait_for_streams(timeout=30)
"""

import asyncio
import logging
import time
from typing import Optional, Set

logger = logging.getLogger(__name__)


class ShutdownManager:
    """
    Manages graceful shutdown state for the application.

    Tracks active streaming requests and provides mechanisms to:
    - Signal shutdown initiation
    - Wait for active streams to complete
    - Cancel streams on timeout
    """

    def __init__(self):
        self._shutting_down: bool = False
        self._shutdown_event: asyncio.Event = asyncio.Event()
        self._active_streams: Set[str] = set()
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

    def get_active_streams(self) -> Set[str]:
        """Get a copy of active stream IDs."""
        return self._active_streams.copy()

    async def initiate_shutdown(self) -> None:
        """
        Initiate graceful shutdown.

        This method:
        1. Sets the shutdown flag
        2. Records shutdown start time
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

    async def register_stream(self, request_id: str) -> bool:
        """
        Register a new streaming request.

        During graceful shutdown, we still accept new streams from
        existing connections. New connections should be rejected
        at the readiness probe level.

        Args:
            request_id: The request ID for the stream

        Returns:
            bool: True if registered, False if shutdown and should reject
        """
        async with self._lock:
            # Reset shutdown event if we're adding a new stream during shutdown
            if self._shutting_down and len(self._active_streams) == 0:
                self._shutdown_event.clear()

            self._active_streams.add(request_id)
            if self._shutting_down:
                logger.info(
                    "Registered stream during shutdown: request_id=%s, active_count=%d",
                    request_id,
                    len(self._active_streams),
                )
            else:
                logger.debug(
                    "Registered stream: request_id=%s, active_count=%d",
                    request_id,
                    len(self._active_streams),
                )
            return True

    async def unregister_stream(self, request_id: str) -> None:
        """
        Unregister a streaming request.

        Args:
            request_id: The request ID to unregister
        """
        async with self._lock:
            self._active_streams.discard(request_id)
            logger.debug(
                "Unregistered stream: request_id=%s, active_count=%d",
                request_id,
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

    async def cancel_all_streams(self, cancel_events: dict[str, asyncio.Event]) -> int:
        """
        Cancel all active streaming requests.

        This is called when timeout is reached and we need to force shutdown.

        Args:
            cancel_events: Dict mapping request_id to cancel Event

        Returns:
            int: Number of streams that were cancelled
        """
        cancelled_count = 0
        streams_to_cancel = self._active_streams.copy()

        for request_id in streams_to_cancel:
            try:
                cancel_event = cancel_events.get(request_id)
                if cancel_event:
                    cancel_event.set()
                    cancelled_count += 1
                    logger.info(
                        "Cancelled stream during shutdown: request_id=%s", request_id
                    )
            except Exception as e:
                logger.error("Failed to cancel stream request_id=%s: %s", request_id, e)

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
