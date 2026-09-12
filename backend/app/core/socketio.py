# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Socket.IO server configuration and initialization.

This module provides the Socket.IO server instance with Redis adapter
for multi-worker deployments.
"""

import logging
from urllib.parse import urlsplit

import socketio

from app.core.config import settings
from app.core.terminal_socketio_manager import TerminalDiagnosticAsyncRedisManager

logger = logging.getLogger(__name__)

# Socket.IO server configuration
SOCKETIO_PATH = "/socket.io"
SOCKETIO_CORS_ORIGINS = "*"
SOCKETIO_PING_INTERVAL = 25  # seconds
SOCKETIO_PING_TIMEOUT = 20  # seconds
SOCKETIO_MAX_HTTP_BUFFER_SIZE = 1000000  # 1MB


def create_socketio_server() -> socketio.AsyncServer:
    """
    Create and configure the Socket.IO server instance.

    Uses Redis adapter for cross-worker communication in multi-instance deployments.

    Returns:
        socketio.AsyncServer: Configured Socket.IO server
    """
    # Create Redis manager for cross-worker communication
    redis_url = settings.REDIS_URL

    try:
        mgr = TerminalDiagnosticAsyncRedisManager(redis_url)
        logger.info(
            "Socket.IO Redis manager initialized endpoint=%s",
            _safe_redis_endpoint(redis_url),
        )
    except Exception as e:
        logger.warning(
            "Failed to create Redis manager error_type=%s, falling back to in-memory",
            type(e).__name__,
        )
        mgr = None

    # Create Socket.IO server
    sio = socketio.AsyncServer(
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


def _safe_redis_endpoint(redis_url: str) -> str:
    """Describe a Redis endpoint without credentials or query parameters."""
    try:
        parsed = urlsplit(redis_url)
        database = parsed.path.lstrip("/") or "0"
        if not database.isdigit():
            database = "unknown"
        host = parsed.hostname or "unknown"
        port = parsed.port or (6380 if parsed.scheme == "rediss" else 6379)
        return f"{parsed.scheme or 'redis'}://{host}:{port}/{database}"
    except (TypeError, ValueError):
        return "unparseable"
