# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Local Executor WebSocket namespace for local deployment mode.

This namespace handles communication with local executor devices that connect
via WebSocket. Uses device-based protocol with device:register and device:heartbeat.
"""

import logging
from datetime import datetime
from typing import Any, Dict, Optional

import socketio

logger = logging.getLogger(__name__)


# Event names (matching executor/modes/local/events.py)
class DeviceEvents:
    """Device lifecycle events."""

    REGISTER = "device:register"
    HEARTBEAT = "device:heartbeat"


class TaskEvents:
    """Task execution events."""

    EXECUTE = "task:execute"
    PROGRESS = "task:progress"
    RESULT = "task:result"
    CANCEL = "task:cancel"


class ChatEvents:
    """Chat streaming events."""

    MESSAGE = "chat:message"
    CHUNK = "chat:chunk"
    DONE = "chat:done"
    START = "chat:start"
    ERROR = "chat:error"


class LocalExecutorNamespace(socketio.AsyncNamespace):
    """
    Socket.IO namespace for local executor communication.

    Handles:
    - Device registration and heartbeat
    - Task dispatch to executor
    - Progress and result reporting from executor
    - Chat streaming events
    """

    def __init__(self, namespace: str = "/local-executor"):
        """Initialize the local executor namespace."""
        super().__init__(namespace)
        # Track connected devices: sid -> device_info
        self._devices: Dict[str, Dict[str, Any]] = {}
        # Track pending tasks waiting for executor
        self._pending_tasks: Dict[int, Dict[str, Any]] = {}
        # Map event names to handler methods
        self._event_handlers: Dict[str, str] = {
            DeviceEvents.REGISTER: "on_device_register",
            DeviceEvents.HEARTBEAT: "on_device_heartbeat",
            TaskEvents.PROGRESS: "on_task_progress",
            TaskEvents.RESULT: "on_task_result",
            ChatEvents.START: "on_chat_start",
            ChatEvents.CHUNK: "on_chat_chunk",
            ChatEvents.DONE: "on_chat_done",
            ChatEvents.ERROR: "on_chat_error",
        }

    async def trigger_event(self, event: str, sid: str, *args):
        """Override trigger_event to handle custom event names."""
        if event in self._event_handlers:
            handler_name = self._event_handlers[event]
            handler = getattr(self, handler_name, None)
            if handler:
                logger.debug(
                    f"[LocalExecutor] Routing event '{event}' to handler '{handler_name}'"
                )
                return await handler(sid, *args)

        return await super().trigger_event(event, sid, *args)

    async def on_connect(self, sid: str, environ: dict, auth: Optional[dict] = None):
        """Handle device connection."""
        logger.info(f"[LocalExecutor] Connection attempt sid={sid}")

        if not auth or not isinstance(auth, dict):
            logger.warning(f"[LocalExecutor] Missing auth data sid={sid}")
            raise ConnectionRefusedError("Missing authentication token")

        token = auth.get("token")
        if not token:
            logger.warning(f"[LocalExecutor] Missing token in auth sid={sid}")
            raise ConnectionRefusedError("Missing authentication token")

        logger.info(f"[LocalExecutor] Connected sid={sid}")

        await self.save_session(
            sid, {"auth_token": token, "connected_at": datetime.now().isoformat()}
        )

    async def on_disconnect(self, sid: str):
        """Handle device disconnection."""
        logger.info(f"[LocalExecutor] Disconnected sid={sid}")

        if sid in self._devices:
            device_info = self._devices.pop(sid)
            logger.info(
                f"[LocalExecutor] Unregistered device: {device_info.get('device_id', 'unknown')}"
            )

    async def on_device_register(self, sid: str, data: dict) -> dict:
        """Handle device registration (called via sio.call)."""
        device_id = data.get("device_id")
        device_name = data.get("name", "Unknown")

        logger.info(
            f"[LocalExecutor] Device register: sid={sid}, device_id={device_id}, name={device_name}"
        )

        device_info = {
            "sid": sid,
            "device_id": device_id,
            "name": device_name,
            "registered_at": datetime.now().isoformat(),
            "last_heartbeat": datetime.now().isoformat(),
            "capabilities": ["claude_code"],  # Default capability
        }

        self._devices[sid] = device_info
        logger.info(f"[LocalExecutor] Registered device: {device_info}")

        # Check for pending tasks
        await self._dispatch_pending_tasks(sid)

        return {"success": True}

    async def on_device_heartbeat(self, sid: str, data: dict) -> dict:
        """Handle device heartbeat (called via sio.call)."""
        device_id = data.get("device_id")

        if sid in self._devices:
            self._devices[sid]["last_heartbeat"] = datetime.now().isoformat()
            logger.debug(f"[LocalExecutor] Heartbeat received: device_id={device_id}")
            return {"success": True}
        else:
            logger.warning(
                f"[LocalExecutor] Heartbeat from unregistered device: device_id={device_id}"
            )
            return {"success": False, "error": "Device not registered"}

    async def on_task_progress(self, sid: str, data: dict) -> dict:
        """Handle task progress update from executor."""
        task_id = data.get("task_id")
        subtask_id = data.get("subtask_id")
        progress = data.get("progress", 0)
        status = data.get("status")
        message = data.get("message", "")

        logger.info(
            f"[LocalExecutor] Task progress: task_id={task_id}, subtask_id={subtask_id}, "
            f"progress={progress}%, status={status}, message={message}"
        )

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
        """Handle task result from executor."""
        task_id = data.get("task_id")
        subtask_id = data.get("subtask_id")
        status = data.get("status")
        result = data.get("result", {})
        message = data.get("message", "")

        logger.info(
            f"[LocalExecutor] Task result: task_id={task_id}, subtask_id={subtask_id}, "
            f"status={status}, result_keys={list(result.keys()) if result else []}"
        )

        await self._update_task_status(task_id, subtask_id, status, result)

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
        """Handle chat start event from executor."""
        task_id = data.get("task_id")
        subtask_id = data.get("subtask_id")
        model = data.get("model", "")

        logger.info(
            f"[LocalExecutor] Chat start: task_id={task_id}, subtask_id={subtask_id}, model={model}"
        )

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
        """Handle streaming chat chunk from executor."""
        task_id = data.get("task_id")
        subtask_id = data.get("subtask_id")
        chunk = data.get("chunk", "")

        await self._forward_to_chat_room(
            task_id,
            "chat:chunk",
            {
                "subtask_id": subtask_id,
                "content": chunk,
                "offset": 0,
            },
        )

        return {"success": True}

    async def on_chat_done(self, sid: str, data: dict) -> dict:
        """Handle chat done event from executor."""
        task_id = data.get("task_id")
        subtask_id = data.get("subtask_id")
        content = data.get("content", "")
        usage = data.get("usage")

        logger.info(
            f"[LocalExecutor] Chat done: task_id={task_id}, subtask_id={subtask_id}, "
            f"content_len={len(content)}, usage={usage}"
        )

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
        """Handle chat error event from executor."""
        task_id = data.get("task_id")
        subtask_id = data.get("subtask_id")
        error = data.get("error", "Unknown error")

        logger.error(
            f"[LocalExecutor] Chat error: task_id={task_id}, subtask_id={subtask_id}, error={error}"
        )

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
    # Task Dispatch Methods
    # ============================================================

    async def dispatch_task(self, task_data: dict) -> bool:
        """Dispatch a task to a connected device."""
        task_id = task_data.get("task_id")

        for sid, device_info in self._devices.items():
            capabilities = device_info.get("capabilities", [])
            if "claude_code" in capabilities:
                logger.info(
                    f"[LocalExecutor] Dispatching task {task_id} to device "
                    f"{device_info.get('device_id')} (sid={sid})"
                )
                await self.emit(TaskEvents.EXECUTE, task_data, to=sid)
                return True

        logger.warning(
            f"[LocalExecutor] No device available for task {task_id}, queueing"
        )
        self._pending_tasks[task_id] = task_data
        return False

    async def cancel_task(self, task_id: int) -> bool:
        """Send cancel request to devices."""
        for sid in self._devices.keys():
            await self.emit(TaskEvents.CANCEL, {"task_id": task_id}, to=sid)

        logger.info(f"[LocalExecutor] Cancel request sent for task {task_id}")
        return True

    # ============================================================
    # Helper Methods
    # ============================================================

    async def _dispatch_pending_tasks(self, sid: str) -> None:
        """Dispatch pending tasks to newly connected device."""
        if not self._pending_tasks:
            return

        device_info = self._devices.get(sid, {})
        capabilities = device_info.get("capabilities", [])

        for task_id, task_data in list(self._pending_tasks.items()):
            if "claude_code" in capabilities:
                logger.info(
                    f"[LocalExecutor] Dispatching pending task {task_id} to device sid={sid}"
                )
                await self.emit(TaskEvents.EXECUTE, task_data, to=sid)
                del self._pending_tasks[task_id]

    async def _forward_to_chat_room(self, task_id: int, event: str, data: dict) -> None:
        """Forward event to the chat room for task."""
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
        """Update task and subtask status in database."""
        from app.db.session import SessionLocal
        from app.models.subtask import Subtask, SubtaskStatus
        from app.models.task import TaskResource

        db = SessionLocal()
        try:
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

    def get_connected_devices(self) -> list:
        """Get list of connected devices."""
        return list(self._devices.values())

    async def dispatch_test_task(self, prompt: str, model_env: dict = None) -> dict:
        """Dispatch a test task to a connected device."""
        import time

        task_id = int(time.time() * 1000) % 1000000
        subtask_id = task_id + 1

        bot_config = {
            "id": 1,
            "name": "test-bot",
            "shell": {"shellType": "ClaudeCode"},
            "ghost": {
                "systemPrompt": "You are a helpful assistant for testing.",
            },
            "agent_config": {
                "env": model_env or {},
            },
        }

        task_data = {
            "task_id": task_id,
            "subtask_id": subtask_id,
            "task_title": "Test Task",
            "subtask_title": "Test Subtask",
            "prompt": prompt,
            "bot": [bot_config],
            "team": {"name": "test-team", "members": [bot_config]},
            "git_url": "",
            "branch_name": "",
            "attachments": [],
            "auth_token": "test-token",
        }

        dispatched = await self.dispatch_task(task_data)

        if dispatched:
            device_sid = None
            for sid, info in self._devices.items():
                if "claude_code" in info.get("capabilities", []):
                    device_sid = sid
                    break

            return {
                "success": True,
                "task_id": task_id,
                "subtask_id": subtask_id,
                "device_sid": device_sid,
                "message": f"Task dispatched to device {device_sid}",
            }
        else:
            return {
                "success": False,
                "task_id": task_id,
                "error": "No device available, task queued",
                "pending_tasks": len(self._pending_tasks),
            }


# Global namespace instance
_local_executor_namespace: Optional[LocalExecutorNamespace] = None


def get_local_executor_namespace() -> Optional[LocalExecutorNamespace]:
    """Get the global local executor namespace instance."""
    return _local_executor_namespace


def register_local_executor_namespace(sio: socketio.AsyncServer) -> None:
    """Register the local executor namespace with the Socket.IO server."""
    global _local_executor_namespace
    _local_executor_namespace = LocalExecutorNamespace("/local-executor")
    sio.register_namespace(_local_executor_namespace)
    logger.info("Local Executor namespace registered at /local-executor")
