# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Device namespace for Socket.IO.

This module implements the /local-executor namespace for local device connections.
It handles device authentication, registration, heartbeat, and task execution.

Authentication:
- Supports both JWT Token and API Key authentication
- API Key: Token starting with 'wg-' prefix (personal keys only)
- JWT Token: Standard JWT token with user info

Events:
- connect: Device authenticates with user JWT token or API Key
- device:register: Device registers itself with device_id and name
- device:heartbeat: Device sends heartbeat every 30s
- device:status: Device reports status (idle/busy)
- task:execute: Backend pushes task to device
- response.*: OpenAI Responses API streaming events from executor
- disconnect: Cleanup on device disconnection
"""

import asyncio
import logging
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict, Generator, Optional

import socketio
from sqlalchemy.orm import Session

from app.api.ws.decorators import trace_websocket_event
from app.core.auth_utils import is_api_key, verify_api_key
from app.core.events import TaskCompletedEvent, get_event_bus
from app.db.session import SessionLocal
from app.models.subtask import Subtask, SubtaskStatus
from app.models.task import TaskResource
from app.schemas.device import (
    DeviceHeartbeatPayload,
    DeviceOfflineEvent,
    DeviceOnlineEvent,
    DeviceRegisterPayload,
    DeviceSlotUpdateEvent,
    DeviceStatusEvent,
    DeviceStatusPayload,
)
from app.services.chat.access import get_token_expiry, verify_jwt_token
from app.services.chat.webpage_ws_chat_emitter import get_extended_emitter
from app.services.device_service import device_service
from app.services.execution.dispatcher import ResponsesAPIEventParser
from app.services.execution.emitters.status_updating import StatusUpdatingEmitter
from app.services.execution.emitters.websocket import WebSocketResultEmitter
from shared.models import EventType
from shared.telemetry.context import set_request_context, set_user_context

logger = logging.getLogger(__name__)


@contextmanager
def _db_session() -> Generator[Session, None, None]:
    """Context manager for database session with auto-commit and auto-close."""
    db = SessionLocal()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


@dataclass
class FailedSubtaskInfo:
    """Information about a failed subtask for WebSocket emission."""

    task_id: int
    subtask_id: int
    message_id: Optional[int]
    user_id: int


def _handle_device_disconnect(user_id: int, device_id: str) -> list[FailedSubtaskInfo]:
    """
    Handle device disconnection in database.

    With CRD model, device record stays in kinds table (just becomes offline via Redis TTL).
    Fails running subtasks and updates parent task status.
    Returns list of failed subtasks for WebSocket emission.
    """
    failed_subtasks = []
    try:
        with _db_session() as db:
            # Note: Device CRD remains in kinds table, it's just offline (Redis TTL expired)
            # No need to call mark_device_offline on MySQL

            # Find and fail running subtasks
            executor_name = f"device-{device_id}"
            running_subtasks = (
                db.query(Subtask)
                .filter(
                    Subtask.executor_name == executor_name,
                    Subtask.status == SubtaskStatus.RUNNING,
                )
                .all()
            )

            # Track unique task IDs to update parent task status
            task_ids_to_fail = set()

            for subtask in running_subtasks:
                subtask.status = SubtaskStatus.FAILED
                subtask.error_message = "Device disconnected unexpectedly"
                subtask.completed_at = datetime.now()
                task_ids_to_fail.add(subtask.task_id)
                failed_subtasks.append(
                    FailedSubtaskInfo(
                        task_id=subtask.task_id,
                        subtask_id=subtask.id,
                        message_id=subtask.message_id,
                        user_id=user_id,
                    )
                )
                logger.warning(
                    f"[Device WS] Marked subtask {subtask.id} as FAILED due to device disconnect"
                )

            # Update parent task status to FAILED
            if task_ids_to_fail:
                from app.schemas.task import TaskUpdate
                from app.services.adapters.task_kinds import task_kinds_service

                for task_id in task_ids_to_fail:
                    try:
                        task_kinds_service.update_task(
                            db=db,
                            task_id=task_id,
                            obj_in=TaskUpdate(status="FAILED"),
                            user_id=user_id,
                        )
                        logger.warning(
                            f"[Device WS] Marked task {task_id} as FAILED due to device disconnect"
                        )
                    except Exception as e:
                        logger.error(
                            f"[Device WS] Failed to update task {task_id} status: {e}"
                        )

    except Exception as e:
        logger.error(f"[Device WS] Error handling device disconnect: {e}")

    return failed_subtasks


def _register_device(
    user_id: int, device_id: str, name: str, client_ip: Optional[str] = None
) -> tuple[bool, Optional[str]]:
    """
    Register or update device CRD in database.

    Args:
        user_id: Device owner user ID
        device_id: Device unique identifier (stored in Kind.name)
        name: Device display name
        client_ip: Device's client IP address

    Returns (success, error_message).
    """
    try:
        with _db_session() as db:
            device_service.upsert_device_crd(
                db=db,
                user_id=user_id,
                device_id=device_id,
                name=name,
                client_ip=client_ip,
            )
        return True, None
    except Exception as e:
        logger.error(f"[Device WS] Error registering device: {e}")
        return False, str(e)


def _update_device_heartbeat(user_id: int, device_id: str) -> None:
    """
    Update device heartbeat timestamp.

    With CRD model, heartbeat is primarily tracked in Redis.
    No MySQL update needed.
    """
    # Heartbeat is managed via Redis in the async handler
    pass


def _update_device_status(user_id: int, device_id: str, status: str) -> None:
    """
    Update device status.

    With CRD model, status is primarily tracked in Redis.
    No MySQL update needed.
    """
    # Status is managed via Redis in the async handler
    pass


class DeviceNamespace(socketio.AsyncNamespace):
    """
    Socket.IO namespace for local executor connections.

    Handles:
    - Authentication on connect (using user JWT token)
    - Device registration and management
    - Heartbeat monitoring
    - Task execution routing
    """

    def __init__(self, namespace: str = "/local-executor"):
        """Initialize the device namespace."""
        super().__init__(namespace)

        # Map colon-separated event names to handler methods
        self._event_handlers: Dict[str, str] = {
            "device:register": "on_device_register",
            "device:heartbeat": "on_device_heartbeat",
            "device:status": "on_device_status",
        }

        # Shared event parser for OpenAI Responses API events
        self._event_parser = ResponsesAPIEventParser()

        # Known OpenAI Responses API event prefixes
        self._responses_api_prefixes = ("response.", "error")

        # Per-subtask locks to ensure events are processed in order
        # This prevents race conditions when multiple response.output_text.delta
        # events arrive concurrently for the same subtask
        self._subtask_locks: Dict[int, asyncio.Lock] = {}

    def _get_subtask_lock(self, subtask_id: int) -> asyncio.Lock:
        """Get or create a lock for the given subtask.

        Args:
            subtask_id: Subtask ID

        Returns:
            asyncio.Lock for the subtask
        """
        if subtask_id not in self._subtask_locks:
            self._subtask_locks[subtask_id] = asyncio.Lock()
        return self._subtask_locks[subtask_id]

    def _cleanup_subtask_lock(self, subtask_id: int) -> None:
        """Clean up the lock for a completed subtask.

        Args:
            subtask_id: Subtask ID
        """
        self._subtask_locks.pop(subtask_id, None)

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

        # Handle OpenAI Responses API events (e.g., response.output_text.delta)
        if event.startswith(self._responses_api_prefixes):
            return await self._handle_responses_api_event(sid, event, *args)

        return await super().trigger_event(event, sid, *args)

    async def on_connect(self, sid: str, environ: dict, auth: Optional[dict] = None):
        """
        Handle device connection.

        Verifies JWT token or API Key and prepares for device registration.

        Authentication:
        - If token starts with 'wg-', treated as API Key (personal keys only)
        - Otherwise, treated as JWT Token

        Args:
            sid: Socket ID
            environ: WSGI environ dict
            auth: Authentication data (expected: {"token": "..."})
                  Token can be either JWT Token or API Key (starting with 'wg-')

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

        # Determine auth type and verify token
        user = None
        auth_type = ""
        token_exp = None

        if is_api_key(token):
            # API Key authentication
            auth_type = "api_key"
            with _db_session() as db:
                user = verify_api_key(db, token)
                if user:
                    # Detach user from session to avoid DetachedInstanceError
                    user_id = user.id
                    user_name = user.user_name
            if not user:
                key_preview = token[:10] + "..." if len(token) > 10 else token
                logger.warning(
                    f"[Device WS] Invalid API key sid={sid}, key={key_preview}"
                )
                raise ConnectionRefusedError("Invalid or expired API key")
            # API Key has no expiry (token_exp stays None)
            token_exp = None
        else:
            # JWT Token authentication
            auth_type = "jwt"
            user = verify_jwt_token(token)
            if not user:
                logger.warning(f"[Device WS] Invalid JWT token sid={sid}")
                raise ConnectionRefusedError("Invalid or expired token")
            user_id = user.id
            user_name = user.user_name
            # Extract token expiry for JWT
            token_exp = get_token_expiry(token)

        # Save user info to session (device_id will be added on register)
        await self.save_session(
            sid,
            {
                "user_id": user_id,
                "user_name": user_name,
                "request_id": request_id,
                "token_exp": token_exp,
                "auth_token": token,
                "auth_type": auth_type,
                "device_id": None,  # Set on device:register
                "registered": False,
            },
        )

        set_user_context(user_id=str(user_id), user_name=user_name)

        # Join user room for device-related notifications
        user_room = f"user:{user_id}"
        await self.enter_room(sid, user_room)

        logger.info(
            f"[Device WS] Connected user={user_id} ({user_name}) via {auth_type} "
            f"sid={sid}, awaiting registration"
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

                # Database operation: quick in, quick out
                # Returns list of failed subtasks for WebSocket emission
                failed_subtasks = _handle_device_disconnect(user_id, device_id)

                # WebSocket emissions happen AFTER database connection is released
                extended_emitter = get_extended_emitter()
                # Track unique task IDs to emit task:status only once per task
                emitted_task_ids = set()
                for info in failed_subtasks:
                    await extended_emitter.emit_chat_error(
                        task_id=info.task_id,
                        subtask_id=info.subtask_id,
                        error="Device disconnected",
                        message_id=info.message_id,
                    )

                # Broadcast device offline event
                await self._broadcast_device_offline(user_id, device_id)

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
            f"[Device WS] device:register user={user_id}, device_id={payload.device_id}, "
            f"name={payload.name}, executor_version={payload.executor_version}, client_ip={payload.client_ip}"
        )

        # Database operation: quick in, quick out
        success, error = _register_device(user_id, payload.device_id, payload.name, payload.client_ip)
        if not success:
            return {"error": f"Registration failed: {error}"}

        # Redis and session operations happen AFTER database connection is released
        await device_service.set_device_online(
            user_id=user_id,
            device_id=payload.device_id,
            socket_id=sid,
            name=payload.name,
            executor_version=payload.executor_version,
        )

        # Update session with device_id
        session["device_id"] = payload.device_id
        session["registered"] = True
        await self.save_session(sid, session)

        # Join device-specific room
        device_room = f"device:{user_id}:{payload.device_id}"
        await self.enter_room(sid, device_room)

        # Broadcast device online event to user room (via chat namespace)
        await self._broadcast_device_online(user_id, payload.device_id, payload.name)

        logger.info(
            f"[Device WS] Device registered: user={user_id}, device={payload.device_id}"
        )

        return {"success": True, "device_id": payload.device_id}

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

        # Refresh Redis TTL and update running_task_ids
        await device_service.refresh_device_heartbeat(
            user_id,
            payload.device_id,
            payload.running_task_ids,
            payload.executor_version,
        )

        # Database operation: quick in, quick out
        _update_device_heartbeat(user_id, payload.device_id)

        # Broadcast slot update to user
        await self._broadcast_device_slot_update(user_id, payload.device_id)

        logger.debug(
            f"[Device WS] Heartbeat received: user={user_id}, device={payload.device_id}, "
            f"running_tasks={len(payload.running_task_ids)}"
        )

        return {"success": True}

    async def on_device_status(self, sid: str, data: dict) -> dict:
        """
        Handle device:status event.

        Updates the device status (online/busy) in Redis.

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

        # Update status in Redis
        await device_service.update_device_status_in_redis(
            user_id, payload.device_id, payload.status.value
        )

        # Broadcast status change to user room
        await self._broadcast_device_status(
            user_id, payload.device_id, payload.status.value
        )

        logger.info(
            f"[Device WS] Status updated: user={user_id}, device={payload.device_id}, status={payload.status}"
        )

        return {"success": True}

    # ============================================================
    # OpenAI Responses API Event Handler
    # ============================================================

    async def _handle_responses_api_event(
        self, sid: str, event_type: str, *args
    ) -> dict:
        """Handle OpenAI Responses API events from local executor.

        Reuses the same processing chain as /api/internal/callback:
        ResponsesAPIEventParser -> StatusUpdatingEmitter -> WebSocketResultEmitter

        IMPORTANT: Uses per-subtask locking to ensure events are processed in order.
        This prevents race conditions when multiple response.output_text.delta events
        arrive concurrently for the same subtask, which would cause text content to
        be appended to Redis in the wrong order.

        Args:
            sid: Socket ID
            event_type: OpenAI Responses API event type (e.g., response.output_text.delta)
            *args: Event arguments (first arg is the event data dict)

        Returns:
            {"success": True} or {"error": str}
        """
        session = await self.get_session(sid)
        user_id = session.get("user_id")
        device_id = session.get("device_id")

        if not user_id or not device_id:
            return {"error": "Not authenticated or not registered"}

        if not args:
            return {"error": "Missing event data"}

        data = args[0]
        if not isinstance(data, dict):
            return {"error": "Invalid event data format"}

        task_id = data.get("task_id")
        subtask_id = data.get("subtask_id")
        event_data = data.get("data", {})
        message_id = data.get("message_id")

        if not task_id or not subtask_id:
            return {"error": "Missing task_id or subtask_id"}

        logger.debug(
            f"[Device WS] Responses API event: type={event_type}, "
            f"task_id={task_id}, subtask_id={subtask_id}"
        )

        # Get lock for this subtask to ensure events are processed in order
        # This prevents race conditions when multiple events arrive concurrently
        lock = self._get_subtask_lock(subtask_id)

        # Track whether this is a terminal event for lock cleanup
        is_terminal = False

        try:
            # Acquire lock to ensure sequential processing of events for this subtask
            async with lock:
                # Parse using shared ResponsesAPIEventParser
                event = self._event_parser.parse(
                    task_id=task_id,
                    subtask_id=subtask_id,
                    message_id=message_id,
                    event_type=event_type,
                    data=event_data,
                )

                if event is None:
                    # Lifecycle events (response.created, etc.) are skipped
                    return {"success": True}

                # Emit via StatusUpdatingEmitter -> WebSocketResultEmitter
                # Pass user_id for task:status notification
                ws_emitter = WebSocketResultEmitter(
                    task_id=task_id,
                    subtask_id=subtask_id,
                    user_id=user_id,
                )
                emitter = StatusUpdatingEmitter(
                    wrapped=ws_emitter,
                    task_id=task_id,
                    subtask_id=subtask_id,
                )
                await emitter.emit(event)
                await emitter.close()

                # Handle terminal events
                is_terminal = event.type in (
                    EventType.DONE.value,
                    EventType.ERROR.value,
                    EventType.CANCELLED.value,
                )
                if is_terminal:
                    await self._publish_task_completed_event(
                        task_id, subtask_id, user_id, device_id, event
                    )

            # Clean up lock after terminal event (outside the lock context)
            if is_terminal:
                self._cleanup_subtask_lock(subtask_id)

            return {"success": True}

        except Exception as e:
            logger.exception(
                f"[Device WS] Error handling Responses API event: "
                f"type={event_type}, subtask_id={subtask_id}, error={e}"
            )
            # Clean up lock on error to prevent memory leak
            self._cleanup_subtask_lock(subtask_id)
            return {"error": str(e)}

    async def _publish_task_completed_event(
        self,
        task_id: int,
        subtask_id: int,
        user_id: int,
        device_id: str,
        event: Any,
    ) -> None:
        """Publish TaskCompletedEvent and broadcast slot update for terminal events."""
        try:
            if event.type == EventType.DONE.value:
                status = "COMPLETED"
                result = event.result if hasattr(event, "result") else None
                error = None
            elif event.type == EventType.ERROR.value:
                status = "FAILED"
                result = None
                error = event.error if hasattr(event, "error") else "Unknown error"
            else:
                status = "CANCELLED"
                result = None
                error = None

            event_bus = get_event_bus()
            await event_bus.publish(
                TaskCompletedEvent(
                    task_id=task_id,
                    subtask_id=subtask_id,
                    user_id=user_id,
                    status=status,
                    result=result,
                    error=error,
                )
            )

            logger.info(
                f"[Device WS] Published TaskCompletedEvent: "
                f"task_id={task_id}, subtask_id={subtask_id}, status={status}"
            )

            # Broadcast slot update after task completion
            await self._broadcast_device_slot_update(user_id, device_id)

        except Exception as e:
            logger.error(
                f"[Device WS] Failed to publish TaskCompletedEvent: {e}",
                exc_info=True,
            )

    # ============================================================
    # Broadcast Helpers
    # ============================================================

    async def _broadcast_device_online(
        self, user_id: int, device_id: str, name: str
    ) -> None:
        """Broadcast device:online event to user room via chat namespace."""
        from app.core.socketio import get_sio
        from app.schemas.device import DeviceStatusEnum

        sio = get_sio()
        event_data = DeviceOnlineEvent(
            device_id=device_id,
            name=name,
            status=DeviceStatusEnum.ONLINE,
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
        self, user_id: int, device_id: str, status: str
    ) -> None:
        """Broadcast device:status event to user room via chat namespace."""
        from app.core.socketio import get_sio
        from app.schemas.device import DeviceStatusEnum

        sio = get_sio()
        # Convert string status to enum
        status_enum = DeviceStatusEnum(status)
        event_data = DeviceStatusEvent(
            device_id=device_id, status=status_enum
        ).model_dump()

        await sio.emit(
            "device:status",
            event_data,
            room=f"user:{user_id}",
            namespace="/chat",
        )
        logger.debug(
            f"[Device WS] Broadcast device:status to user:{user_id}, status={status}"
        )

    async def _broadcast_device_slot_update(self, user_id: int, device_id: str) -> None:
        """
        Broadcast device:slot_update event to user room via chat namespace.

        Queries current slot usage and emits the update.
        """
        from app.core.socketio import get_sio
        from app.schemas.device import DeviceRunningTask

        try:
            with _db_session() as db:
                slot_info = await device_service.get_device_slot_usage_async(
                    db, user_id, device_id
                )

            sio = get_sio()
            event_data = DeviceSlotUpdateEvent(
                device_id=device_id,
                slot_used=slot_info["used"],
                slot_max=slot_info["max"],
                running_tasks=[
                    DeviceRunningTask(**task) for task in slot_info["running_tasks"]
                ],
            ).model_dump()

            await sio.emit(
                "device:slot_update",
                event_data,
                room=f"user:{user_id}",
                namespace="/chat",
            )
            logger.debug(
                f"[Device WS] Broadcast device:slot_update to user:{user_id}, "
                f"slot_used={slot_info['used']}"
            )
        except Exception as e:
            logger.error(f"[Device WS] Error broadcasting slot update: {e}")


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
    device_ns = DeviceNamespace("/local-executor")
    sio.register_namespace(device_ns)
    logger.info("Device namespace registered at /local-executor")
