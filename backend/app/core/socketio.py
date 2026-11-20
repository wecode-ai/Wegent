# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Socket.IO server configuration and initialization.

This module provides the Socket.IO server instance with Redis adapter
for multi-worker deployments.
"""

import asyncio
import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress

import socketio
from socketio import packet as socketio_packet

from app.core.config import settings
from app.core.socketio_redis import ObservedRedisManager, _ack_reference

logger = logging.getLogger(__name__)

# Socket.IO server configuration
SOCKETIO_PATH = "/socket.io"
SOCKETIO_CORS_ORIGINS = "*"
SOCKETIO_PING_INTERVAL = 25  # seconds
SOCKETIO_PING_TIMEOUT = 20  # seconds
SOCKETIO_MAX_HTTP_BUFFER_SIZE = 1000000  # 1MB


class ObservedSocketIOServer(socketio.AsyncServer):
    """Trace ACK ingress only in the desktop E2E diagnostic environment."""

    def _trace_ack(
        self,
        stage: str,
        eio_sid: str,
        namespace: str | None,
        callback_id: int | None,
        packet_bytes: int | None,
        packet_type: str | None = None,
        error_type: str | None = None,
    ) -> None:
        sid = self.manager.sid_from_eio_sid(eio_sid, namespace or "/")
        logger.info(
            "Socket.IO E2E ACK stage=%s host_ref=%s eio_ref=%s sid_ref=%s "
            "namespace=%s callback_id=%s packet_bytes=%s packet_type=%s error_type=%s",
            stage,
            _ack_reference(getattr(self.manager, "host_id", None)),
            _ack_reference(eio_sid),
            _ack_reference(sid),
            namespace,
            callback_id,
            packet_bytes,
            packet_type,
            error_type,
        )

    async def _handle_eio_message(self, eio_sid: str, data: str | bytes) -> None:
        if data[:1] in ("3", "6", b"3", b"6"):
            try:
                packet = self.packet_class(encoded_packet=data)
            except Exception as error:
                self._trace_ack(
                    "packet-decode-error",
                    eio_sid,
                    None,
                    None,
                    len(data),
                    None,
                    type(error).__name__,
                )
            else:
                if packet.packet_type in (
                    socketio_packet.ACK,
                    socketio_packet.BINARY_ACK,
                ):
                    self._trace_ack(
                        "packet-in",
                        eio_sid,
                        packet.namespace,
                        packet.id,
                        len(data),
                        socketio_packet.packet_names[packet.packet_type],
                    )
        await super()._handle_eio_message(eio_sid, data)

    async def _handle_ack(
        self, eio_sid: str, namespace: str | None, id: int, data: object
    ) -> None:
        self._trace_ack("decoded", eio_sid, namespace, id, None)
        await super()._handle_ack(eio_sid, namespace, id, data)


def create_socketio_server() -> socketio.AsyncServer:
    """
    Create and configure the Socket.IO server instance.

    Uses Redis adapter for cross-worker communication in multi-instance deployments.

    Returns:
        socketio.AsyncServer: Configured Socket.IO server
    """
    # Create Redis manager for cross-worker communication
    redis_url = settings.REDIS_URL

    ack_diagnostics = os.environ.get("WEWORK_E2E_SOCKET_ACK_DIAGNOSTICS") == "true"
    try:
        # A half-open subscription must time out so redis-py can resubscribe.
        mgr = ObservedRedisManager(
            redis_url,
            ack_diagnostics=ack_diagnostics,
            redis_options={
                "client_name": settings.SOCKETIO_REDIS_CLIENT_NAME,
                "socket_timeout": settings.SOCKETIO_REDIS_SOCKET_TIMEOUT,
                "socket_connect_timeout": settings.SOCKETIO_REDIS_CONNECT_TIMEOUT,
                "socket_keepalive": True,
                "health_check_interval": settings.SOCKETIO_REDIS_HEALTH_CHECK_INTERVAL,
            },
        )
        logger.info("Socket.IO Redis manager initialized with bounded timeouts")
    except Exception as e:
        logger.warning(
            f"Failed to create Redis manager: {e}, falling back to in-memory"
        )
        mgr = None

    # Create Socket.IO server
    server_type = ObservedSocketIOServer if ack_diagnostics else socketio.AsyncServer
    sio = server_type(
        async_mode="asgi",
        cors_allowed_origins=SOCKETIO_CORS_ORIGINS,
        ping_interval=SOCKETIO_PING_INTERVAL,
        ping_timeout=SOCKETIO_PING_TIMEOUT,
        max_http_buffer_size=SOCKETIO_MAX_HTTP_BUFFER_SIZE,
        logger=False,  # Use our own logger
        engineio_logger=False,
        client_manager=mgr,
    )

    return sio


def create_socketio_app(sio: socketio.AsyncServer) -> socketio.ASGIApp:
    """
    Create ASGI app for Socket.IO.

    Args:
        sio: The Socket.IO server instance

    Returns:
        socketio.ASGIApp: ASGI application for mounting
    """
    return socketio.ASGIApp(
        sio,
        socketio_path=SOCKETIO_PATH,
    )


# Global Socket.IO server instance (lazy initialized)
_sio_instance: socketio.AsyncServer | None = None


def get_sio() -> socketio.AsyncServer:
    """
    Get or create the global Socket.IO server instance.

    Returns:
        socketio.AsyncServer: The Socket.IO server instance
    """
    global _sio_instance
    if _sio_instance is None:
        _sio_instance = create_socketio_server()
    return _sio_instance


def initialize_socketio_server() -> socketio.AsyncServer:
    """Start cross-worker callbacks even without a local Socket.IO client."""
    sio = get_sio()
    if not sio.manager_initialized:
        sio.manager_initialized = True
        sio.manager.initialize()
        logger.info("Socket.IO cross-worker callback listener started")
    return sio


def socketio_ack_ready() -> bool:
    """Read the most recent probe state without contacting Redis."""
    manager = get_sio().manager
    return not isinstance(manager, ObservedRedisManager) or manager.ack_ready


@asynccontextmanager
async def socketio_ack_probe_lifespan() -> AsyncIterator[None]:
    """Own one background probe for the existing Socket.IO manager."""
    manager = get_sio().manager
    if not isinstance(manager, ObservedRedisManager):
        yield
        return
    probe = asyncio.create_task(
        manager.run_ack_probe(settings.SOCKETIO_REDIS_ACK_PROBE_INTERVAL_SECONDS),
        name="socketio-ack-probe",
    )
    try:
        yield
    finally:
        probe.cancel()
        with suppress(asyncio.CancelledError):
            await probe
