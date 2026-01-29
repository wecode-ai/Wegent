# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
WebSocket client for local executor mode.

This module implements a Socket.IO based WebSocket client aligned with
the LocalDeviceClient protocol for communicating with the Backend server.
"""

import asyncio
import platform
import uuid
from typing import Any, Callable, Dict, Optional

import socketio

from executor.config import config
from shared.logger import setup_logger

logger = setup_logger("websocket_client")


class WebSocketClient:
    """WebSocket client using Socket.IO for Backend communication.

    Features:
    - Automatic reconnection with exponential backoff
    - Device-based registration with unique device_id
    - Authentication via JWT token
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
        self.auth_token = self._normalize_token(auth_token or config.WEGENT_AUTH_TOKEN)

        # Device identification
        self.device_id = self._generate_device_id()
        self.device_name = self._get_device_name()
        self.mac_address = self._get_mac_address()

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
            logger=False,
            engineio_logger=False,
        )

        # Connection state
        self._connected = False
        self._connecting = False
        self._registered = False
        self._was_registered = False  # Track if we were ever registered (for reconnect)
        self._connection_error: Optional[str] = None

        # Reconnect callback
        self._on_reconnect_callback: Optional[Callable] = None

        # Event handlers storage
        self._handlers: Dict[str, Callable] = {}

        # Setup internal event handlers
        self._setup_internal_handlers()

    def _normalize_token(self, token: str) -> str:
        """Normalize JWT token by stripping optional Bearer prefix."""
        if not token:
            return ""
        token = token.strip()
        if token.lower().startswith("bearer "):
            return token.split(" ", 1)[1]
        return token

    def _generate_device_id(self) -> str:
        """Generate unique device ID based on MAC address."""
        mac = uuid.getnode()
        return f"mac-{mac:012x}"

    def _get_mac_address(self) -> str:
        """Get formatted MAC address."""
        mac = uuid.getnode()
        # Format as XX:XX:XX:XX:XX:XX
        return ":".join(f"{(mac >> (8 * i)) & 0xff:02x}" for i in reversed(range(6)))

    def _get_device_name(self) -> str:
        """Get device name from system."""
        return f"{platform.system()} - {platform.node()}"

    def _setup_internal_handlers(self) -> None:
        """Setup internal event handlers for connection lifecycle."""

        @self.sio.on("connect", namespace="/local-executor")
        async def on_connect():
            self._connected = True
            self._connecting = False
            self._connection_error = None
            logger.info(
                f"WebSocket connected to {self.backend_url} (namespace: /local-executor)"
            )
            # Auto re-register on reconnect if we were previously registered
            if self._was_registered and not self._registered:
                logger.info("Reconnected, auto re-registering device...")
                try:
                    success = await self.register_device()
                    if success:
                        logger.info("Device re-registered successfully")
                    else:
                        logger.error("Device re-registration failed")
                except Exception as e:
                    logger.error(f"Auto re-register failed: {e}")

        @self.sio.on("disconnect", namespace="/local-executor")
        async def on_disconnect():
            self._connected = False
            self._registered = False
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
    def registered(self) -> bool:
        """Check if device is registered."""
        return self._registered

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
            waited = 0.0
            while self._connecting and waited < wait_timeout:
                await asyncio.sleep(0.1)
                waited += 0.1
            return self._connected

        self._connecting = True
        self._connection_error = None

        try:
            logger.info(f"Connecting to WebSocket: {self.backend_url}")

            await self.sio.connect(
                self.backend_url,
                auth={"token": self.auth_token},
                transports=["websocket"],
                wait_timeout=wait_timeout,
                namespaces=["/local-executor"],
                socketio_path="/socket.io",
            )

            return self._connected

        except Exception as e:
            self._connecting = False
            self._connection_error = str(e)
            logger.error(f"Failed to connect to WebSocket: {e}")
            return False

    async def register_device(self, timeout: float = 10.0) -> bool:
        """Register device with Backend using call (request-response).

        Args:
            timeout: Timeout for registration response.

        Returns:
            True if registered successfully, False otherwise.
        """
        if not self._connected:
            raise ConnectionError("WebSocket not connected")

        try:
            logger.info(
                f"Registering device: id={self.device_id}, name={self.device_name}, mac={self.mac_address}"
            )

            response = await self.sio.call(
                "device:register",
                {
                    "device_id": self.device_id,
                    "name": self.device_name,
                    "mac_address": self.mac_address,
                },
                namespace="/local-executor",
                timeout=timeout,
            )

            if response and response.get("success"):
                self._registered = True
                self._was_registered = (
                    True  # Mark that we were registered at least once
                )
                logger.info(f"Device registered successfully: {self.device_id}")
                return True
            else:
                error = (
                    response.get("error", "Unknown error")
                    if response
                    else "No response"
                )
                logger.error(f"Device registration failed: {error}")
                return False

        except asyncio.TimeoutError:
            logger.error("Device registration timeout")
            return False
        except Exception as e:
            logger.error(f"Device registration error: {e}")
            return False

    async def send_heartbeat(self, timeout: float = 5.0) -> bool:
        """Send heartbeat to Backend using call (request-response).

        Args:
            timeout: Timeout for heartbeat response.

        Returns:
            True if heartbeat acknowledged, False otherwise.
        """
        if not self._connected:
            raise ConnectionError("WebSocket not connected")

        try:
            response = await self.sio.call(
                "device:heartbeat",
                {"device_id": self.device_id},
                namespace="/local-executor",
                timeout=timeout,
            )

            if response and response.get("success"):
                logger.debug(f"Heartbeat OK for device {self.device_id}")
                return True
            else:
                error = (
                    response.get("error", "Unknown error")
                    if response
                    else "No response"
                )
                logger.warning(f"Heartbeat failed: {error}")
                return False

        except asyncio.TimeoutError:
            logger.warning("Heartbeat timeout")
            return False
        except Exception as e:
            logger.warning(f"Heartbeat error: {e}")
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
        self._registered = False

    async def emit(
        self, event: str, data: Dict[str, Any], callback: Optional[Callable] = None
    ) -> None:
        """Emit an event to the Backend.

        Args:
            event: Event name.
            data: Event data payload.
            callback: Optional callback for acknowledgment.
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

    async def call(
        self, event: str, data: Dict[str, Any], timeout: float = 10.0
    ) -> Optional[Dict[str, Any]]:
        """Call an event and wait for response.

        Args:
            event: Event name.
            data: Event data payload.
            timeout: Timeout in seconds.

        Returns:
            Response data or None if failed.
        """
        if not self._connected:
            raise ConnectionError("WebSocket not connected")

        try:
            response = await self.sio.call(
                event, data, namespace="/local-executor", timeout=timeout
            )
            return response
        except Exception as e:
            logger.error(f"Failed to call event {event}: {e}")
            return None

    def on(self, event: str, handler: Callable) -> None:
        """Register an event handler.

        Args:
            event: Event name to listen for.
            handler: Async function to handle the event.
        """
        self._handlers[event] = handler
        self.sio.on(event, handler, namespace="/local-executor")
        logger.info(f"Registered handler for event: {event}")

    def off(self, event: str) -> None:
        """Unregister an event handler.

        Args:
            event: Event name to stop listening for.
        """
        if event in self._handlers:
            del self._handlers[event]
        logger.debug(f"Unregistered handler for event: {event}")

    async def wait(self) -> None:
        """Wait until disconnected."""
        await self.sio.wait()
