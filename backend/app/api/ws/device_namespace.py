# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Device namespace for Socket.IO.

This module implements the /local-executor namespace for local device connections.
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

import logging
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict, Generator, Optional

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
class ProgressUpdateResult:
    """Result of progress update operation."""

    success: bool
    error: Optional[str] = None
    task_id: Optional[int] = None
    subtask_id: Optional[int] = None
    delta_content: str = ""
    full_content: str = ""
    new_offset: int = 0
    has_thinking: bool = False
    thinking: Optional[Any] = None
    workbench: Optional[Any] = None
    is_completed: bool = False


@dataclass
class CompleteUpdateResult:
    """Result of task complete update operation."""

    success: bool
    error: Optional[str] = None
    task_id: Optional[int] = None
    subtask_id: Optional[int] = None
    user_id: Optional[int] = None
    status: str = "COMPLETED"
    content: str = ""
    thinking: Optional[Any] = None
    workbench: Optional[Any] = None
    error_message: Optional[str] = None
    message_id: Optional[int] = None


def _update_subtask_progress(
    subtask_id: int, device_id: str, data: dict
) -> ProgressUpdateResult:
    """
    Update subtask progress in database.

    This function executes database operations and releases connection immediately.
    Returns all data needed for subsequent WebSocket emissions.
    """
    try:
        with _db_session() as db:
            subtask = db.query(Subtask).filter(Subtask.id == subtask_id).first()
            if not subtask:
                return ProgressUpdateResult(success=False, error="Subtask not found")

            expected_executor = f"device-{device_id}"
            if subtask.executor_name != expected_executor:
                return ProgressUpdateResult(
                    success=False, error="Subtask does not belong to this device"
                )

            # Update status if provided
            if "status" in data:
                try:
                    subtask.status = SubtaskStatus(data["status"])
                except ValueError:
                    pass

            # Update progress if provided
            if "progress" in data:
                subtask.progress = data["progress"]

            # Process result with delta calculation
            result_data = data.get("result")
            delta_content = ""
            full_content = ""
            new_offset = 0
            has_thinking = False
            thinking = None
            workbench = None

            if result_data is not None:
                full_content = result_data.get("value", "") or ""
                thinking = result_data.get("thinking")
                workbench = result_data.get("workbench")
                has_thinking = thinking is not None

                # Get last emitted offset
                last_offset = 0
                if subtask.result and isinstance(subtask.result, dict):
                    last_offset = subtask.result.get("_last_emitted_offset", 0)

                # Calculate delta
                delta_content = full_content[last_offset:]
                new_offset = len(full_content)

                # Update subtask result
                subtask.result = {
                    "value": full_content,
                    "thinking": thinking,
                    "workbench": workbench,
                    "_last_emitted_offset": new_offset,
                }

            task_id = subtask.task_id
            is_completed = data.get("status") == "COMPLETED"

            # Commit happens automatically when exiting context manager

        return ProgressUpdateResult(
            success=True,
            task_id=task_id,
            subtask_id=subtask_id,
            delta_content=delta_content,
            full_content=full_content,
            new_offset=new_offset,
            has_thinking=has_thinking,
            thinking=thinking,
            workbench=workbench,
            is_completed=is_completed,
        )

    except Exception as e:
        logger.error(f"[Device WS] Error updating subtask progress: {e}")
        return ProgressUpdateResult(success=False, error=str(e))


def _update_subtask_complete(
    subtask_id: int, device_id: str, user_id: int, data: dict
) -> CompleteUpdateResult:
    """
    Update subtask completion in database.

    This function executes database operations and releases connection immediately.
    Returns all data needed for subsequent WebSocket emissions.
    """
    try:
        with _db_session() as db:
            subtask = db.query(Subtask).filter(Subtask.id == subtask_id).first()
            if not subtask:
                return CompleteUpdateResult(success=False, error="Subtask not found")

            expected_executor = f"device-{device_id}"
            if subtask.executor_name != expected_executor:
                return CompleteUpdateResult(
                    success=False, error="Subtask does not belong to this device"
                )

            # Update status
            status_str = data.get("status", "COMPLETED")
            try:
                subtask.status = SubtaskStatus(status_str)
            except ValueError:
                subtask.status = SubtaskStatus.COMPLETED

            subtask.progress = data.get("progress", 100)
            subtask.completed_at = datetime.now()

            if "result" in data:
                subtask.result = data["result"]

            error_message = data.get("error_message")
            if error_message:
                subtask.error_message = error_message

            # Update task status
            from app.schemas.task import TaskUpdate
            from app.services.adapters.task_kinds import task_kinds_service

            task_status = (
                "FAILED" if subtask.status == SubtaskStatus.FAILED else "COMPLETED"
            )
            try:
                task_kinds_service.update_task(
                    db=db,
                    task_id=subtask.task_id,
                    obj_in=TaskUpdate(status=task_status),
                    user_id=user_id,
                )
            except Exception as e:
                logger.error(
                    f"[Device WS] Failed to update task {subtask.task_id} status: {e}"
                )

            # Collect data for WebSocket emission
            result = data.get("result", {})
            content = result.get("value", "") if result else ""

            return CompleteUpdateResult(
                success=True,
                task_id=subtask.task_id,
                subtask_id=subtask_id,
                user_id=user_id,
                status=task_status,
                content=content,
                thinking=result.get("thinking") if result else None,
                workbench=result.get("workbench") if result else None,
                error_message=error_message,
                message_id=subtask.message_id,
            )

    except Exception as e:
        logger.error(f"[Device WS] Error updating subtask completion: {e}")
        return CompleteUpdateResult(success=False, error=str(e))


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
    user_id: int, device_id: str, name: str
) -> tuple[bool, Optional[str]]:
    """
    Register or update device CRD in database.

    Args:
        user_id: Device owner user ID
        device_id: Device unique identifier (stored in Kind.name)
        name: Device display name

    Returns (success, error_message).
    """
    try:
        with _db_session() as db:
            device_service.upsert_device_crd(
                db=db,
                user_id=user_id,
                device_id=device_id,
                name=name,
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

                # Database operation: quick in, quick out
                # Returns list of failed subtasks for WebSocket emission
                failed_subtasks = _handle_device_disconnect(user_id, device_id)

                # WebSocket emissions happen AFTER database connection is released
                ws_emitter = get_ws_emitter()
                if ws_emitter:
                    # Track unique task IDs to emit task:status only once per task
                    emitted_task_ids = set()
                    for info in failed_subtasks:
                        await ws_emitter.emit_chat_error(
                            task_id=info.task_id,
                            subtask_id=info.subtask_id,
                            error="Device disconnected",
                            message_id=info.message_id,
                        )
                        # Emit task:status to notify frontend of task failure
                        if info.task_id not in emitted_task_ids:
                            await ws_emitter.emit_task_status(
                                user_id=info.user_id,
                                task_id=info.task_id,
                                status="FAILED",
                                progress=0,
                            )
                            emitted_task_ids.add(info.task_id)

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
            f"name={payload.name}"
        )

        # Database operation: quick in, quick out
        success, error = _register_device(user_id, payload.device_id, payload.name)
        if not success:
            return {"error": f"Registration failed: {error}"}

        # Redis and session operations happen AFTER database connection is released
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

        # Refresh Redis TTL
        await device_service.refresh_device_heartbeat(user_id, payload.device_id)

        # Database operation: quick in, quick out
        _update_device_heartbeat(user_id, payload.device_id)

        logger.debug(
            f"[Device WS] Heartbeat received: user={user_id}, device={payload.device_id}"
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

        logger.info(
            f"[Device WS] task:progress received: subtask_id={subtask_id}, data={data}"
        )

        # Database operation: quick in, quick out
        result = _update_subtask_progress(subtask_id, device_id, data)

        if not result.success:
            return {"error": result.error}

        # WebSocket emission happens AFTER database connection is released
        if result.delta_content or result.has_thinking:
            ws_emitter = get_ws_emitter()
            if ws_emitter:
                await ws_emitter.emit_chat_chunk(
                    task_id=result.task_id,
                    subtask_id=subtask_id,
                    content=result.delta_content,
                    offset=result.new_offset,
                    result={
                        "value": result.full_content,
                        "thinking": result.thinking,
                        "workbench": result.workbench,
                    },
                )
                logger.debug(
                    f"[Device WS] Emitted chat:chunk: subtask={subtask_id}, "
                    f"delta_len={len(result.delta_content)}, has_thinking={result.has_thinking}"
                )

        logger.debug(
            f"[Device WS] Progress received: subtask={subtask_id}, progress={data.get('progress', 0)}"
        )

        # If status is COMPLETED, delegate to on_task_complete
        if result.is_completed:
            logger.info(
                f"[Device WS] Progress event with COMPLETED status, treating as completion: subtask={subtask_id}"
            )
            return await self.on_task_complete(sid, data)

        return {"success": True}

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

        # Database operation: quick in, quick out
        result = _update_subtask_complete(subtask_id, device_id, user_id, data)

        if not result.success:
            return {"error": result.error}

        # WebSocket emission happens AFTER database connection is released
        ws_emitter = get_ws_emitter()
        if ws_emitter:
            if result.status == "FAILED":
                await ws_emitter.emit_chat_error(
                    task_id=result.task_id,
                    subtask_id=subtask_id,
                    error=result.error_message or "Task failed",
                    message_id=result.message_id,
                )
            else:
                await ws_emitter.emit_chat_done(
                    task_id=result.task_id,
                    subtask_id=subtask_id,
                    offset=len(result.content),
                    result={
                        "value": result.content,
                        "thinking": result.thinking,
                        "workbench": result.workbench,
                    },
                    message_id=result.message_id,
                )

            # Emit task:status to user room to notify frontend of task completion
            await ws_emitter.emit_task_status(
                user_id=user_id,
                task_id=result.task_id,
                status=result.status,
                progress=100,
            )

        logger.info(
            f"[Device WS] Task complete: subtask={subtask_id}, status={result.status}"
        )

        return {"success": True}

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
