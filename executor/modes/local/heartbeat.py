# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Heartbeat service for local executor mode.

This module implements a heartbeat service that periodically sends
heartbeat signals to the Backend via WebSocket to indicate the device
is alive and healthy.
"""

import asyncio
import math
import time
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Optional

from executor.config import config
from shared.logger import setup_logger

if TYPE_CHECKING:
    from executor.modes.local.websocket_client import WebSocketClient

logger = setup_logger("local_heartbeat")


class LocalHeartbeatService:
    """Heartbeat service for local executor mode.

    Sends periodic heartbeat signals to Backend via WebSocket using
    device:heartbeat call to get acknowledgment.
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
        self._max_failures = self._calculate_reconnect_threshold()

    def _calculate_reconnect_threshold(self) -> int:
        """Return failures allowed before reconnecting within backend TTL budget."""
        backend_timeout = max(
            float(config.LOCAL_HEARTBEAT_TIMEOUT), float(self.interval)
        )
        interval_count = math.floor((backend_timeout / float(self.interval)) + 1e-9)
        interval_budget = max(1, interval_count - 1)
        return max(1, min(3, interval_budget))

    @property
    def is_running(self) -> bool:
        """Check if heartbeat service is running."""
        return self._running

    async def start(self) -> None:
        """Start the heartbeat service."""
        if self._running:
            logger.warning("Heartbeat service already running")
            return

        self._running = True
        self._task = asyncio.create_task(self._heartbeat_loop())
        logger.info(f"Heartbeat service started: interval={self.interval}s")

    async def stop(self) -> None:
        """Stop the heartbeat service."""
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
        """Main heartbeat loop using device:heartbeat call."""
        while self._running:
            started_at = time.monotonic()
            try:
                if self.client.connected:
                    success = await self.client.send_heartbeat()
                    if success:
                        self._consecutive_failures = 0
                        logger.debug(
                            f"Heartbeat OK - {datetime.now(timezone.utc).isoformat()}"
                        )
                    else:
                        self._consecutive_failures += 1
                        logger.warning(
                            f"Heartbeat failed (attempt {self._consecutive_failures})"
                        )
                else:
                    logger.warning(
                        "Heartbeat skipped: not connected; attempting reconnect"
                    )
                    reconnected = await self.client.connect()
                    if reconnected:
                        self._consecutive_failures = 0
                        logger.info("Heartbeat reconnect succeeded")
                    else:
                        self._consecutive_failures += 1
                        logger.warning(
                            f"Heartbeat reconnect failed "
                            f"(attempt {self._consecutive_failures})"
                        )

                if self._consecutive_failures >= self._max_failures:
                    logger.error(
                        f"Heartbeat failed {self._consecutive_failures} consecutive times"
                    )
                    recovered = await self.client.reconnect()
                    if recovered:
                        self._consecutive_failures = 0
                        logger.info("Heartbeat reconnect recovery succeeded")
                    else:
                        logger.warning("Heartbeat reconnect recovery failed")

            except Exception as e:
                self._consecutive_failures += 1
                logger.warning(f"Heartbeat error: {e}")

            try:
                elapsed = time.monotonic() - started_at
                await asyncio.sleep(max(0, self.interval - elapsed))
            except asyncio.CancelledError:
                break
