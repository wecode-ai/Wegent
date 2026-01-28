# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Local Executor WebSocket namespace for local deployment mode.

This namespace handles communication with local executor instances that connect
via WebSocket instead of going through executor_manager.

Used for local development and debugging of the local executor mode.
"""

import asyncio
import logging
from datetime import datetime
from typing import Any, Dict, Optional

import socketio

logger = logging.getLogger(__name__)


# Event names (matching executor/modes/local/events.py)
class LocalExecutorEvents:
    """Local Executor events for lifecycle management."""

    REGISTER = "local:executor:register"
    UNREGISTER = "local:executor:unregister"
    HEARTBEAT = "local:executor:heartbeat"


class LocalTaskEvents:
    """Local Executor task events."""

    DISPATCH = "local:task:dispatch"
    PROGRESS = "local:task:progress"
    RESULT = "local:task:result"
    CANCEL = "local:task:cancel"


class LocalChatEvents:
    """Local Executor chat events for streaming messages."""

    MESSAGE = "local:chat:message"
    CHUNK = "local:chat:chunk"
    DONE = "local:chat:done"
    START = "local:chat:start"
    ERROR = "local:chat:error"


class LocalExecutorNamespace(socketio.AsyncNamespace):
    """
    Socket.IO namespace for local executor communication.

    Handles:
    - Executor registration and heartbeat
    - Task dispatch to executor
    - Progress and result reporting from executor
    - Chat streaming events

    This is a mock/debug implementation for local development.
    """

    def __init__(self, namespace: str = "/local-executor"):
        """Initialize the local executor namespace."""
        super().__init__(namespace)
        # Track connected executors: sid -> executor_info
        self._executors: Dict[str, Dict[str, Any]] = {}
        # Track pending tasks waiting for executor
        self._pending_tasks: Dict[int, Dict[str, Any]] = {}
        # Map colon-separated event names to handler methods
        self._event_handlers: Dict[str, str] = {
            LocalExecutorEvents.REGISTER: "on_executor_register",
            LocalExecutorEvents.UNREGISTER: "on_executor_unregister",
            LocalExecutorEvents.HEARTBEAT: "on_executor_heartbeat",
            LocalTaskEvents.PROGRESS: "on_task_progress",
            LocalTaskEvents.RESULT: "on_task_result",
            LocalChatEvents.START: "on_chat_start",
            LocalChatEvents.CHUNK: "on_chat_chunk",
            LocalChatEvents.DONE: "on_chat_done",
            LocalChatEvents.ERROR: "on_chat_error",
        }

    async def trigger_event(self, event: str, sid: str, *args):
        """
        Override trigger_event to handle colon-separated event names.

        Args:
            event: Event name (e.g., 'local:executor:register')
            sid: Socket ID
            *args: Event arguments

        Returns:
            Result from the event handler
        """
        # Check if this is a colon-separated event we handle
        if event in self._event_handlers:
            handler_name = self._event_handlers[event]
            handler = getattr(self, handler_name, None)
            if handler:
                logger.debug(
                    f"[LocalExecutor] Routing event '{event}' to handler '{handler_name}'"
                )
                return await handler(sid, *args)

        # Fall back to default behavior for other events (connect, disconnect, etc.)
        return await super().trigger_event(event, sid, *args)

    async def on_connect(self, sid: str, environ: dict, auth: Optional[dict] = None):
        """
        Handle executor connection.

        Args:
            sid: Socket ID
            environ: WSGI environ dict
            auth: Authentication data (expected: {"token": "..."})

        Raises:
            ConnectionRefusedError: If authentication fails
        """
        logger.info(f"[LocalExecutor] Connection attempt sid={sid}")

        # Validate auth token
        if not auth or not isinstance(auth, dict):
            logger.warning(f"[LocalExecutor] Missing auth data sid={sid}")
            raise ConnectionRefusedError("Missing authentication token")

        token = auth.get("token")
        if not token:
            logger.warning(f"[LocalExecutor] Missing token in auth sid={sid}")
            raise ConnectionRefusedError("Missing authentication token")

        # For mock/debug purposes, accept any non-empty token
        # In production, this should validate against WEGENT_AUTH_TOKEN
        logger.info(f"[LocalExecutor] Connected sid={sid}")

        # Save session data
        await self.save_session(
            sid, {"auth_token": token, "connected_at": datetime.now().isoformat()}
        )

    async def on_disconnect(self, sid: str):
        """
        Handle executor disconnection.

        Args:
            sid: Socket ID
        """
        logger.info(f"[LocalExecutor] Disconnected sid={sid}")

        # Remove from executors registry
        if sid in self._executors:
            executor_info = self._executors.pop(sid)
            logger.info(
                f"[LocalExecutor] Unregistered executor: {executor_info.get('executor_type', 'unknown')}"
            )

    async def on_executor_register(self, sid: str, data: dict) -> dict:
        """
        Handle executor registration.

        Args:
            sid: Socket ID
            data: Registration data containing executor info

        Returns:
            {"success": true} or {"error": "..."}
        """
        logger.info(f"[LocalExecutor] Register request: sid={sid}, data={data}")

        executor_info = {
            "sid": sid,
            "executor_type": data.get("executor_type", "local"),
            "platform": data.get("platform"),
            "arch": data.get("arch"),
            "version": data.get("version"),
            "capabilities": data.get("capabilities", []),
            "hostname": data.get("hostname"),
            "registered_at": datetime.now().isoformat(),
            "last_heartbeat": datetime.now().isoformat(),
        }

        self._executors[sid] = executor_info
        logger.info(f"[LocalExecutor] Registered executor: {executor_info}")

        # Check if there are pending tasks to dispatch
        await self._dispatch_pending_tasks(sid)

        return {"success": True}

    async def on_executor_unregister(self, sid: str, data: dict) -> dict:
        """
        Handle executor unregistration.

        Args:
            sid: Socket ID
            data: Unregistration data

        Returns:
            {"success": true}
        """
        logger.info(f"[LocalExecutor] Unregister request: sid={sid}")

        if sid in self._executors:
            executor_info = self._executors.pop(sid)
            logger.info(
                f"[LocalExecutor] Unregistered executor: {executor_info.get('executor_type', 'unknown')}"
            )

        return {"success": True}

    async def on_executor_heartbeat(self, sid: str, data: dict) -> dict:
        """
        Handle executor heartbeat.

        Args:
            sid: Socket ID
            data: Heartbeat data containing timestamp and status

        Returns:
            {"success": true}
        """
        if sid in self._executors:
            self._executors[sid]["last_heartbeat"] = datetime.now().isoformat()
            logger.debug(
                f"[LocalExecutor] Heartbeat received: sid={sid}, status={data.get('status')}"
            )
        else:
            logger.warning(
                f"[LocalExecutor] Heartbeat from unregistered executor: sid={sid}"
            )

        return {"success": True}

    async def on_task_progress(self, sid: str, data: dict) -> dict:
        """
        Handle task progress update from executor.

        Args:
            sid: Socket ID
            data: Progress data containing task_id, subtask_id, progress, status, message

        Returns:
            {"success": true}
        """
        task_id = data.get("task_id")
        subtask_id = data.get("subtask_id")
        progress = data.get("progress", 0)
        status = data.get("status")
        message = data.get("message", "")

        logger.info(
            f"[LocalExecutor] Task progress: task_id={task_id}, subtask_id={subtask_id}, "
            f"progress={progress}%, status={status}, message={message}"
        )

        # Forward to chat namespace for UI update
        await self._forward_to_chat_room(
            task_id,
            "task:status",
            {
                "task_id": task_id,
                "subtask_id": subtask_id,
                "progress": progress,
                "status": status,
                "message": message,
            },
        )

        return {"success": True}

    async def on_task_result(self, sid: str, data: dict) -> dict:
        """
        Handle task result from executor.

        Args:
            sid: Socket ID
            data: Result data containing task_id, subtask_id, status, result

        Returns:
            {"success": true}
        """
        task_id = data.get("task_id")
        subtask_id = data.get("subtask_id")
        status = data.get("status")
        result = data.get("result", {})
        message = data.get("message", "")

        logger.info(
            f"[LocalExecutor] Task result: task_id={task_id}, subtask_id={subtask_id}, "
            f"status={status}, result_keys={list(result.keys()) if result else []}"
        )

        # Update task/subtask status in database
        await self._update_task_status(task_id, subtask_id, status, result)

        # Forward completion event to chat room
        await self._forward_to_chat_room(
            task_id,
            "chat:done",
            {
                "task_id": task_id,
                "subtask_id": subtask_id,
                "result": result,
                "offset": len(result.get("value", "")) if result else 0,
            },
        )

        return {"success": True}

    async def on_chat_start(self, sid: str, data: dict) -> dict:
        """
        Handle chat start event from executor.

        Args:
            sid: Socket ID
            data: Start data containing task_id, subtask_id, model

        Returns:
            {"success": true}
        """
        task_id = data.get("task_id")
        subtask_id = data.get("subtask_id")
        model = data.get("model", "")

        logger.info(
            f"[LocalExecutor] Chat start: task_id={task_id}, subtask_id={subtask_id}, model={model}"
        )

        # Forward to chat room
        await self._forward_to_chat_room(
            task_id,
            "chat:start",
            {
                "task_id": task_id,
                "subtask_id": subtask_id,
                "bot_name": model,
            },
        )

        return {"success": True}

    async def on_chat_chunk(self, sid: str, data: dict) -> dict:
        """
        Handle streaming chat chunk from executor.

        Args:
            sid: Socket ID
            data: Chunk data containing task_id, subtask_id, chunk

        Returns:
            {"success": true}
        """
        task_id = data.get("task_id")
        subtask_id = data.get("subtask_id")
        chunk = data.get("chunk", "")

        # Don't log every chunk to avoid spam
        # Forward to chat room for streaming display
        await self._forward_to_chat_room(
            task_id,
            "chat:chunk",
            {
                "subtask_id": subtask_id,
                "content": chunk,
                "offset": 0,  # Will be calculated by frontend
            },
        )

        return {"success": True}

    async def on_chat_done(self, sid: str, data: dict) -> dict:
        """
        Handle chat done event from executor.

        Args:
            sid: Socket ID
            data: Done data containing task_id, subtask_id, content, usage

        Returns:
            {"success": true}
        """
        task_id = data.get("task_id")
        subtask_id = data.get("subtask_id")
        content = data.get("content", "")
        usage = data.get("usage")

        logger.info(
            f"[LocalExecutor] Chat done: task_id={task_id}, subtask_id={subtask_id}, "
            f"content_len={len(content)}, usage={usage}"
        )

        # Forward to chat room
        await self._forward_to_chat_room(
            task_id,
            "chat:done",
            {
                "task_id": task_id,
                "subtask_id": subtask_id,
                "offset": len(content),
                "result": (
                    {"value": content, "usage": usage} if usage else {"value": content}
                ),
            },
        )

        return {"success": True}

    async def on_chat_error(self, sid: str, data: dict) -> dict:
        """
        Handle chat error event from executor.

        Args:
            sid: Socket ID
            data: Error data containing task_id, subtask_id, error

        Returns:
            {"success": true}
        """
        task_id = data.get("task_id")
        subtask_id = data.get("subtask_id")
        error = data.get("error", "Unknown error")

        logger.error(
            f"[LocalExecutor] Chat error: task_id={task_id}, subtask_id={subtask_id}, error={error}"
        )

        # Forward to chat room
        await self._forward_to_chat_room(
            task_id,
            "chat:error",
            {
                "subtask_id": subtask_id,
                "error": error,
            },
        )

        return {"success": True}

    # ============================================================
    # Task Dispatch Methods (called by Backend to send tasks to executor)
    # ============================================================

    async def dispatch_task(self, task_data: dict) -> bool:
        """
        Dispatch a task to a connected local executor.

        Args:
            task_data: Task data to send to executor

        Returns:
            True if dispatched successfully, False otherwise
        """
        task_id = task_data.get("task_id")

        # Find an available executor
        for sid, executor_info in self._executors.items():
            # Check if executor supports the required capability
            capabilities = executor_info.get("capabilities", [])
            if "claude_code" in capabilities:
                logger.info(
                    f"[LocalExecutor] Dispatching task {task_id} to executor sid={sid}"
                )

                await self.emit(LocalTaskEvents.DISPATCH, task_data, to=sid)
                return True

        # No executor available, queue the task
        logger.warning(
            f"[LocalExecutor] No executor available for task {task_id}, queueing"
        )
        self._pending_tasks[task_id] = task_data
        return False

    async def cancel_task(self, task_id: int) -> bool:
        """
        Send cancel request to executor.

        Args:
            task_id: Task ID to cancel

        Returns:
            True if cancel request sent, False otherwise
        """
        # Broadcast cancel to all executors (they will check if they're running this task)
        for sid in self._executors.keys():
            await self.emit(LocalTaskEvents.CANCEL, {"task_id": task_id}, to=sid)

        logger.info(f"[LocalExecutor] Cancel request sent for task {task_id}")
        return True

    # ============================================================
    # Helper Methods
    # ============================================================

    async def _dispatch_pending_tasks(self, sid: str) -> None:
        """
        Dispatch pending tasks to newly connected executor.

        Args:
            sid: Socket ID of the new executor
        """
        if not self._pending_tasks:
            return

        executor_info = self._executors.get(sid, {})
        capabilities = executor_info.get("capabilities", [])

        for task_id, task_data in list(self._pending_tasks.items()):
            if "claude_code" in capabilities:
                logger.info(
                    f"[LocalExecutor] Dispatching pending task {task_id} to executor sid={sid}"
                )
                await self.emit(LocalTaskEvents.DISPATCH, task_data, to=sid)
                del self._pending_tasks[task_id]

    async def _forward_to_chat_room(self, task_id: int, event: str, data: dict) -> None:
        """
        Forward event to the chat room for task.

        Args:
            task_id: Task ID
            event: Event name
            data: Event data
        """
        from app.core.socketio import get_sio

        sio = get_sio()
        task_room = f"task:{task_id}"

        try:
            await sio.emit(event, data, room=task_room, namespace="/chat")
            logger.debug(f"[LocalExecutor] Forwarded {event} to room {task_room}")
        except Exception as e:
            logger.error(f"[LocalExecutor] Failed to forward {event}: {e}")

    async def _update_task_status(
        self, task_id: int, subtask_id: int, status: str, result: dict
    ) -> None:
        """
        Update task and subtask status in database.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            status: Status string
            result: Result data
        """
        # Import here to avoid circular imports
        from app.db.session import SessionLocal
        from app.models.subtask import Subtask, SubtaskStatus
        from app.models.task import TaskResource

        db = SessionLocal()
        try:
            # Update subtask
            subtask = db.query(Subtask).filter(Subtask.id == subtask_id).first()
            if subtask:
                if status in ["completed", "success", "SUCCESS", "COMPLETED"]:
                    subtask.status = SubtaskStatus.COMPLETED
                elif status in ["failed", "error", "FAILED"]:
                    subtask.status = SubtaskStatus.FAILED
                subtask.progress = 100
                subtask.result = result
                subtask.completed_at = datetime.now()
                subtask.updated_at = datetime.now()

            # Update task
            task = (
                db.query(TaskResource)
                .filter(TaskResource.id == task_id, TaskResource.kind == "Task")
                .first()
            )
            if task:
                from sqlalchemy.orm.attributes import flag_modified

                task_json = task.json or {}
                if "status" in task_json:
                    task_json["status"]["status"] = (
                        "COMPLETED"
                        if status in ["completed", "success", "SUCCESS", "COMPLETED"]
                        else "FAILED"
                    )
                    task_json["status"]["updatedAt"] = datetime.now().isoformat()
                    task_json["status"]["completedAt"] = datetime.now().isoformat()
                task.json = task_json
                task.updated_at = datetime.now()
                flag_modified(task, "json")

            db.commit()
            logger.info(
                f"[LocalExecutor] Updated task/subtask status: task_id={task_id}, "
                f"subtask_id={subtask_id}, status={status}"
            )
        except Exception as e:
            logger.error(f"[LocalExecutor] Failed to update task status: {e}")
            db.rollback()
        finally:
            db.close()

    def get_connected_executors(self) -> list:
        """
        Get list of connected executors.

        Returns:
            List of executor info dicts
        """
        return list(self._executors.values())


# Global namespace instance
_local_executor_namespace: Optional[LocalExecutorNamespace] = None


def get_local_executor_namespace() -> Optional[LocalExecutorNamespace]:
    """Get the global local executor namespace instance."""
    return _local_executor_namespace


def register_local_executor_namespace(sio: socketio.AsyncServer) -> None:
    """
    Register the local executor namespace with the Socket.IO server.

    Args:
        sio: Socket.IO server instance
    """
    global _local_executor_namespace
    _local_executor_namespace = LocalExecutorNamespace("/local-executor")
    sio.register_namespace(_local_executor_namespace)
    logger.info("Local Executor namespace registered at /local-executor")
