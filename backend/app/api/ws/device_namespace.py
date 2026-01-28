# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Device namespace for Socket.IO.

This module implements the /device namespace for wecode-cli device connections.
It handles device registration, heartbeat, and message routing between
browser clients and local CLI instances.
"""

import asyncio
import logging
import uuid
from datetime import datetime
from typing import Any, Dict, Optional

import socketio
from sqlalchemy.orm import Session

from app.api.ws.events import (
    ClientEvents,
    DeviceHeartbeatPayload,
    DeviceMessagePayload,
    DeviceRegisterPayload,
    DeviceStatusPayload,
    DeviceStreamChunkPayload,
    DeviceStreamDonePayload,
    DeviceStreamErrorPayload,
    DeviceStreamStartPayload,
    ServerEvents,
)
from app.db.session import SessionLocal
from app.models.device import (
    DEVICE_STATUS_BUSY,
    DEVICE_STATUS_OFFLINE,
    DEVICE_STATUS_ONLINE,
    Device,
)
from app.services.chat.access import get_token_expiry, verify_jwt_token
from shared.telemetry.context import set_request_context, set_user_context

logger = logging.getLogger(__name__)


# Store active device streams: device_id -> {request_id, browser_sid}
_active_device_streams: Dict[str, Dict[str, Any]] = {}


class DeviceNamespace(socketio.AsyncNamespace):
    """
    Socket.IO namespace for device (wecode-cli) connections.

    Handles:
    - Device authentication and registration
    - Heartbeat for keepalive
    - Message routing from browser to device
    - Stream responses from device to browser
    """

    def __init__(self, namespace: str = "/device"):
        """Initialize the device namespace."""
        super().__init__(namespace)
        self._event_handlers: Dict[str, str] = {
            "device:register": "on_device_register",
            "device:heartbeat": "on_device_heartbeat",
            "device:stream_start": "on_device_stream_start",
            "device:stream_chunk": "on_device_stream_chunk",
            "device:stream_done": "on_device_stream_done",
            "device:stream_error": "on_device_stream_error",
        }

    async def trigger_event(self, event: str, sid: str, *args):
        """Override trigger_event to handle colon-separated event names."""
        logger.info(f"[DeviceWS] trigger_event called: event={event} sid={sid}")
        if event in self._event_handlers:
            handler_name = self._event_handlers[event]
            handler = getattr(self, handler_name, None)
            if handler:
                logger.info(
                    f"[DeviceWS] Routing event '{event}' to handler '{handler_name}'"
                )
                return await handler(sid, *args)

        return await super().trigger_event(event, sid, *args)

    async def on_connect(self, sid: str, environ: dict, auth: Optional[dict] = None):
        """
        Handle device connection.

        Verifies JWT token from wecode-cli.

        Args:
            sid: Socket ID
            environ: WSGI environ dict
            auth: Authentication data (expected: {"token": "..."})

        Raises:
            ConnectionRefusedError: If authentication fails
        """
        request_id = str(uuid.uuid4())[:8]
        set_request_context(request_id)

        logger.info(f"[DeviceWS] Connection attempt sid={sid}")

        if not auth or not isinstance(auth, dict):
            logger.warning(f"[DeviceWS] Missing auth data sid={sid}")
            raise ConnectionRefusedError("Missing authentication token")

        token = auth.get("token")
        if not token:
            logger.warning(f"[DeviceWS] Missing token in auth sid={sid}")
            raise ConnectionRefusedError("Missing authentication token")

        user = verify_jwt_token(token)
        if not user:
            logger.warning(f"[DeviceWS] Invalid token sid={sid}")
            raise ConnectionRefusedError("Invalid or expired token")

        token_exp = get_token_expiry(token)

        await self.save_session(
            sid,
            {
                "user_id": user.id,
                "user_name": user.user_name,
                "request_id": request_id,
                "token_exp": token_exp,
                "auth_token": token,
                "device_id": None,  # Will be set on register
            },
        )

        set_user_context(user_id=str(user.id), user_name=user.user_name)

        # Join user room for device status updates
        user_room = f"device:user:{user.id}"
        await self.enter_room(sid, user_room)

        logger.info(f"[DeviceWS] Connected user={user.id} ({user.user_name}) sid={sid}")

    async def on_disconnect(self, sid: str):
        """Handle device disconnection."""
        try:
            session = await self.get_session(sid)
            user_id = session.get("user_id")
            device_id = session.get("device_id")

            if device_id and user_id:
                # Update device status to offline
                with SessionLocal() as db:
                    device = (
                        db.query(Device)
                        .filter(
                            Device.device_id == device_id, Device.user_id == user_id
                        )
                        .first()
                    )
                    if device:
                        device.status = DEVICE_STATUS_OFFLINE
                        device.socket_sid = None
                        db.commit()

                        # Notify browser clients
                        await self._notify_device_status(
                            user_id, device, DEVICE_STATUS_OFFLINE
                        )

                logger.info(
                    f"[DeviceWS] Disconnected device={device_id} user={user_id} sid={sid}"
                )
            else:
                logger.info(f"[DeviceWS] Disconnected sid={sid}")
        except Exception as e:
            logger.error(f"[DeviceWS] Error on disconnect: {e}")

    async def on_device_register(self, sid: str, data: dict) -> dict:
        """
        Handle device:register event.

        Registers or updates a device and marks it as online.

        Args:
            sid: Socket ID
            data: DeviceRegisterPayload fields

        Returns:
            {"success": true, "device_id": str} or {"error": str}
        """
        try:
            payload = DeviceRegisterPayload(**data)
        except Exception as e:
            return {"error": f"Invalid payload: {e}"}

        session = await self.get_session(sid)
        user_id = session.get("user_id")

        if not user_id:
            return {"error": "Not authenticated"}

        logger.info(
            f"[DeviceWS] device:register device_id={payload.device_id} "
            f"user={user_id} name={payload.name}"
        )

        with SessionLocal() as db:
            # Find or create device
            device = (
                db.query(Device).filter(Device.device_id == payload.device_id).first()
            )

            if device:
                # Verify ownership
                if device.user_id != user_id:
                    return {"error": "Device belongs to another user"}
                # Update existing device
                device.name = payload.name
                device.workspace_path = payload.workspace_path
                device.status = DEVICE_STATUS_ONLINE
                device.socket_sid = sid
                device.last_seen_at = datetime.utcnow()
                if payload.metadata:
                    import json

                    device.metadata_json = json.dumps(payload.metadata)
            else:
                # Create new device
                import json

                device = Device(
                    user_id=user_id,
                    device_id=payload.device_id,
                    name=payload.name,
                    device_type=payload.device_type,
                    status=DEVICE_STATUS_ONLINE,
                    workspace_path=payload.workspace_path,
                    socket_sid=sid,
                    last_seen_at=datetime.utcnow(),
                    metadata_json=(
                        json.dumps(payload.metadata) if payload.metadata else None
                    ),
                )
                db.add(device)

            db.commit()
            db.refresh(device)

            # Update session with device_id
            await self.save_session(
                sid,
                {
                    **session,
                    "device_id": payload.device_id,
                },
            )

            # Join device-specific room
            device_room = f"device:{payload.device_id}"
            await self.enter_room(sid, device_room)

            # Notify browser clients about device online
            await self._notify_device_status(user_id, device, DEVICE_STATUS_ONLINE)

        return {"success": True, "device_id": payload.device_id}

    async def on_device_heartbeat(self, sid: str, data: dict) -> dict:
        """Handle device:heartbeat event."""
        try:
            payload = DeviceHeartbeatPayload(**data)
        except Exception as e:
            return {"error": f"Invalid payload: {e}"}

        session = await self.get_session(sid)
        user_id = session.get("user_id")

        if not user_id:
            return {"error": "Not authenticated"}

        with SessionLocal() as db:
            device = (
                db.query(Device)
                .filter(
                    Device.device_id == payload.device_id, Device.user_id == user_id
                )
                .first()
            )

            if device:
                device.last_seen_at = datetime.utcnow()
                if payload.workspace_path:
                    device.workspace_path = payload.workspace_path
                db.commit()

        return {"success": True}

    async def on_device_stream_start(self, sid: str, data: dict) -> dict:
        """Handle device:stream_start event - CLI starting to stream response."""
        logger.info(f"[DeviceWS] stream_start received: data={data}")
        try:
            payload = DeviceStreamStartPayload(**data)
        except Exception as e:
            logger.error(f"[DeviceWS] stream_start invalid payload: {e}")
            return {"error": f"Invalid payload: {e}"}

        session = await self.get_session(sid)
        user_id = session.get("user_id")

        if not user_id:
            logger.warning("[DeviceWS] stream_start: not authenticated")
            return {"error": "Not authenticated"}

        # Get the browser session info from active streams
        stream_info = _active_device_streams.get(payload.device_id)
        logger.info(
            f"[DeviceWS] stream_start device_id={payload.device_id} stream_info={stream_info}"
        )
        if not stream_info or stream_info.get("request_id") != payload.request_id:
            logger.warning(
                f"[DeviceWS] stream_start no matching request: expected={stream_info.get('request_id') if stream_info else None} got={payload.request_id}"
            )
            return {"error": "No matching request found"}

        # Emit to browser (via chat namespace)
        # The browser is listening on the chat namespace
        browser_sid = stream_info.get("browser_sid")
        logger.info(f"[DeviceWS] stream_start emitting to browser_sid={browser_sid}")
        if browser_sid:
            from app.core.socketio import get_sio

            sio = get_sio()
            await sio.emit(
                "device:stream_start",  # Send to browser for device chat UI
                {"device_id": payload.device_id, "request_id": payload.request_id},
                room=browser_sid,
                namespace="/chat",
            )
            logger.info(f"[DeviceWS] stream_start emitted successfully to browser")

        return {"success": True}

    async def on_device_stream_chunk(self, sid: str, data: dict) -> dict:
        """Handle device:stream_chunk event - CLI streaming content chunk."""
        try:
            payload = DeviceStreamChunkPayload(**data)
        except Exception as e:
            logger.error(f"[DeviceWS] stream_chunk invalid payload: {e}")
            return {"error": f"Invalid payload: {e}"}

        # Get browser session info
        stream_info = _active_device_streams.get(payload.device_id)
        logger.info(
            f"[DeviceWS] stream_chunk device_id={payload.device_id} stream_info={stream_info}"
        )
        if not stream_info or stream_info.get("request_id") != payload.request_id:
            logger.warning(
                f"[DeviceWS] stream_chunk no matching request: expected={stream_info.get('request_id') if stream_info else None} got={payload.request_id}"
            )
            return {"error": "No matching request found"}

        # Emit chunk to browser
        browser_sid = stream_info.get("browser_sid")
        logger.info(f"[DeviceWS] stream_chunk emitting to browser_sid={browser_sid}")
        if browser_sid:
            from app.core.socketio import get_sio

            sio = get_sio()
            await sio.emit(
                "device:stream_chunk",  # Custom event for device streaming
                {
                    "device_id": payload.device_id,
                    "request_id": payload.request_id,
                    "content": payload.content,
                    "offset": payload.offset,
                },
                room=browser_sid,
                namespace="/chat",
            )

        return {"success": True}

    async def on_device_stream_done(self, sid: str, data: dict) -> dict:
        """Handle device:stream_done event - CLI finished streaming."""
        try:
            payload = DeviceStreamDonePayload(**data)
        except Exception as e:
            return {"error": f"Invalid payload: {e}"}

        session = await self.get_session(sid)
        user_id = session.get("user_id")

        # Get browser session info
        stream_info = _active_device_streams.get(payload.device_id)
        if stream_info and stream_info.get("request_id") == payload.request_id:
            browser_sid = stream_info.get("browser_sid")
            if browser_sid:
                from app.core.socketio import get_sio

                sio = get_sio()
                await sio.emit(
                    "device:stream_done",
                    {
                        "device_id": payload.device_id,
                        "request_id": payload.request_id,
                        "result": payload.result,
                    },
                    room=browser_sid,
                    namespace="/chat",
                )

            # Clean up stream info
            del _active_device_streams[payload.device_id]

        # Update device status back to online
        if user_id:
            with SessionLocal() as db:
                device = (
                    db.query(Device)
                    .filter(
                        Device.device_id == payload.device_id,
                        Device.user_id == user_id,
                    )
                    .first()
                )
                if device:
                    device.status = DEVICE_STATUS_ONLINE
                    db.commit()

        return {"success": True}

    async def on_device_stream_error(self, sid: str, data: dict) -> dict:
        """Handle device:stream_error event - CLI encountered error."""
        try:
            payload = DeviceStreamErrorPayload(**data)
        except Exception as e:
            return {"error": f"Invalid payload: {e}"}

        session = await self.get_session(sid)
        user_id = session.get("user_id")

        # Get browser session info
        stream_info = _active_device_streams.get(payload.device_id)
        if stream_info and stream_info.get("request_id") == payload.request_id:
            browser_sid = stream_info.get("browser_sid")
            if browser_sid:
                from app.core.socketio import get_sio

                sio = get_sio()
                await sio.emit(
                    "device:stream_error",
                    {
                        "device_id": payload.device_id,
                        "request_id": payload.request_id,
                        "error": payload.error,
                    },
                    room=browser_sid,
                    namespace="/chat",
                )

            # Clean up stream info
            del _active_device_streams[payload.device_id]

        # Update device status back to online
        if user_id:
            with SessionLocal() as db:
                device = (
                    db.query(Device)
                    .filter(
                        Device.device_id == payload.device_id,
                        Device.user_id == user_id,
                    )
                    .first()
                )
                if device:
                    device.status = DEVICE_STATUS_ONLINE
                    db.commit()

        return {"success": True}

    async def _notify_device_status(
        self, user_id: int, device: Device, status: str
    ) -> None:
        """Notify browser clients about device status change."""
        from app.core.socketio import get_sio

        sio = get_sio()

        event = (
            ServerEvents.DEVICE_CONNECTED
            if status == DEVICE_STATUS_ONLINE
            else ServerEvents.DEVICE_DISCONNECTED
        )

        payload = DeviceStatusPayload(
            device_id=device.device_id,
            name=device.name,
            device_type=device.device_type,
            status=status,
            workspace_path=device.workspace_path,
            last_seen_at=(
                device.last_seen_at.isoformat() if device.last_seen_at else None
            ),
        )

        # Emit to user's browser clients via chat namespace
        user_room = f"user:{user_id}"
        await sio.emit(
            event,
            payload.model_dump(),
            room=user_room,
            namespace="/chat",
        )


async def send_message_to_device(
    device_id: str,
    message: str,
    browser_sid: str,
    conversation_id: Optional[str] = None,
) -> Optional[str]:
    """
    Send a message to a device (wecode-cli).

    This function is called from the chat namespace when user sends
    a message targeting a device.

    Args:
        device_id: Target device ID
        message: User message content
        browser_sid: Browser Socket ID for responses
        conversation_id: Optional conversation ID for context

    Returns:
        Request ID if successful, None if device not found or offline
    """
    from app.core.socketio import get_sio

    sio = get_sio()

    with SessionLocal() as db:
        device = db.query(Device).filter(Device.device_id == device_id).first()

        if not device or device.status == DEVICE_STATUS_OFFLINE:
            return None

        if not device.socket_sid:
            return None

        # Generate request ID
        request_id = str(uuid.uuid4())

        # Store stream info for response routing
        _active_device_streams[device_id] = {
            "request_id": request_id,
            "browser_sid": browser_sid,
            "conversation_id": conversation_id,
        }

        # Update device status to busy
        device.status = DEVICE_STATUS_BUSY
        db.commit()

        # Send message to device
        payload = DeviceMessagePayload(
            request_id=request_id,
            message=message,
            conversation_id=conversation_id,
        )

        await sio.emit(
            ServerEvents.DEVICE_MESSAGE,
            payload.model_dump(),
            room=device.socket_sid,
            namespace="/device",
        )

        return request_id


def register_device_namespace(sio: socketio.AsyncServer) -> None:
    """Register the device namespace with Socket.IO server."""
    device_ns = DeviceNamespace("/device")
    sio.register_namespace(device_ns)
    logger.info("[DeviceWS] Device namespace registered at /device")
