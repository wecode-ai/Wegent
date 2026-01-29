# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
WebSocket client for local executor mode.

This module implements a Socket.IO based WebSocket client for communicating
with the Backend server. It handles connection management, event emission,
and automatic reconnection.
"""

import asyncio
from typing import Any, Callable, Dict, Optional

import socketio

from executor.config import config
from shared.logger import setup_logger

logger = setup_logger("websocket_client")


class WebSocketClient:
    """WebSocket client using Socket.IO for Backend communication.

    Features:
    - Automatic reconnection with exponential backoff
    - Event-based messaging with local: prefix
    - Authentication via token
    - Connection state management
    """

    def __init__(
        self,
        backend_url: Optional[str] = None,
        auth_token: Optional[str] = None,
        reconnection: bool = True,
        reconnection_attempts: int = 0,  # 0 = infinite
        reconnection_delay: Optional[int] = None,
        reconnection_delay_max: Optional[int] = None,
    ):
        """Initialize the WebSocket client.

        Args:
            backend_url: Backend WebSocket URL. Defaults to config.WEGENT_BACKEND_URL.
            auth_token: Authentication token. Defaults to config.WEGENT_AUTH_TOKEN.
            reconnection: Enable automatic reconnection. Defaults to True.
            reconnection_attempts: Max reconnection attempts (0 for infinite).
            reconnection_delay: Initial reconnection delay in seconds.
            reconnection_delay_max: Maximum reconnection delay in seconds.
        """
        self.backend_url = backend_url or config.WEGENT_BACKEND_URL
        self.auth_token = auth_token or config.WEGENT_AUTH_TOKEN

        # Reconnection settings
        reconnection_delay = reconnection_delay or config.LOCAL_RECONNECT_DELAY
        reconnection_delay_max = (
            reconnection_delay_max or config.LOCAL_RECONNECT_MAX_DELAY
        )

        # Create Socket.IO async client
        self.sio = socketio.AsyncClient(
            reconnection=reconnection,
            reconnection_attempts=reconnection_attempts,
            reconnection_delay=reconnection_delay,
            reconnection_delay_max=reconnection_delay_max,
            logger=False,  # Disable socketio's internal logging
            engineio_logger=False,
        )

        # Connection state
        self._connected = False
        self._connecting = False
        self._connection_error: Optional[str] = None

        # Event handlers storage
        self._handlers: Dict[str, Callable] = {}

        # Setup internal event handlers
        self._setup_internal_handlers()

    def _setup_internal_handlers(self) -> None:
        """Setup internal event handlers for connection lifecycle.

        Note: Event handlers are registered on the /local-executor namespace
        since that's the namespace we connect to. Using @self.sio.event decorator
        would register on the default namespace, which doesn't receive events
        for custom namespaces.
        """

        @self.sio.on("connect", namespace="/local-executor")
        async def on_connect():
            self._connected = True
            self._connecting = False
            self._connection_error = None
            logger.info(
                f"WebSocket connected to {self.backend_url} (namespace: /local-executor)"
            )

        @self.sio.on("disconnect", namespace="/local-executor")
        async def on_disconnect():
            self._connected = False
            logger.info("WebSocket disconnected from /local-executor namespace")

        @self.sio.on("connect_error", namespace="/local-executor")
        async def on_connect_error(data):
            self._connected = False
            self._connecting = False
            self._connection_error = str(data) if data else "Unknown connection error"
            logger.error(f"WebSocket connection error: {self._connection_error}")

    @property
    def connected(self) -> bool:
        """Check if WebSocket is connected."""
        return self._connected

    @property
    def connection_error(self) -> Optional[str]:
        """Get the last connection error message."""
        return self._connection_error

    async def connect(self, wait_timeout: float = 30.0) -> bool:
        """Connect to the Backend WebSocket server.

        Args:
            wait_timeout: Maximum time to wait for connection in seconds.

        Returns:
            True if connected successfully, False otherwise.

        Raises:
            ValueError: If backend_url or auth_token is not configured.
        """
        if not self.backend_url:
            raise ValueError(
                "Backend URL not configured. Set WEGENT_BACKEND_URL environment variable."
            )
        if not self.auth_token:
            raise ValueError(
                "Auth token not configured. Set WEGENT_AUTH_TOKEN environment variable."
            )

        if self._connected:
            logger.info("Already connected to WebSocket")
            return True

        if self._connecting:
            logger.info("Connection already in progress")
            # Wait for existing connection attempt
            waited = 0.0
            while self._connecting and waited < wait_timeout:
                await asyncio.sleep(0.1)
                waited += 0.1
            return self._connected

        self._connecting = True
        self._connection_error = None

        try:
            logger.info(f"Connecting to WebSocket: {self.backend_url}")

            # Connect with authentication to the /local-executor namespace
            await self.sio.connect(
                self.backend_url,
                auth={"token": self.auth_token},
                transports=["websocket"],
                wait_timeout=wait_timeout,
                namespaces=["/local-executor"],
            )

            return self._connected

        except Exception as e:
            self._connecting = False
            self._connection_error = str(e)
            logger.error(f"Failed to connect to WebSocket: {e}")
            return False

    async def disconnect(self) -> None:
        """Disconnect from the WebSocket server."""
        if self._connected:
            try:
                await self.sio.disconnect()
                logger.info("WebSocket disconnected gracefully")
            except Exception as e:
                logger.warning(f"Error during WebSocket disconnect: {e}")
        self._connected = False

    async def emit(
        self, event: str, data: Dict[str, Any], callback: Optional[Callable] = None
    ) -> None:
        """Emit an event to the Backend.

        Args:
            event: Event name (should use local: prefix).
            data: Event data payload.
            callback: Optional callback for acknowledgment.

        Raises:
            ConnectionError: If not connected to WebSocket.
        """
        if not self._connected:
            raise ConnectionError("WebSocket not connected")

        try:
            if callback:
                await self.sio.emit(
                    event, data, namespace="/local-executor", callback=callback
                )
            else:
                await self.sio.emit(event, data, namespace="/local-executor")
            logger.debug(f"Emitted event: {event}")
        except Exception as e:
            logger.error(f"Failed to emit event {event}: {e}")
            raise

    def on(self, event: str, handler: Callable) -> None:
        """Register an event handler.

        Args:
            event: Event name to listen for.
            handler: Async function to handle the event.
        """
        self._handlers[event] = handler
        self.sio.on(event, handler, namespace="/local-executor")
        logger.info(
            f"Registered handler for event: {event} on namespace /local-executor"
        )

    def off(self, event: str) -> None:
        """Unregister an event handler.

        Args:
            event: Event name to stop listening for.
        """
        if event in self._handlers:
            del self._handlers[event]
        # Note: python-socketio doesn't have a direct 'off' method
        # The handler will be removed when we reassign
        logger.debug(f"Unregistered handler for event: {event}")

    async def wait(self) -> None:
        """Wait until disconnected.

        This method blocks until the WebSocket connection is closed.
        Useful for keeping the main loop running.
        """
        await self.sio.wait()
