# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Socket.IO server configuration and initialization.

This module provides the Socket.IO server instance with Redis adapter
for multi-worker deployments.
"""

import logging
from typing import Any

import socketio

from app.core.config import settings

logger = logging.getLogger(__name__)

# Socket.IO server configuration
SOCKETIO_PATH = "/socket.io"
SOCKETIO_CORS_ORIGINS = "*"
SOCKETIO_PING_INTERVAL = 25  # seconds
SOCKETIO_PING_TIMEOUT = 20  # seconds
SOCKETIO_MAX_HTTP_BUFFER_SIZE = 1000000  # 1MB


class TracingAsyncRedisManager(socketio.AsyncRedisManager):
    """Trace async card events before Socket.IO forwards them."""

    async def _handle_emit(self, message: dict[str, Any]) -> None:
        event = message.get("event")
        if event in {"chat:block_created", "chat:block_updated", "chat:done"}:
            namespace = message.get("namespace") or "/"
            room = message.get("room")
            data = message.get("data")
            payload = data[0] if isinstance(data, list) and data else {}
            if not isinstance(payload, dict):
                payload = {}
            block = payload.get("block")
            if not isinstance(block, dict):
                result = payload.get("result")
                blocks = result.get("blocks") if isinstance(result, dict) else None
                block = blocks[0] if isinstance(blocks, list) and blocks else {}
            participant_count = (
                sum(1 for _ in self.get_participants(namespace, room)) if room else 0
            )
            source = "local" if message.get("host_id") == self.host_id else "redis"
            logger.info(
                "[socketio_emit] Forwarding source=%s event=%s room=%s "
                "participants=%s task_id=%s subtask_id=%s block_id=%s "
                "status=%s card_status=%s",
                source,
                event,
                room,
                participant_count,
                payload.get("task_id"),
                payload.get("subtask_id"),
                payload.get("block_id") or block.get("id"),
                payload.get("status") or block.get("status"),
                payload.get("card_status") or block.get("card_status"),
            )

        await super()._handle_emit(message)


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
        mgr = TracingAsyncRedisManager(redis_url)
        logger.info(f"Socket.IO Redis manager initialized with {redis_url}")
    except Exception as e:
        logger.warning(
            f"Failed to create Redis manager: {e}, falling back to in-memory"
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
