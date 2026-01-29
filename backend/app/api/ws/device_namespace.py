# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Device namespace for Socket.IO.

This module implements the /device namespace for local device connections.
It handles device authentication, registration, heartbeat, and task execution.

Events:
- connect: Device authenticates with user JWT token
- device:register: Device registers itself with device_id and name
- device:heartbeat: Device sends heartbeat every 30s
- device:status: Device reports status (idle/busy)
- task:execute: Backend pushes task to device
- task:progress: Device reports execution progress
- task:complete: Device reports task completion
- disconnect: Cleanup on device disconnection
"""

import asyncio
import logging
import uuid
from datetime import datetime
from typing import Any, Dict, Optional

import socketio
from sqlalchemy.orm import Session

from app.api.ws.decorators import trace_websocket_event
from app.db.session import SessionLocal
from app.models.subtask import Subtask, SubtaskStatus
from app.schemas.device import (
    DeviceHeartbeatPayload,
    DeviceOfflineEvent,
    DeviceOnlineEvent,
    DeviceRegisterPayload,
    DeviceStatusEvent,
    DeviceStatusPayload,
)
from app.services.chat.access import get_token_expiry, verify_jwt_token
from app.services.chat.ws_emitter import get_ws_emitter
from app.services.device_service import device_service
from shared.models.db.enums import DeviceStatus
from shared.telemetry.context import set_request_context, set_user_context

logger = logging.getLogger(__name__)


class DeviceNamespace(socketio.AsyncNamespace):
    """
    Socket.IO namespace for local device connections.

    Handles:
    - Authentication on connect (using user JWT token)
    - Device registration and management
    - Heartbeat monitoring
    - Task execution routing
    """

    def __init__(self, namespace: str = "/device"):
        """Initialize the device namespace."""
        super().__init__(namespace)

        # Map colon-separated event names to handler methods
        self._event_handlers: Dict[str, str] = {
            "device:register": "on_device_register",
            "device:heartbeat": "on_device_heartbeat",
            "device:status": "on_device_status",
            "task:progress": "on_task_progress",
            "task:complete": "on_task_complete",
        }

    @trace_websocket_event(
        exclude_events={"connect"},
        extract_event_data=True,
    )
    async def trigger_event(self, event: str, sid: str, *args):
        """
        Override trigger_event to handle colon-separated event names.

        Args:
            event: Event name (e.g., 'device:register')
            sid: Socket ID
            *args: Event arguments

        Returns:
            Result from the event handler
        """
        return await self._execute_handler(event, sid, *args)

    async def _execute_handler(self, event: str, sid: str, *args):
        """Execute the event handler for the given event."""
        if event in self._event_handlers:
            handler_name = self._event_handlers[event]
            handler = getattr(self, handler_name, None)
            if handler:
                logger.debug(
                    f"[Device WS] Routing event '{event}' to handler '{handler_name}'"
                )
                return await handler(sid, *args)

        return await super().trigger_event(event, sid, *args)

    async def on_connect(self, sid: str, environ: dict, auth: Optional[dict] = None):
        """
        Handle device connection.

        Verifies JWT token and prepares for device registration.

        Args:
            sid: Socket ID
            environ: WSGI environ dict
            auth: Authentication data (expected: {"token": "..."})

        Raises:
            ConnectionRefusedError: If authentication fails
        """
        from app.core.shutdown import shutdown_manager

        request_id = str(uuid.uuid4())[:8]
        set_request_context(request_id)

        logger.info(f"[Device WS] Connection attempt sid={sid}")

        # Reject new connections during graceful shutdown
        if shutdown_manager.is_shutting_down:
            logger.warning(
                f"[Device WS] Rejecting connection during shutdown sid={sid}"
            )
            raise ConnectionRefusedError("Server is shutting down")

        # Check auth token
        if not auth or not isinstance(auth, dict):
            logger.warning(f"[Device WS] Missing auth data sid={sid}")
            raise ConnectionRefusedError("Missing authentication token")

        token = auth.get("token")
        if not token:
            logger.warning(f"[Device WS] Missing token in auth sid={sid}")
            raise ConnectionRefusedError("Missing authentication token")

        # Verify token
        user = verify_jwt_token(token)
        if not user:
            logger.warning(f"[Device WS] Invalid token sid={sid}")
            raise ConnectionRefusedError("Invalid or expired token")

        # Extract token expiry
        token_exp = get_token_expiry(token)

        # Save user info to session (device_id will be added on register)
        await self.save_session(
            sid,
            {
                "user_id": user.id,
                "user_name": user.user_name,
                "request_id": request_id,
                "token_exp": token_exp,
                "auth_token": token,
                "device_id": None,  # Set on device:register
                "registered": False,
            },
        )

        set_user_context(user_id=str(user.id), user_name=user.user_name)

        # Join user room for device-related notifications
        user_room = f"user:{user.id}"
        await self.enter_room(sid, user_room)

        logger.info(
            f"[Device WS] Connected user={user.id} ({user.user_name}) sid={sid}, awaiting registration"
        )

    async def on_disconnect(self, sid: str):
        """
        Handle device disconnection.

        Cleans up Redis online status, updates MySQL, and marks running tasks as failed.

        Args:
            sid: Socket ID
        """
        try:
            session = await self.get_session(sid)
            user_id = session.get("user_id")
            device_id = session.get("device_id")
            request_id = session.get("request_id")

            if request_id:
                set_request_context(request_id)
            if user_id:
                set_user_context(user_id=str(user_id))

            logger.info(
                f"[Device WS] Disconnected user={user_id}, device={device_id}, sid={sid}"
            )

            if user_id and device_id:
                # Remove from Redis online status
                await device_service.set_device_offline(user_id, device_id)

                # Update MySQL status and mark running tasks as failed
                db = SessionLocal()
                try:
                    # Mark device as offline in MySQL
                    device_service.mark_device_offline(db, user_id, device_id)

                    # Mark running tasks on this device as failed
                    executor_name = f"device-{device_id}"
                    running_subtasks = (
                        db.query(Subtask)
                        .filter(
                            Subtask.executor_name == executor_name,
                            Subtask.status == SubtaskStatus.RUNNING,
                        )
                        .all()
                    )

                    for subtask in running_subtasks:
                        subtask.status = SubtaskStatus.FAILED
                        subtask.error_message = "Device disconnected unexpectedly"
                        subtask.completed_at = datetime.now()

                        # Emit error to task room via chat namespace
                        ws_emitter = get_ws_emitter()
                        if ws_emitter:
                            await ws_emitter.emit_chat_error(
                                task_id=subtask.task_id,
                                subtask_id=subtask.id,
                                error="Device disconnected",
                                message_id=subtask.message_id,
                            )
                        logger.warning(
                            f"[Device WS] Marked subtask {subtask.id} as FAILED due to device disconnect"
                        )

                    db.commit()

                    # Broadcast device offline event to user room
                    await self._broadcast_device_offline(user_id, device_id)

                finally:
                    db.close()

        except Exception as e:
            logger.error(f"[Device WS] Error in disconnect handler: {e}")

    # ============================================================
    # Device Registration and Heartbeat Events
    # ============================================================

    async def on_device_register(self, sid: str, data: dict) -> dict:
        """
        Handle device:register event.

        Registers the device in MySQL and sets online status in Redis.

        Args:
            sid: Socket ID
            data: {"device_id": str, "name": str}

        Returns:
            {"success": True, "device_id": str} or {"error": str}
        """
        try:
            payload = DeviceRegisterPayload(**data)
        except Exception as e:
            logger.warning(f"[Device WS] Invalid register payload: {e}")
            return {"error": f"Invalid payload: {e}"}

        session = await self.get_session(sid)
        user_id = session.get("user_id")

        if not user_id:
            return {"error": "Not authenticated"}

        logger.info(
            f"[Device WS] device:register user={user_id}, device={payload.device_id}, name={payload.name}"
        )

        db = SessionLocal()
        try:
            # Register or update device in MySQL
            device = device_service.register_or_update_device(
                db=db,
                user_id=user_id,
                device_id=payload.device_id,
                name=payload.name,
                status=DeviceStatus.ONLINE,
            )

            # Set online status in Redis
            await device_service.set_device_online(
                user_id=user_id,
                device_id=payload.device_id,
                socket_id=sid,
                name=payload.name,
            )

            # Update session with device_id
            session["device_id"] = payload.device_id
            session["registered"] = True
            await self.save_session(sid, session)

            # Join device-specific room
            device_room = f"device:{user_id}:{payload.device_id}"
            await self.enter_room(sid, device_room)

            # Broadcast device online event to user room (via chat namespace)
            await self._broadcast_device_online(
                user_id, payload.device_id, payload.name
            )

            logger.info(
                f"[Device WS] Device registered: user={user_id}, device={payload.device_id}"
            )

            return {"success": True, "device_id": payload.device_id}

        except Exception as e:
            logger.error(f"[Device WS] Error registering device: {e}")
            return {"error": f"Registration failed: {e}"}
        finally:
            db.close()

    async def on_device_heartbeat(self, sid: str, data: dict) -> dict:
        """
        Handle device:heartbeat event.

        Refreshes the device's online status in Redis and updates MySQL.

        Args:
            sid: Socket ID
            data: {"device_id": str}

        Returns:
            {"success": True} or {"error": str}
        """
        try:
            payload = DeviceHeartbeatPayload(**data)
        except Exception as e:
            return {"error": f"Invalid payload: {e}"}

        session = await self.get_session(sid)
        user_id = session.get("user_id")
        session_device_id = session.get("device_id")

        if not user_id:
            return {"error": "Not authenticated"}

        if session_device_id != payload.device_id:
            return {"error": "Device ID mismatch"}

        # Refresh Redis TTL
        await device_service.refresh_device_heartbeat(user_id, payload.device_id)

        # Update MySQL heartbeat timestamp
        db = SessionLocal()
        try:
            device_service.update_device_heartbeat(db, user_id, payload.device_id)
        finally:
            db.close()

        logger.debug(
            f"[Device WS] Heartbeat received: user={user_id}, device={payload.device_id}"
        )

        return {"success": True}

    async def on_device_status(self, sid: str, data: dict) -> dict:
        """
        Handle device:status event.

        Updates the device status (online/busy).

        Args:
            sid: Socket ID
            data: {"device_id": str, "status": str}

        Returns:
            {"success": True} or {"error": str}
        """
        try:
            payload = DeviceStatusPayload(**data)
        except Exception as e:
            return {"error": f"Invalid payload: {e}"}

        session = await self.get_session(sid)
        user_id = session.get("user_id")
        session_device_id = session.get("device_id")

        if not user_id:
            return {"error": "Not authenticated"}

        if session_device_id != payload.device_id:
            return {"error": "Device ID mismatch"}

        # Update MySQL status
        db = SessionLocal()
        try:
            device_service.update_device_status(
                db, user_id, payload.device_id, payload.status
            )
        finally:
            db.close()

        # Broadcast status change to user room
        await self._broadcast_device_status(user_id, payload.device_id, payload.status)

        logger.info(
            f"[Device WS] Status updated: user={user_id}, device={payload.device_id}, status={payload.status}"
        )

        return {"success": True}

    # ============================================================
    # Task Execution Events
    # ============================================================

    async def on_task_progress(self, sid: str, data: dict) -> dict:
        """
        Handle task:progress event from device.

        Updates subtask progress and emits chat:chunk event.

        Args:
            sid: Socket ID
            data: {"subtask_id": int, "status": str, "progress": int, "result": dict}

        Returns:
            {"success": True} or {"error": str}
        """
        session = await self.get_session(sid)
        user_id = session.get("user_id")
        device_id = session.get("device_id")

        if not user_id or not device_id:
            return {"error": "Not authenticated or not registered"}

        subtask_id = data.get("subtask_id")
        if not subtask_id:
            return {"error": "Missing subtask_id"}

        db = SessionLocal()
        try:
            # Verify subtask belongs to this device
            subtask = db.query(Subtask).filter(Subtask.id == subtask_id).first()
            if not subtask:
                return {"error": "Subtask not found"}

            expected_executor = f"device-{device_id}"
            if subtask.executor_name != expected_executor:
                return {"error": "Subtask does not belong to this device"}

            # Update subtask
            if "status" in data:
                status_str = data["status"]
                try:
                    subtask.status = SubtaskStatus(status_str)
                except ValueError:
                    pass  # Invalid status, ignore

            if "progress" in data:
                subtask.progress = data["progress"]

            if "result" in data:
                subtask.result = data["result"]

            db.commit()

            # Emit chat:chunk to task room
            ws_emitter = get_ws_emitter()
            if ws_emitter and "result" in data:
                result = data["result"]
                content = result.get("value", "")
                await ws_emitter.emit_chat_chunk(
                    task_id=subtask.task_id,
                    subtask_id=subtask_id,
                    content=content,
                    message_id=subtask.message_id,
                    thinking=result.get("thinking"),
                    workbench=result.get("workbench"),
                )

            logger.debug(
                f"[Device WS] Progress received: subtask={subtask_id}, progress={data.get('progress', 0)}"
            )

            return {"success": True}

        except Exception as e:
            logger.error(f"[Device WS] Error processing progress: {e}")
            return {"error": str(e)}
        finally:
            db.close()

    async def on_task_complete(self, sid: str, data: dict) -> dict:
        """
        Handle task:complete event from device.

        Marks subtask as completed/failed and emits chat:done event.

        Args:
            sid: Socket ID
            data: {"subtask_id": int, "status": str, "progress": int, "result": dict, "error_message": str?}

        Returns:
            {"success": True} or {"error": str}
        """
        session = await self.get_session(sid)
        user_id = session.get("user_id")
        device_id = session.get("device_id")

        if not user_id or not device_id:
            return {"error": "Not authenticated or not registered"}

        subtask_id = data.get("subtask_id")
        if not subtask_id:
            return {"error": "Missing subtask_id"}

        db = SessionLocal()
        try:
            # Verify subtask belongs to this device
            subtask = db.query(Subtask).filter(Subtask.id == subtask_id).first()
            if not subtask:
                return {"error": "Subtask not found"}

            expected_executor = f"device-{device_id}"
            if subtask.executor_name != expected_executor:
                return {"error": "Subtask does not belong to this device"}

            # Update subtask status
            status_str = data.get("status", "COMPLETED")
            try:
                subtask.status = SubtaskStatus(status_str)
            except ValueError:
                subtask.status = SubtaskStatus.COMPLETED

            subtask.progress = data.get("progress", 100)
            subtask.completed_at = datetime.now()

            if "result" in data:
                subtask.result = data["result"]

            if "error_message" in data:
                subtask.error_message = data["error_message"]

            db.commit()

            # Emit chat:done or chat:error to task room
            ws_emitter = get_ws_emitter()
            if ws_emitter:
                if subtask.status == SubtaskStatus.FAILED:
                    await ws_emitter.emit_chat_error(
                        task_id=subtask.task_id,
                        subtask_id=subtask_id,
                        error=data.get("error_message", "Task failed"),
                        message_id=subtask.message_id,
                    )
                else:
                    result = data.get("result", {})
                    await ws_emitter.emit_chat_done(
                        task_id=subtask.task_id,
                        subtask_id=subtask_id,
                        content=result.get("value", ""),
                        message_id=subtask.message_id,
                        thinking=result.get("thinking"),
                        workbench=result.get("workbench"),
                    )

            # Update device status back to online (not busy)
            device_service.update_device_status(
                db, user_id, device_id, DeviceStatus.ONLINE
            )
            await self._broadcast_device_status(user_id, device_id, DeviceStatus.ONLINE)

            logger.info(
                f"[Device WS] Task complete: subtask={subtask_id}, status={subtask.status}"
            )

            return {"success": True}

        except Exception as e:
            logger.error(f"[Device WS] Error processing completion: {e}")
            return {"error": str(e)}
        finally:
            db.close()

    # ============================================================
    # Broadcast Helpers
    # ============================================================

    async def _broadcast_device_online(
        self, user_id: int, device_id: str, name: str
    ) -> None:
        """Broadcast device:online event to user room via chat namespace."""
        from app.core.socketio import get_sio

        sio = get_sio()
        event_data = DeviceOnlineEvent(
            device_id=device_id, name=name, status=DeviceStatus.ONLINE
        ).model_dump()

        await sio.emit(
            "device:online",
            event_data,
            room=f"user:{user_id}",
            namespace="/chat",
        )
        logger.debug(f"[Device WS] Broadcast device:online to user:{user_id}")

    async def _broadcast_device_offline(self, user_id: int, device_id: str) -> None:
        """Broadcast device:offline event to user room via chat namespace."""
        from app.core.socketio import get_sio

        sio = get_sio()
        event_data = DeviceOfflineEvent(device_id=device_id).model_dump()

        await sio.emit(
            "device:offline",
            event_data,
            room=f"user:{user_id}",
            namespace="/chat",
        )
        logger.debug(f"[Device WS] Broadcast device:offline to user:{user_id}")

    async def _broadcast_device_status(
        self, user_id: int, device_id: str, status: DeviceStatus
    ) -> None:
        """Broadcast device:status event to user room via chat namespace."""
        from app.core.socketio import get_sio

        sio = get_sio()
        event_data = DeviceStatusEvent(device_id=device_id, status=status).model_dump()

        await sio.emit(
            "device:status",
            event_data,
            room=f"user:{user_id}",
            namespace="/chat",
        )
        logger.debug(
            f"[Device WS] Broadcast device:status to user:{user_id}, status={status}"
        )


# Factory function to create the namespace
def create_device_namespace() -> DeviceNamespace:
    """Create and return a DeviceNamespace instance."""
    return DeviceNamespace()


def register_device_namespace(sio: socketio.AsyncServer) -> None:
    """
    Register the device namespace with the Socket.IO server.

    Args:
        sio: Socket.IO server instance
    """
    device_ns = DeviceNamespace("/device")
    sio.register_namespace(device_ns)
    logger.info("Device namespace registered at /device")
