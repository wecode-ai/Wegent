# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""ASGI interceptor and byte-transparent proxy for VNC sessions."""

import asyncio
import logging
import re
from contextlib import suppress
from typing import Any, Callable
from urllib.parse import parse_qs, urlsplit

import websockets
from fastapi import WebSocket
from starlette.websockets import WebSocketDisconnect
from websockets.exceptions import ConnectionClosed, InvalidStatus

from app.core.config import settings
from app.db.session import SessionLocal
from wecode.config.vnc import vnc_settings
from wecode.service.vnc_session_service import (
    VncSessionRecord,
    VncUpstream,
    vnc_session_service,
    vnc_session_store,
)

logger = logging.getLogger(__name__)

VNC_WS_PATTERN = re.compile(r"^/vnc-proxy/sessions/([A-Za-z0-9_-]+)$")
MAX_CLIENT_FRAME_BYTES = 1024 * 1024
MAX_UPSTREAM_FRAME_BYTES = 64 * 1024 * 1024
AUTHORIZATION_RECHECK_SECONDS = 5.0


class UnsupportedVncFrame(RuntimeError):
    """Raised when either peer sends a non-binary VNC frame."""


def _connect_vnc_upstream(upstream: VncUpstream) -> Any:
    """Open an uncompressed Backend-to-device WebSocket."""
    return websockets.connect(
        upstream.url,
        additional_headers=upstream.headers,
        compression=None,
        proxy=None,
        max_size=MAX_UPSTREAM_FRAME_BYTES,
        ping_interval=20,
        ping_timeout=20,
        close_timeout=5,
    )


async def _authorize_upstream(record: VncSessionRecord) -> VncUpstream | None:
    """Recheck user, device, and provider state at connection time."""
    with SessionLocal() as db:
        return await vnc_session_service.authorize_connection(db=db, record=record)


def _origin_allowed(origin: str) -> bool:
    """Require a browser origin and enforce the configured production allowlist."""
    normalized = origin.strip().rstrip("/")
    if not normalized:
        return False
    try:
        parsed = urlsplit(normalized)
        port = parsed.port
    except ValueError:
        return False
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path
        or parsed.query
        or parsed.fragment
    ):
        return False
    configured = {
        value.strip().rstrip("/")
        for value in vnc_settings.VNC_ALLOWED_ORIGINS
        if value.strip()
    }
    public_url = urlsplit(settings.WEGENT_BACKEND_PUBLIC_URL)
    public_origin = ""
    if public_url.scheme and public_url.netloc:
        public_origin = f"{public_url.scheme}://{public_url.netloc}"
    if normalized == public_origin or normalized in configured:
        return True

    loopback_pattern = f"{parsed.scheme}://{parsed.hostname}:*"
    if parsed.hostname in {"127.0.0.1", "localhost"} and port is not None:
        if loopback_pattern in configured:
            return True
        return settings.ENVIRONMENT.lower() != "production"
    return False


async def vnc_websocket_proxy(
    websocket: WebSocket,
    session_id: str,
    ticket: str,
    origin: str,
) -> None:
    """Consume a one-time ticket and proxy binary RFB frames in both directions."""
    await websocket.accept()
    if not _origin_allowed(origin):
        await websocket.close(code=4003, reason="VNC origin is not allowed")
        return
    if not ticket:
        await websocket.close(code=4001, reason="VNC connect ticket is missing")
        return
    try:
        record = await vnc_session_store.consume_ticket(session_id, ticket)
    except Exception:
        logger.exception("VNC ticket authorization is unavailable")
        await websocket.close(code=1011, reason="VNC authorization is unavailable")
        return
    if record is None:
        await websocket.close(code=4001, reason="VNC connect ticket is invalid or used")
        return

    try:
        upstream_connection = await _authorize_upstream(record)
    except Exception:
        logger.exception("VNC connection authorization is unavailable")
        await websocket.close(code=1011, reason="VNC authorization is unavailable")
        return
    if upstream_connection is None:
        await websocket.close(code=4003, reason="VNC session access was revoked")
        return

    close_code = 1000
    close_reason = ""
    try:
        async with _connect_vnc_upstream(upstream_connection) as upstream:
            logger.info(
                "VNC proxy connected: session_id=%s provider=%s device_id=%s",
                record.session_id,
                record.provider,
                record.device_id,
            )

            async def client_to_upstream() -> None:
                while True:
                    message = await websocket.receive()
                    if message["type"] == "websocket.disconnect":
                        return
                    data = message.get("bytes")
                    if not isinstance(data, bytes):
                        raise UnsupportedVncFrame("Client sent a non-binary frame")
                    if len(data) > MAX_CLIENT_FRAME_BYTES:
                        raise UnsupportedVncFrame("Client VNC frame is too large")
                    await upstream.send(data)

            async def upstream_to_client() -> None:
                async for message in upstream:
                    if not isinstance(message, bytes):
                        raise UnsupportedVncFrame("Upstream sent a non-binary frame")
                    await websocket.send_bytes(message)

            async def monitor_revocation() -> None:
                while True:
                    await asyncio.sleep(AUTHORIZATION_RECHECK_SECONDS)
                    current = await vnc_session_store.get(session_id)
                    if current is None or await _authorize_upstream(current) is None:
                        return

            client_task = asyncio.create_task(client_to_upstream())
            upstream_task = asyncio.create_task(upstream_to_client())
            revocation_task = asyncio.create_task(monitor_revocation())
            tasks = {client_task, upstream_task, revocation_task}
            done, pending = await asyncio.wait(
                tasks,
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
            for task in done:
                task.result()
            if revocation_task in done:
                close_code = 4003
                close_reason = "VNC session was revoked or expired"
    except UnsupportedVncFrame as exc:
        close_code = 1003
        close_reason = str(exc)
    except (WebSocketDisconnect, ConnectionClosed):
        pass
    except InvalidStatus as exc:
        close_code = 1011
        close_reason = "VNC upstream rejected the connection"
        logger.warning(
            "VNC upstream rejected connection: session_id=%s status=%s",
            session_id,
            exc.response.status_code,
        )
    except Exception:
        close_code = 1011
        close_reason = "VNC upstream connection failed"
        logger.exception("VNC proxy failed: session_id=%s", session_id)
    finally:
        with suppress(Exception):
            await websocket.close(code=close_code, reason=close_reason)
        logger.info("VNC proxy closed: session_id=%s code=%s", session_id, close_code)


async def _handle_vnc_ws(scope, receive, send) -> None:
    """Adapt an intercepted ASGI WebSocket to the VNC proxy."""
    match = VNC_WS_PATTERN.match(scope.get("path", ""))
    if not match:
        return
    params = parse_qs(
        scope.get("query_string", b"").decode("utf-8", errors="replace"),
        keep_blank_values=True,
    )
    ticket_values = params.get("ticket", [])
    ticket = (
        ticket_values[0]
        if set(params) == {"ticket"} and len(ticket_values) == 1
        else ""
    )
    headers = {
        key.decode("latin-1").lower(): value.decode("latin-1")
        for key, value in scope.get("headers", [])
    }
    websocket = WebSocket(scope, receive, send)
    await vnc_websocket_proxy(
        websocket,
        match.group(1),
        ticket,
        headers.get("origin", ""),
    )


def create_vnc_interceptor_app(fastapi_app: Callable) -> Callable:
    """Intercept the exact VNC session WebSocket path before FastAPI routing."""

    async def vnc_interceptor_app(scope, receive, send):
        if scope["type"] == "websocket" and VNC_WS_PATTERN.match(scope.get("path", "")):
            await _handle_vnc_ws(scope, receive, send)
            return
        await fastapi_app(scope, receive, send)

    return vnc_interceptor_app
