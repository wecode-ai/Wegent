# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Process entry point for Pod-local IM channel ownership."""

from __future__ import annotations

import asyncio
import logging
import os
import signal
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any, Protocol

from app.core.bounded_executor import (
    BoundedExecutor,
    BoundedExecutorOverloaded,
    run_bounded_to_completion,
)
from app.core.config import settings
from app.core.logging import setup_logging
from app.services.channels.manager import ChannelLike, ChannelManager
from app.services.channels.worker_client import (
    CHANNEL_COMPLETION_CONTENT_MAX_CHARS,
    CHANNEL_WORKER_MAX_CONNECTIONS,
    ChannelWorkerError,
    read_channel_frame,
    write_channel_frame,
)
from shared.models import EventType, ExecutionEvent

logger = logging.getLogger(__name__)

_FIRST_FRAME_TIMEOUT_SECONDS = 5.0
_OPERATION_TIMEOUT_SECONDS = 120.0
_FRAME_WRITE_TIMEOUT_SECONDS = 5.0
_CLOSE_TIMEOUT_SECONDS = 1.0
_CHANNEL_DB_EXECUTOR = BoundedExecutor(
    max_workers=1,
    max_in_flight=2,
    max_waiters=CHANNEL_WORKER_MAX_CONNECTIONS,
    thread_name_prefix="wegent-channel-db",
)
_CHANNEL_FS_EXECUTOR = BoundedExecutor(
    max_workers=1,
    max_in_flight=1,
    max_waiters=1,
    thread_name_prefix="wegent-channel-fs",
)
_CHANNEL_EVENT_EXECUTOR = BoundedExecutor(
    max_workers=2,
    max_in_flight=4,
    max_waiters=CHANNEL_WORKER_MAX_CONNECTIONS,
    thread_name_prefix="wegent-channel-event",
)
_EXECUTION_EVENT_FIELDS = frozenset(ExecutionEvent().to_dict())


class ChannelLifecycleManager(Protocol):
    """ChannelManager operations owned exclusively by the worker process."""

    async def start_all_enabled(self) -> int:
        """Start every enabled channel."""
        ...

    async def start_channel(self, channel: ChannelLike) -> bool:
        """Start one channel."""
        ...

    async def restart_channel(self, channel: ChannelLike) -> bool:
        """Restart one channel."""
        ...

    async def stop_channel(self, channel_id: int) -> None:
        """Stop one channel."""
        ...

    async def stop_all(self) -> int:
        """Stop every channel."""
        ...

    def is_channel_running(self, channel_id: int) -> bool:
        """Return whether one channel is running."""
        ...

    def get_status(self, channel_id: int) -> dict[str, Any] | None:
        """Return one provider status."""
        ...


ChannelLoader = Callable[[int], Awaitable[ChannelLike | None]]


class EventForwarder(Protocol):
    """Local callback implementation invoked only by channel-worker."""

    async def __call__(
        self,
        *,
        task_id: int | str,
        subtask_id: int,
        event: ExecutionEvent,
        source: str,
    ) -> None:
        """Forward one non-terminal event to channel emitters."""
        ...


class TaskCompletionHandler(Protocol):
    """Local terminal callback implementation invoked by channel-worker."""

    async def __call__(
        self,
        *,
        task_id: int | str,
        subtask_id: int,
        status: str,
        content: str,
        error: str | None,
    ) -> bool:
        """Finish channel callbacks for one task."""
        ...


class DeviceNotificationHandler(Protocol):
    """Local notification implementation invoked by channel-worker."""

    async def __call__(
        self,
        *,
        user_id: int,
        target_type: str,
        device_name: str | None,
    ) -> dict[str, Any]:
        """Send one default-target notification."""
        ...


def _load_channel_sync(channel_id: int) -> ChannelLike | None:
    """Load one detached, decrypted channel configuration by primary key."""
    from app.api.endpoints.admin.im_channels import IMChannelAdapter
    from app.db.session import SessionLocal
    from app.models.kind import Kind
    from app.services.channels.manager import MESSAGER_KIND, MESSAGER_USER_ID

    db = SessionLocal()
    try:
        channel = (
            db.query(Kind)
            .filter(
                Kind.id == channel_id,
                Kind.kind == MESSAGER_KIND,
                Kind.user_id == MESSAGER_USER_ID,
                Kind.is_active.is_(True),
            )
            .first()
        )
        return IMChannelAdapter(channel) if channel is not None else None
    finally:
        db.close()


async def load_channel_nonblocking(channel_id: int) -> ChannelLike | None:
    """Keep synchronous SQLAlchemy and config decryption off the worker loop."""
    return await _CHANNEL_DB_EXECUTOR.run(_load_channel_sync, channel_id)


def _register_channel_callback_services() -> None:
    """Populate the process-local callback registry before accepting IPC."""
    from app.services.channels.dingtalk import callback as _dingtalk_callback
    from app.services.channels.telegram import callback as _telegram_callback
    from app.services.channels.weibo import callback as _weibo_callback

    del _dingtalk_callback, _telegram_callback, _weibo_callback


async def _forward_event_locally(
    *,
    task_id: int | str,
    subtask_id: int,
    event: ExecutionEvent,
    source: str,
) -> None:
    """Call the provider-local implementation, never the UDS client."""
    from app.services.channels.callback import forward_event_to_channel_callbacks

    await forward_event_to_channel_callbacks(
        task_id=task_id,
        subtask_id=subtask_id,
        event=event,
        source=source,
    )


async def _handle_task_completed_locally(
    *,
    task_id: int | str,
    subtask_id: int,
    status: str,
    content: str,
    error: str | None,
) -> bool:
    """Call the process-local callback registry for terminal delivery."""
    from app.services.channels.callback import get_callback_registry

    return await get_callback_registry().handle_task_completed(
        task_id=task_id,
        subtask_id=subtask_id,
        status=status,
        result={"value": content} if content else None,
        error=error,
    )


async def _send_device_notification_locally(
    *,
    manager: ChannelLifecycleManager,
    user_id: int,
    target_type: str,
    device_name: str | None,
) -> dict[str, Any]:
    """Call the notification implementation with worker-local provider state."""
    from app.services.channels.device_notification import (
        _send_default_device_notification_locally,
    )

    return await _send_default_device_notification_locally(
        user_id=user_id,
        target_type=target_type,
        device_name=device_name,
        is_channel_running=manager.is_channel_running,
    )


class LocalChannelServer:
    """Serve bounded channel lifecycle RPC on a container-local Unix socket."""

    def __init__(
        self,
        socket_path: str | Path,
        manager: ChannelLifecycleManager,
        *,
        channel_loader: ChannelLoader = load_channel_nonblocking,
        event_forwarder: EventForwarder = _forward_event_locally,
        task_completion_handler: TaskCompletionHandler = (
            _handle_task_completed_locally
        ),
        device_notification_handler: DeviceNotificationHandler | None = None,
        max_connections: int = CHANNEL_WORKER_MAX_CONNECTIONS,
        first_frame_timeout_seconds: float = _FIRST_FRAME_TIMEOUT_SECONDS,
        operation_timeout_seconds: float = _OPERATION_TIMEOUT_SECONDS,
        frame_write_timeout_seconds: float = _FRAME_WRITE_TIMEOUT_SECONDS,
    ) -> None:
        if max_connections <= 0:
            raise ValueError("max_connections must be positive")
        if first_frame_timeout_seconds <= 0:
            raise ValueError("first_frame_timeout_seconds must be positive")
        if operation_timeout_seconds <= 0:
            raise ValueError("operation_timeout_seconds must be positive")
        if frame_write_timeout_seconds <= 0:
            raise ValueError("frame_write_timeout_seconds must be positive")
        self._socket_path = Path(socket_path)
        self._manager = manager
        self._channel_loader = channel_loader
        self._event_forwarder = event_forwarder
        self._task_completion_handler = task_completion_handler
        self._device_notification_handler = device_notification_handler
        self._max_connections = max_connections
        self._first_frame_timeout_seconds = first_frame_timeout_seconds
        self._operation_timeout_seconds = operation_timeout_seconds
        self._frame_write_timeout_seconds = frame_write_timeout_seconds
        self._server: asyncio.AbstractServer | None = None
        self._active: set[asyncio.Task[Any]] = set()
        self._task_locks = tuple(asyncio.Lock() for _ in range(64))

    async def run(self, stop_event: asyncio.Event) -> None:
        """Listen until shutdown, then cancel finite in-flight RPC handlers."""
        await _CHANNEL_FS_EXECUTOR.run(self._prepare_socket_path)
        try:
            self._server = await asyncio.start_unix_server(
                self._handle_connection,
                path=self._socket_path,
                backlog=self._max_connections,
            )
            await _CHANNEL_FS_EXECUTOR.run(os.chmod, self._socket_path, 0o600)
            logger.info("Channel worker listening on %s", self._socket_path)
            await stop_event.wait()
        finally:
            if self._server is not None:
                self._server.close()
                await self._server.wait_closed()
            active = tuple(self._active)
            for task in active:
                task.cancel()
            if active:
                await asyncio.gather(*active, return_exceptions=True)
            await run_bounded_to_completion(
                _CHANNEL_FS_EXECUTOR,
                self._remove_socket_path,
            )

    def _prepare_socket_path(self) -> None:
        self._socket_path.parent.mkdir(parents=True, exist_ok=True)
        if not self._socket_path.exists():
            return
        if not self._socket_path.is_socket():
            raise RuntimeError(
                f"Channel worker socket path is not a socket: {self._socket_path}"
            )
        self._socket_path.unlink()

    def _remove_socket_path(self) -> None:
        """Remove the closed worker socket in the filesystem executor."""
        self._socket_path.unlink(missing_ok=True)

    async def _handle_connection(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        connection_task = asyncio.current_task()
        if len(self._active) >= self._max_connections:
            await self._write_error(
                writer,
                "Channel worker is at capacity",
                "channel_worker_overloaded",
            )
            await _close_writer(writer)
            return
        if connection_task is not None:
            self._active.add(connection_task)

        try:
            request = await asyncio.wait_for(
                read_channel_frame(reader),
                timeout=self._first_frame_timeout_seconds,
            )
            response = await asyncio.wait_for(
                self._dispatch(request),
                timeout=self._operation_timeout_seconds,
            )
            await asyncio.wait_for(
                write_channel_frame(writer, response),
                timeout=self._frame_write_timeout_seconds,
            )
        except asyncio.CancelledError:
            raise
        except TimeoutError:
            await self._write_error(
                writer,
                "Channel worker operation timed out",
                "channel_worker_timeout",
            )
        except BoundedExecutorOverloaded:
            await self._write_error(
                writer,
                "Channel worker database executor is at capacity",
                "channel_worker_overloaded",
            )
        except ChannelWorkerError as error:
            await self._write_error(
                writer,
                str(error),
                error.error_code or "channel_worker_invalid_request",
            )
        except ValueError as error:
            await self._write_error(
                writer,
                str(error),
                "channel_worker_invalid_request",
            )
        except (asyncio.IncompleteReadError, ConnectionError, OSError):
            pass
        except Exception:
            logger.exception("Channel worker request failed")
            await self._write_error(
                writer,
                "Channel worker operation failed",
                "channel_worker_internal_error",
            )
        finally:
            await _close_writer(writer)
            if connection_task is not None:
                self._active.discard(connection_task)

    async def _dispatch(self, request: dict[str, Any]) -> dict[str, Any]:
        operation = request.get("type")
        if operation == "ping":
            _require_exact_keys(request, {"type"})
            return {"type": "pong"}

        if operation == "reconcile":
            _require_exact_keys(
                request,
                {"type", "channel_id", "force_restart"},
            )
            channel_id = _require_channel_id(request)
            force_restart = request.get("force_restart")
            if not isinstance(force_restart, bool):
                raise ValueError("force_restart must be a boolean")
            result = await self._reconcile(channel_id, force_restart=force_restart)
            return {"type": "result", "result": result}
        if operation == "stop":
            _require_exact_keys(request, {"type", "channel_id"})
            channel_id = _require_channel_id(request)
            await self._manager.stop_channel(channel_id)
            return {"type": "result", "result": None}
        if operation == "status":
            _require_exact_keys(request, {"type", "channel_id"})
            channel_id = _require_channel_id(request)
            return {
                "type": "result",
                "result": self._manager.get_status(channel_id),
            }
        if operation == "forward_event":
            _require_exact_keys(
                request,
                {"type", "task_id", "subtask_id", "event", "source"},
            )
            task_id, subtask_id = _require_task_coordinates(request)
            source = _require_source(request)
            event_payload = request.get("event")
            if not isinstance(event_payload, dict):
                raise ValueError("event must be a JSON object")
            event = await _CHANNEL_EVENT_EXECUTOR.run(
                _decode_execution_event,
                event_payload,
            )
            if event.task_id != task_id or event.subtask_id != subtask_id:
                raise ValueError("event task coordinates do not match the request")
            async with self._task_lock(task_id):
                await self._event_forwarder(
                    task_id=task_id,
                    subtask_id=subtask_id,
                    event=event,
                    source=source,
                )
            return {"type": "result", "result": None}
        if operation == "task_completed":
            _require_exact_keys(
                request,
                {
                    "type",
                    "task_id",
                    "subtask_id",
                    "status",
                    "content",
                    "error",
                },
            )
            task_id, subtask_id = _require_task_coordinates(request)
            status = request.get("status")
            if status not in {"COMPLETED", "FAILED", "CANCELLED"}:
                raise ValueError("status must be COMPLETED, FAILED, or CANCELLED")
            content = request.get("content")
            if not isinstance(content, str):
                raise ValueError("content must be a string")
            if len(content) > CHANNEL_COMPLETION_CONTENT_MAX_CHARS:
                raise ValueError(
                    "content must contain at most "
                    f"{CHANNEL_COMPLETION_CONTENT_MAX_CHARS} characters"
                )
            error = request.get("error")
            if error is not None and (
                not isinstance(error, str)
                or len(error) > CHANNEL_COMPLETION_CONTENT_MAX_CHARS
            ):
                raise ValueError(
                    "error must be null or a string of at most "
                    f"{CHANNEL_COMPLETION_CONTENT_MAX_CHARS} characters"
                )
            async with self._task_lock(task_id):
                sent = await self._task_completion_handler(
                    task_id=task_id,
                    subtask_id=subtask_id,
                    status=status,
                    content=content,
                    error=error,
                )
            if not isinstance(sent, bool):
                raise RuntimeError("Task completion handler must return a boolean")
            return {"type": "result", "result": sent}
        if operation == "runtime_local_event":
            _require_exact_keys(
                request,
                {"type", "device_id", "local_task_id", "source", "event"},
            )
            device_id = _require_runtime_identifier(request, "device_id")
            local_task_id = _require_runtime_identifier(request, "local_task_id")
            source = request.get("source")
            if source is not None and not isinstance(source, dict):
                raise ValueError("source must be a JSON object or null")
            event_payload = request.get("event")
            if not isinstance(event_payload, dict):
                raise ValueError("event must be a JSON object")
            event = await _CHANNEL_EVENT_EXECUTOR.run(
                _decode_execution_event,
                event_payload,
            )
            if (
                isinstance(event.subtask_id, bool)
                or not isinstance(event.subtask_id, int)
                or event.subtask_id <= 0
            ):
                raise ValueError("event subtask_id must be a positive integer")
            if source is None or source.get("source") != "im":
                return {"type": "result", "result": None}
            callback_key = _runtime_local_task_callback_key(
                device_id,
                local_task_id,
            )
            async with self._task_lock(callback_key):
                if _is_terminal_event(event):
                    await self._task_completion_handler(
                        task_id=callback_key,
                        subtask_id=event.subtask_id,
                        status=_terminal_status(event),
                        content=_completion_content(event.result),
                        error=_bounded_completion_error(event.error),
                    )
                else:
                    await self._event_forwarder(
                        task_id=callback_key,
                        subtask_id=event.subtask_id,
                        event=event,
                        source="Device WS local task",
                    )
            return {"type": "result", "result": None}
        if operation == "device_notification":
            _require_exact_keys(
                request,
                {"type", "user_id", "target_type", "device_name"},
            )
            user_id = request.get("user_id")
            if (
                isinstance(user_id, bool)
                or not isinstance(user_id, int)
                or user_id <= 0
            ):
                raise ValueError("user_id must be a positive integer")
            target_type = request.get("target_type")
            if target_type not in {"cloud", "device"}:
                raise ValueError("target_type must be cloud or device")
            device_name = request.get("device_name")
            if device_name is not None and (
                not isinstance(device_name, str) or len(device_name) > 256
            ):
                raise ValueError(
                    "device_name must be null or a string of at most 256 characters"
                )
            if self._device_notification_handler is None:
                result = await _send_device_notification_locally(
                    manager=self._manager,
                    user_id=user_id,
                    target_type=target_type,
                    device_name=device_name,
                )
            else:
                result = await self._device_notification_handler(
                    user_id=user_id,
                    target_type=target_type,
                    device_name=device_name,
                )
            if not isinstance(result, dict):
                raise RuntimeError(
                    "Device notification handler must return a dictionary"
                )
            return {"type": "result", "result": result}
        raise ValueError(f"Unsupported channel worker operation: {operation!r}")

    async def _reconcile(self, channel_id: int, *, force_restart: bool) -> bool:
        channel = await self._channel_loader(channel_id)
        if channel is None or not channel.is_enabled:
            await self._manager.stop_channel(channel_id)
            return False
        if force_restart:
            return await self._manager.restart_channel(channel)
        if self._manager.is_channel_running(channel_id):
            return True
        return await self._manager.start_channel(channel)

    async def _write_error(
        self,
        writer: asyncio.StreamWriter,
        message: str,
        error_code: str,
    ) -> None:
        try:
            await asyncio.wait_for(
                write_channel_frame(
                    writer,
                    {
                        "type": "error",
                        "message": message,
                        "error_code": error_code,
                    },
                ),
                timeout=self._frame_write_timeout_seconds,
            )
        except (
            BoundedExecutorOverloaded,
            ChannelWorkerError,
            ConnectionError,
            OSError,
            TimeoutError,
        ):
            pass

    def _task_lock(self, task_id: int | str) -> asyncio.Lock:
        return self._task_locks[hash(task_id) % len(self._task_locks)]


def _require_channel_id(request: dict[str, Any]) -> int:
    channel_id = request.get("channel_id")
    if (
        isinstance(channel_id, bool)
        or not isinstance(channel_id, int)
        or channel_id <= 0
    ):
        raise ValueError("channel_id must be a positive integer")
    return channel_id


def _require_exact_keys(request: dict[str, Any], expected: set[str]) -> None:
    if set(request) != expected:
        raise ValueError(
            "Invalid channel worker request fields: "
            f"expected {sorted(expected)}, got {sorted(request)}"
        )


def _require_task_coordinates(request: dict[str, Any]) -> tuple[int, int]:
    coordinates = []
    for name in ("task_id", "subtask_id"):
        value = request.get(name)
        if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
            raise ValueError(f"{name} must be a positive integer")
        coordinates.append(value)
    return coordinates[0], coordinates[1]


def _require_source(request: dict[str, Any]) -> str:
    source = request.get("source")
    if not isinstance(source, str) or not source or len(source) > 64:
        raise ValueError("source must be a non-empty string of at most 64 characters")
    return source


def _require_runtime_identifier(request: dict[str, Any], name: str) -> str:
    value = request.get(name)
    if not isinstance(value, str) or not value or len(value) > 256:
        raise ValueError(f"{name} must be a non-empty string of at most 256 characters")
    return value


def _runtime_local_task_callback_key(device_id: str, local_task_id: str) -> str:
    from app.services.channels.callback import runtime_local_task_callback_key

    return runtime_local_task_callback_key(device_id, local_task_id)


def _is_terminal_event(event: ExecutionEvent) -> bool:
    event_type = event.type.value if isinstance(event.type, EventType) else event.type
    return event_type in {
        EventType.DONE.value,
        EventType.ERROR.value,
        EventType.CANCELLED.value,
    }


def _terminal_status(event: ExecutionEvent) -> str:
    event_type = event.type.value if isinstance(event.type, EventType) else event.type
    if event_type == EventType.ERROR.value:
        return "FAILED"
    if event_type == EventType.CANCELLED.value:
        return "CANCELLED"
    return "COMPLETED"


def _completion_content(result: dict[str, Any] | None) -> str:
    if not isinstance(result, dict):
        return ""
    content = result.get("value") or result.get("output") or ""
    if not isinstance(content, str):
        return ""
    return content[:CHANNEL_COMPLETION_CONTENT_MAX_CHARS]


def _bounded_completion_error(error: str | None) -> str | None:
    if error is None:
        return None
    return error[:CHANNEL_COMPLETION_CONTENT_MAX_CHARS]


def _decode_execution_event(payload: dict[str, Any]) -> ExecutionEvent:
    if set(payload) != _EXECUTION_EVENT_FIELDS:
        raise ValueError("event contains invalid fields")
    return ExecutionEvent.from_dict(payload)


async def _close_writer(writer: asyncio.StreamWriter) -> None:
    writer.close()
    try:
        await asyncio.wait_for(writer.wait_closed(), timeout=_CLOSE_TIMEOUT_SECONDS)
    except (ConnectionError, OSError, TimeoutError):
        pass


async def run_worker() -> None:
    """Own all channel providers until SIGINT or SIGTERM."""
    setup_logging()
    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    for handled_signal in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(handled_signal, stop_event.set)

    manager = ChannelManager.get_instance()
    try:
        await _CHANNEL_EVENT_EXECUTOR.run(_register_channel_callback_services)
        started_count = await manager.start_all_enabled()
        logger.info("Channel worker started %d enabled channels", started_count)
        server = LocalChannelServer(settings.CHANNEL_WORKER_SOCKET_PATH, manager)
        await server.run(stop_event)
    finally:
        stopped_count = await manager.stop_all()
        logger.info("Channel worker stopped %d channels", stopped_count)


def main() -> None:
    """Run the isolated channel process."""
    asyncio.run(run_worker())


if __name__ == "__main__":
    main()
