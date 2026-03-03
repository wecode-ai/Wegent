# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
VNC WebSocket middleware for cloud devices.

Provides ASGI middleware that intercepts VNC WebSocket connections
and handles them directly, bypassing FastAPI's routing to avoid
middleware issues with WebSocket upgrades.
"""

import logging
import re
from typing import Callable

from fastapi import WebSocket

logger = logging.getLogger(__name__)

# VNC WebSocket path pattern: /api/cloud-devices/{device_id}/vnc-ws
VNC_WS_PATTERN = re.compile(r"^/api/cloud-devices/([^/]+)/vnc-ws$")


async def _handle_vnc_ws(scope, receive, send) -> None:
    """Handle VNC WebSocket proxy at the ASGI level.

    Args:
        scope: ASGI scope dict
        receive: ASGI receive callable
        send: ASGI send callable
    """
    from wecode.api.cloud_devices import vnc_websocket_proxy

    path = scope.get("path", "")
    logger.info(f"[VNC-WS] Handling WebSocket for path={path}")

    match = VNC_WS_PATTERN.match(path)
    if not match:
        logger.warning(f"[VNC-WS] Path does not match VNC pattern: {path}")
        return

    device_id = match.group(1)

    # Extract token from query string
    import urllib.parse

    qs = scope.get("query_string", b"").decode("utf-8", errors="replace")
    params = urllib.parse.parse_qs(qs)
    token = params.get("token", [""])[0]

    # Create a FastAPI WebSocket object from the ASGI scope
    websocket = WebSocket(scope, receive, send)

    # Call the endpoint handler directly
    await vnc_websocket_proxy(websocket, device_id, token)


def create_vnc_interceptor_app(fastapi_app: Callable) -> Callable:
    """Create ASGI app that intercepts VNC WebSocket connections.

    This wrapper inspects incoming WebSocket connections and handles
    VNC WebSocket requests directly, forwarding all other requests
    to the FastAPI application.

    Args:
        fastapi_app: The FastAPI ASGI application

    Returns:
        ASGI application callable
    """

    async def vnc_interceptor_app(scope, receive, send):
        """Intercept VNC WebSocket connections before they reach FastAPI.

        Args:
            scope: ASGI scope dict
            receive: ASGI receive callable
            send: ASGI send callable
        """
        if scope["type"] == "websocket":
            path = scope.get("path", "")
            if VNC_WS_PATTERN.match(path):
                logger.info(f"[VNC Interceptor] Handling VNC WebSocket: {path}")
                await _handle_vnc_ws(scope, receive, send)
                return

        # For all other requests, forward to FastAPI
        await fastapi_app(scope, receive, send)

    return vnc_interceptor_app
