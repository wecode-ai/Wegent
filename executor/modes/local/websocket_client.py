# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
WebSocket client for local executor mode.

This module implements a Socket.IO based WebSocket client aligned with
the LocalDeviceClient protocol for communicating with the Backend server.
"""

import asyncio
import hashlib
import os
import platform
import re
import subprocess
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, Optional

import socketio

from executor.config import config
from shared.logger import setup_logger

logger = setup_logger("websocket_client")

# Device ID cache file location
DEVICE_ID_CACHE_FILE = Path.home() / ".wegent-executor" / "device_id"


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
        """Generate stable unique device ID.

        Priority:
        1. Cached device ID from file (ensures stability across restarts)
        2. Hardware UUID (macOS) or machine-id (Linux)
        3. Fallback to MAC address based ID

        Returns:
            Stable device ID string.
        """
        # Try to load cached device ID first
        cached_id = self._load_cached_device_id()
        if cached_id:
            logger.debug(f"Using cached device ID: {cached_id}")
            return cached_id

        # Generate new device ID
        device_id = self._get_hardware_id()
        if not device_id:
            # Fallback to MAC address
            mac = uuid.getnode()
            # Check if MAC is random (bit 0 of first byte is 1)
            if mac & 0x010000000000:
                logger.warning("MAC address appears to be random, using UUID fallback")
                device_id = f"uuid-{uuid.uuid4().hex[:12]}"
            else:
                device_id = f"mac-{mac:012x}"

        # Cache the device ID for future use
        self._save_cached_device_id(device_id)
        logger.info(f"Generated new device ID: {device_id}")
        return device_id

    def _get_hardware_id(self) -> Optional[str]:
        """Get hardware-based unique ID from the system.

        Returns:
            Hardware ID string or None if not available.
        """
        system = platform.system()

        try:
            if system == "Darwin":
                # macOS: Use IOPlatformUUID (Hardware UUID)
                result = subprocess.run(
                    [
                        "ioreg",
                        "-rd1",
                        "-c",
                        "IOPlatformExpertDevice",
                    ],
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
                if result.returncode == 0:
                    match = re.search(
                        r'"IOPlatformUUID"\s*=\s*"([^"]+)"', result.stdout
                    )
                    if match:
                        hw_uuid = match.group(1)
                        # Hash to create shorter ID
                        hashed = hashlib.sha256(hw_uuid.encode()).hexdigest()[:12]
                        return f"hw-{hashed}"

            elif system == "Linux":
                # Linux: Use /etc/machine-id
                machine_id_path = Path("/etc/machine-id")
                if machine_id_path.exists():
                    machine_id = machine_id_path.read_text().strip()
                    if machine_id:
                        hashed = hashlib.sha256(machine_id.encode()).hexdigest()[:12]
                        return f"hw-{hashed}"

                # Fallback: /var/lib/dbus/machine-id
                dbus_id_path = Path("/var/lib/dbus/machine-id")
                if dbus_id_path.exists():
                    machine_id = dbus_id_path.read_text().strip()
                    if machine_id:
                        hashed = hashlib.sha256(machine_id.encode()).hexdigest()[:12]
                        return f"hw-{hashed}"

            elif system == "Windows":
                # Windows: Use MachineGuid from registry
                result = subprocess.run(
                    [
                        "reg",
                        "query",
                        r"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Cryptography",
                        "/v",
                        "MachineGuid",
                    ],
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
                if result.returncode == 0:
                    match = re.search(r"MachineGuid\s+REG_SZ\s+(\S+)", result.stdout)
                    if match:
                        machine_guid = match.group(1)
                        hashed = hashlib.sha256(machine_guid.encode()).hexdigest()[:12]
                        return f"hw-{hashed}"

        except Exception as e:
            logger.warning(f"Failed to get hardware ID: {e}")

        return None

    def _load_cached_device_id(self) -> Optional[str]:
        """Load cached device ID from file.

        Returns:
            Cached device ID or None if not exists.
        """
        try:
            if DEVICE_ID_CACHE_FILE.exists():
                device_id = DEVICE_ID_CACHE_FILE.read_text().strip()
                if device_id:
                    return device_id
        except Exception as e:
            logger.warning(f"Failed to load cached device ID: {e}")
        return None

    def _save_cached_device_id(self, device_id: str) -> None:
        """Save device ID to cache file.

        Args:
            device_id: Device ID to cache.
        """
        try:
            DEVICE_ID_CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
            DEVICE_ID_CACHE_FILE.write_text(device_id)
            # Set restrictive permissions (owner read/write only)
            os.chmod(DEVICE_ID_CACHE_FILE, 0o600)
            logger.debug(f"Cached device ID to {DEVICE_ID_CACHE_FILE}")
        except Exception as e:
            logger.warning(f"Failed to cache device ID: {e}")

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
            register_data = {
                "device_id": self.device_id,
                "name": self.device_name,
            }
            logger.info(f"Sending device:register to /local-executor: {register_data}")

            response = await self.sio.call(
                "device:register",
                register_data,
                namespace="/local-executor",
                timeout=timeout,
            )
            logger.info(f"device:register response: {response}")

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
            heartbeat_data = {"device_id": self.device_id}
            logger.debug(
                f"Sending device:heartbeat to /local-executor: {heartbeat_data}"
            )
            response = await self.sio.call(
                "device:heartbeat",
                heartbeat_data,
                namespace="/local-executor",
                timeout=timeout,
            )
            logger.debug(f"device:heartbeat response: {response}")

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
