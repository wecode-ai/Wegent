# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Heartbeat service for local executor mode.

This module implements a heartbeat service that periodically sends
heartbeat signals to the Backend via WebSocket to indicate the executor
is alive and healthy.
"""

import asyncio
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Optional

from executor.config import config
from executor.modes.local.events import LocalExecutorEvents
from shared.logger import setup_logger

if TYPE_CHECKING:
    from executor.modes.local.websocket_client import WebSocketClient

logger = setup_logger("local_heartbeat")


class LocalHeartbeatService:
    """Heartbeat service for local executor mode.

    Sends periodic heartbeat signals to Backend via WebSocket to:
    - Indicate executor is alive
    - Allow Backend to detect executor failures
    - Maintain connection health

    Note: The heartbeat timeout is managed by the Backend, not the client.
    """

    def __init__(
        self,
        websocket_client: "WebSocketClient",
        interval: Optional[int] = None,
    ):
        """Initialize the heartbeat service.

        Args:
            websocket_client: WebSocket client for sending heartbeats.
            interval: Heartbeat interval in seconds. Defaults to config value.
        """
        self.client = websocket_client
        self.interval = interval or config.LOCAL_HEARTBEAT_INTERVAL

        self._running = False
        self._task: Optional[asyncio.Task] = None
        self._consecutive_failures = 0
        self._max_failures = 3  # Log warning after consecutive failures

    @property
    def is_running(self) -> bool:
        """Check if heartbeat service is running."""
        return self._running

    async def start(self) -> None:
        """Start the heartbeat service.

        Creates an async task that runs the heartbeat loop.
        """
        if self._running:
            logger.warning("Heartbeat service already running")
            return

        self._running = True
        self._task = asyncio.create_task(self._heartbeat_loop())
        logger.info(f"Heartbeat service started: interval={self.interval}s")

    async def stop(self) -> None:
        """Stop the heartbeat service.

        Cancels the heartbeat task and waits for it to complete.
        """
        if not self._running:
            return

        self._running = False

        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

        logger.info("Heartbeat service stopped")

    async def _heartbeat_loop(self) -> None:
        """Main heartbeat loop.

        Sends heartbeat signals at regular intervals until stopped.
        """
        while self._running:
            try:
                await self._send_heartbeat()
                self._consecutive_failures = 0
            except Exception as e:
                self._consecutive_failures += 1
                logger.warning(f"Heartbeat failed: {e}")

                if self._consecutive_failures >= self._max_failures:
                    logger.error(
                        f"Heartbeat failed {self._consecutive_failures} consecutive times"
                    )

            # Wait for next heartbeat interval
            try:
                await asyncio.sleep(self.interval)
            except asyncio.CancelledError:
                break

    async def _send_heartbeat(self) -> None:
        """Send a single heartbeat to Backend.

        Raises:
            Exception: If heartbeat emission fails.
        """
        if not self.client.connected:
            raise ConnectionError("WebSocket not connected")

        timestamp = datetime.now(timezone.utc).isoformat()

        await self.client.emit(
            LocalExecutorEvents.HEARTBEAT,
            {
                "timestamp": timestamp,
                "status": "alive",
            },
        )

        logger.debug(f"Heartbeat sent: timestamp={timestamp}")
