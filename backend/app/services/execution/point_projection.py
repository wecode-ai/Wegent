# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Stateful execution-event projection owned by the Stream worker."""

from __future__ import annotations

import asyncio
import logging
import threading
import time
import weakref
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Annotated, Any, AsyncIterator, Iterable, Optional

import orjson
from pydantic import BaseModel, Field, TypeAdapter, ValidationError

from app.api.ws.local_task_responses import (
    LocalTaskResponsesHandler,
    emit_response_api_event,
    is_runtime_terminal_event_type,
    is_terminal_event,
    local_task_response_payload,
    local_task_terminal_status,
    runtime_subtask_id,
    runtime_terminal_event,
)
from app.api.ws.wework_runtime_namespace import (
    PROJECT_CHAT_AGENT_CHUNK_EVENT,
    PROJECT_CHAT_CREATED_EVENT,
    WEWORK_RUNTIME_EVENT,
    WEWORK_RUNTIME_NAMESPACE,
    project_chat_room,
    wework_runtime_user_room,
)
from app.core.bounded_executor import BoundedExecutor
from app.core.constants import get_wework_task_room, get_wework_user_room
from app.core.socketio import get_sio
from app.services.channels.worker_client import channel_worker_client
from app.services.chat.storage import session_manager
from app.services.chat.storage.db import run_sync_in_executor
from app.services.execution.dispatcher import ResponsesAPIEventParser
from app.services.execution.emitters.base import BaseResultEmitter
from app.services.execution.emitters.status_updating import StatusUpdatingEmitter
from app.services.execution.emitters.websocket import WebSocketResultEmitter
from app.services.execution.runtime_projection import (
    continue_projected_workflow,
    execution_runtime_event_sync,
    project_chat_runtime_event_sync,
)
from app.services.im.notification_dispatcher import im_notification_dispatcher
from shared.models import EventType, ExecutionEvent

logger = logging.getLogger(__name__)

MAX_CALLBACK_BATCH_EVENTS = 100
POINT_PROJECTION_MAX_IN_FLIGHT_EVENTS = 128
POINT_PROJECTION_MAX_SESSIONS = 256
POINT_PROJECTION_SESSION_IDLE_TTL_SECONDS = 300.0
POINT_PROJECTION_SESSION_CLOSE_TIMEOUT_SECONDS = 2.0
POINT_PROJECTION_LOCK_STRIPES = 64
_PROJECTOR_EXECUTOR = BoundedExecutor(
    max_workers=4,
    max_in_flight=16,
    max_waiters=POINT_PROJECTION_MAX_IN_FLIGHT_EVENTS,
    thread_name_prefix="wegent-point-projector",
)
_TERMINAL_TYPES = frozenset(
    {EventType.DONE.value, EventType.ERROR.value, EventType.CANCELLED.value}
)
_RUNTIME_TASK_TERMINAL_STATUSES = frozenset(
    {
        "done",
        "complete",
        "completed",
        "success",
        "succeeded",
        "failed",
        "error",
        "cancelled",
        "canceled",
    }
)
_RUNTIME_TASK_NON_REPLY_TERMINAL_STATUSES = frozenset(
    {"failed", "error", "cancelled", "canceled"}
)


class CallbackRequest(BaseModel):
    """One OpenAI Responses API callback event."""

    event_type: str = Field(..., max_length=128)
    task_id: int
    subtask_id: int
    message_id: Optional[int] = None
    executor_name: Optional[str] = Field(None, max_length=255)
    executor_namespace: Optional[str] = Field(None, max_length=255)
    data: dict[str, Any] = Field(default_factory=dict)


class CallbackResponse(BaseModel):
    """Stable public callback acknowledgement."""

    status: str = "ok"
    message: Optional[str] = None


CallbackBatch = Annotated[
    list[CallbackRequest],
    Field(min_length=1, max_length=MAX_CALLBACK_BATCH_EVENTS),
]
_CALLBACK_VALIDATOR = TypeAdapter(CallbackRequest)
_CALLBACK_BATCH_VALIDATOR = TypeAdapter(CallbackBatch)


class PointProjectionError(RuntimeError):
    """Structured rejection returned through the local RPC boundary."""

    def __init__(
        self,
        message: str,
        *,
        error_code: str,
        details: list[dict[str, Any]] | None = None,
    ) -> None:
        super().__init__(message)
        self.error_code = error_code
        self.details = details


class _EventAdmission:
    """Fail fast before accepted point events exceed the worker budget."""

    def __init__(self, max_events: int) -> None:
        self._max_events = max_events
        self._in_flight = 0
        self._lock = threading.Lock()

    @asynccontextmanager
    async def hold(self, count: int) -> AsyncIterator[None]:
        if count <= 0:
            raise ValueError("count must be positive")
        with self._lock:
            if self._in_flight + count > self._max_events:
                raise PointProjectionError(
                    "Execution projection capacity exhausted",
                    error_code="point_projection_overloaded",
                )
            self._in_flight += count
        try:
            yield
        finally:
            with self._lock:
                self._in_flight -= count


class _StripedOrderLocks:
    """Fixed-memory FIFO locks for task/subtask ordering on each event loop."""

    def __init__(self, count: int) -> None:
        self._count = count
        self._guard = threading.Lock()
        self._by_loop: weakref.WeakKeyDictionary[
            asyncio.AbstractEventLoop, tuple[asyncio.Lock, ...]
        ] = weakref.WeakKeyDictionary()

    def _locks(self) -> tuple[asyncio.Lock, ...]:
        loop = asyncio.get_running_loop()
        with self._guard:
            locks = self._by_loop.get(loop)
            if locks is None:
                locks = tuple(asyncio.Lock() for _ in range(self._count))
                self._by_loop[loop] = locks
            return locks

    @asynccontextmanager
    async def hold(self, keys: Iterable[tuple[Any, ...]]) -> AsyncIterator[None]:
        locks = self._locks()
        indexes = sorted({_stable_stripe(key, self._count) for key in keys})
        acquired: list[asyncio.Lock] = []
        try:
            for index in indexes:
                lock = locks[index]
                await lock.acquire()
                acquired.append(lock)
            yield
        finally:
            for lock in reversed(acquired):
                lock.release()


def _stable_stripe(key: tuple[Any, ...], count: int) -> int:
    encoded = "\x1f".join(str(part) for part in key).encode()
    value = 0
    for byte in encoded:
        value = ((value * 33) + byte) & 0xFFFFFFFF
    return value % count


def _normalize_runtime_task_status(status: Any) -> str:
    if not isinstance(status, str):
        return ""
    return status.strip().replace("_", "").replace("-", "").lower()


def _is_runtime_task_terminal_status(status: Any) -> bool:
    return _normalize_runtime_task_status(status) in _RUNTIME_TASK_TERMINAL_STATUSES


def _is_runtime_task_reply_status(status: Any) -> bool:
    normalized = _normalize_runtime_task_status(status)
    return (
        normalized in _RUNTIME_TASK_TERMINAL_STATUSES
        and normalized not in _RUNTIME_TASK_NON_REPLY_TERMINAL_STATUSES
    )


def _summarize_runtime_notification_results(
    notification: dict[str, Any],
) -> list[dict[str, Any]]:
    results = notification.get("results")
    if not isinstance(results, list):
        return []
    summarized: list[dict[str, Any]] = []
    for result in results:
        if not isinstance(result, dict):
            continue
        summarized.append(
            {
                "success": bool(result.get("success")),
                "channel_id": result.get("channel_id"),
                "channel_type": result.get("channel_type"),
                "session_key": result.get("session_key"),
                "error": result.get("error"),
                "error_type": result.get("error_type"),
            }
        )
    return summarized


class _TaskOwnerWebSocketEmitter(BaseResultEmitter):
    """Resolve callback task ownership in the worker only when required."""

    def __init__(
        self,
        task_id: int,
        subtask_id: int,
        user_id: int | None,
    ) -> None:
        super().__init__(task_id, subtask_id)
        self._user_id = user_id

    async def emit(self, event: ExecutionEvent) -> None:
        if self._user_id is None and event.type in _TERMINAL_TYPES:
            self._user_id = await run_sync_in_executor(
                _resolve_websocket_recipient_user_id,
                self.task_id,
            )
        await WebSocketResultEmitter(
            task_id=self.task_id,
            subtask_id=self.subtask_id,
            user_id=self._user_id,
        ).emit(event)


def _resolve_websocket_recipient_user_id(task_id: int) -> int | None:
    from app.db.session import SessionLocal
    from app.models.task import TaskResource
    from app.stores.tasks import task_store

    with SessionLocal() as db:
        task = task_store.get_task_by_states(
            db,
            task_id=task_id,
            states=[TaskResource.STATE_ACTIVE],
        )
        return task.user_id if task else None


@dataclass
class _ProjectionSession:
    key: tuple[Any, ...]
    parser: ResponsesAPIEventParser
    emitter: StatusUpdatingEmitter | None
    last_used: float
    users: int = 0


class ExecutionProjectionService:
    """Project point events with bounded persistent per-stream state."""

    def __init__(
        self,
        *,
        max_sessions: int = POINT_PROJECTION_MAX_SESSIONS,
        idle_ttl_seconds: float = POINT_PROJECTION_SESSION_IDLE_TTL_SECONDS,
        max_in_flight_events: int = POINT_PROJECTION_MAX_IN_FLIGHT_EVENTS,
    ) -> None:
        if max_sessions <= 0 or idle_ttl_seconds <= 0:
            raise ValueError("Projection session limits must be positive")
        self._max_sessions = max_sessions
        self._idle_ttl_seconds = idle_ttl_seconds
        self._sessions: dict[tuple[Any, ...], _ProjectionSession] = {}
        self._sessions_lock = asyncio.Lock()
        self._order = _StripedOrderLocks(POINT_PROJECTION_LOCK_STRIPES)
        self._admission = _EventAdmission(max_in_flight_events)

    async def project_callback_body(
        self,
        body: bytes,
        *,
        batch: bool,
    ) -> dict[str, Any]:
        """Validate raw HTTP JSON and project it entirely inside the worker."""
        try:
            parsed = await _PROJECTOR_EXECUTOR.run(
                (
                    _CALLBACK_BATCH_VALIDATOR.validate_json
                    if batch
                    else _CALLBACK_VALIDATOR.validate_json
                ),
                body,
            )
        except ValidationError as error:
            raise PointProjectionError(
                "Invalid callback payload",
                error_code="point_projection_validation",
                details=error.errors(include_url=False),
            ) from error

        events = parsed if isinstance(parsed, list) else [parsed]
        async with self._admission.hold(len(events)):
            keys = [(event.task_id, event.subtask_id) for event in events]
            async with self._order.hold(keys):
                return await self._project_callback_events(events, batch=batch)

    async def project_device_event(
        self,
        *,
        user_id: int,
        device_id: str,
        event_type: str,
        data: dict[str, Any],
    ) -> dict[str, Any]:
        """Project one authenticated local-executor event."""
        if not event_type or len(event_type) > 128 or not isinstance(data, dict):
            return {"error": "Invalid event data format"}

        local_task_id = data.get("local_task_id")
        if isinstance(local_task_id, str) and local_task_id.strip():
            subtask_id = runtime_subtask_id(data, device_id, local_task_id.strip())
            key = ("local", device_id, local_task_id.strip(), subtask_id)
        else:
            task_id = data.get("task_id")
            subtask_id = data.get("subtask_id")
            if not isinstance(task_id, int) or not isinstance(subtask_id, int):
                return {"error": "Missing task_id or subtask_id"}
            key = (task_id, subtask_id)

        async with self._admission.hold(1):
            async with self._order.hold([key]):
                await self._project_runtime_execution(device_id, event_type, data)
                if key[0] == "local":
                    return await self._project_local_device_event(
                        user_id=user_id,
                        device_id=device_id,
                        local_task_id=str(local_task_id).strip(),
                        subtask_id=subtask_id,
                        event_type=event_type,
                        data=data,
                    )
                await emit_response_api_event(
                    event_name=event_type,
                    payload={**data, "device_id": device_id},
                    room=get_wework_task_room(task_id),
                )
                return await self._project_task_event(
                    request=CallbackRequest(
                        event_type=event_type,
                        task_id=task_id,
                        subtask_id=subtask_id,
                        message_id=data.get("message_id"),
                        data=(
                            data.get("data")
                            if isinstance(data.get("data"), dict)
                            else {}
                        ),
                    ),
                    user_id=user_id,
                    source="Device WS",
                    publish_callback=False,
                )

    async def project_execution_event(
        self,
        *,
        event: ExecutionEvent,
        user_id: int | None,
        source: str,
        publish_callback: bool,
        executor_name: str | None,
        executor_namespace: str | None,
    ) -> dict[str, Any]:
        """Project an internal event without rebuilding state in Web."""
        key = (event.task_id, event.subtask_id)
        async with self._admission.hold(1):
            async with self._order.hold([key]):
                session = await self._checkout_session(
                    key,
                    user_id=user_id,
                    executor_name=executor_name,
                    executor_namespace=executor_namespace,
                )
                terminal = event.type in _TERMINAL_TYPES
                try:
                    await self._emit_task_event(
                        session=session,
                        event=event,
                        source=source,
                        publish_callback=publish_callback,
                    )
                    return {"success": True}
                finally:
                    await self._release_session(session, terminal=terminal)

    async def project_runtime_event(
        self,
        *,
        user_id: int,
        device_id: str,
        logical_device_id: str,
        data: dict[str, Any],
    ) -> dict[str, Any]:
        """Persist and relay one ordered native-runtime envelope."""
        keys: list[tuple[Any, ...]] = [("runtime", device_id)]
        original_payload = data.get("payload")
        if isinstance(original_payload, dict):
            local_task_id = str(original_payload.get("taskId") or "").strip()
            if local_task_id:
                local_payload = {
                    **original_payload,
                    "deviceId": logical_device_id,
                    "device_id": logical_device_id,
                }
                keys.append(
                    (
                        "local",
                        logical_device_id,
                        local_task_id,
                        runtime_subtask_id(
                            local_payload,
                            logical_device_id,
                            local_task_id,
                        ),
                    )
                )
        async with self._admission.hold(1):
            async with self._order.hold(keys):
                payload = dict(data)
                nested = payload.get("payload")
                if isinstance(nested, dict):
                    nested = dict(nested)
                    nested["deviceId"] = logical_device_id
                    nested["device_id"] = logical_device_id
                else:
                    nested = {
                        "deviceId": logical_device_id,
                        "device_id": logical_device_id,
                    }
                payload["payload"] = nested

                projected = await run_sync_in_executor(
                    project_chat_runtime_event_sync,
                    device_id,
                    payload,
                    user_id,
                )
                await continue_projected_workflow(
                    projected.get("workflow_continuation") if projected else None
                )
                await self._emit_runtime_relay(user_id, payload, projected)
                await self._project_runtime_local_side_effects(
                    user_id=user_id,
                    device_id=logical_device_id,
                    payload=nested,
                )
                return {"success": True}

    async def project_runtime_task_updated(
        self,
        *,
        user_id: int,
        device_id: str,
        data: dict[str, Any],
    ) -> dict[str, Any]:
        """Project one ordered terminal update from a native runtime watcher."""
        local_task_id = str(
            data.get("localTaskId") or data.get("local_task_id") or ""
        ).strip()
        workspace_path = str(
            data.get("workspacePath") or data.get("workspace_path") or ""
        ).strip()
        if not device_id or not local_task_id:
            return {"error": "Invalid runtime task update payload"}

        key = ("runtime-task-updated", device_id, local_task_id)
        async with self._admission.hold(1):
            async with self._order.hold([key]):
                return await self._project_runtime_task_updated_locked(
                    user_id=user_id,
                    device_id=device_id,
                    local_task_id=local_task_id,
                    workspace_path=workspace_path,
                    data=data,
                )

    @staticmethod
    async def _project_runtime_task_updated_locked(
        *,
        user_id: int,
        device_id: str,
        local_task_id: str,
        workspace_path: str,
        data: dict[str, Any],
    ) -> dict[str, Any]:
        status = str(data.get("status") or "updated")
        if not _is_runtime_task_terminal_status(status):
            logger.info(
                "[RuntimeTaskNotification] Skipped non-terminal update: "
                "user_id=%s device_id=%s local_task_id=%s status=%s",
                user_id,
                device_id,
                local_task_id,
                status,
            )
            return {"success": True, "notified": 0, "skipped": "non_terminal"}

        content = str(data.get("content") or "")
        normalized_status = _normalize_runtime_task_status(status)
        event_name = (
            "runtime.task.failed"
            if normalized_status in _RUNTIME_TASK_NON_REPLY_TERMINAL_STATUSES
            else "runtime.task.completed"
        )
        logger.info(
            "[ProjectChat] Runtime task terminal update received: "
            "device_id=%s local_task_id=%s status=%s projected_event=%s "
            "content_length=%s",
            device_id,
            local_task_id,
            status,
            event_name,
            len(content),
        )

        projected = await run_sync_in_executor(
            project_chat_runtime_event_sync,
            device_id,
            {
                "event": event_name,
                "payload": {
                    "taskId": local_task_id,
                    "localTaskId": local_task_id,
                    "deviceId": device_id,
                    "device_id": device_id,
                    "status": status,
                    "data": {"status": status, "value": content},
                },
            },
            user_id,
            True,
        )
        await continue_projected_workflow(
            projected.get("workflow_continuation") if projected else None
        )
        if projected and projected.get("message"):
            message = projected["message"]
            project_id = str(message["projectId"])
            project_task_id = message.get("taskId")
            await get_sio().emit(
                PROJECT_CHAT_CREATED_EVENT,
                message,
                room=project_chat_room(
                    project_id,
                    str(project_task_id) if project_task_id else None,
                ),
                namespace=WEWORK_RUNTIME_NAMESPACE,
            )

        if _is_runtime_task_reply_status(status) and not content.strip():
            return {"success": True, "notified": 0, "skipped": "empty_content"}

        address = {"deviceId": device_id, "localTaskId": local_task_id}
        if workspace_path:
            address["workspacePath"] = workspace_path
        notification = (
            await im_notification_dispatcher.send_runtime_task_update_for_user(
                user_id=user_id,
                address=address,
                title=str(data.get("title") or local_task_id),
                status=status,
                content=content,
                source="codex_watcher",
            )
        )
        notified = int(notification.get("sent") or 0)
        if notified <= 0:
            logger.warning(
                "[RuntimeTaskNotification] Runtime task update notification "
                "was not delivered: user_id=%s device_id=%s local_task_id=%s "
                "status=%s results=%s",
                user_id,
                device_id,
                local_task_id,
                status,
                _summarize_runtime_notification_results(notification),
            )
        return {"success": True, "notified": notified}

    @staticmethod
    async def _emit_runtime_relay(
        user_id: int,
        payload: dict[str, Any],
        projected: dict[str, Any] | None,
    ) -> None:
        if projected and projected.get("message"):
            message = projected["message"]
            project_id = str(message["projectId"])
            task_id = message.get("taskId")
            event_name = (
                PROJECT_CHAT_AGENT_CHUNK_EVENT
                if projected["mode"] == "delta"
                else PROJECT_CHAT_CREATED_EVENT
            )
            await get_sio().emit(
                event_name,
                message,
                room=project_chat_room(
                    project_id,
                    str(task_id) if task_id else None,
                ),
                namespace=WEWORK_RUNTIME_NAMESPACE,
            )
        await get_sio().emit(
            WEWORK_RUNTIME_EVENT,
            payload,
            room=wework_runtime_user_room(user_id),
            namespace=WEWORK_RUNTIME_NAMESPACE,
        )

    async def _project_runtime_local_side_effects(
        self,
        *,
        user_id: int,
        device_id: str,
        payload: dict[str, Any],
    ) -> None:
        local_task_id = str(payload.get("taskId") or "").strip()
        event_type = str(payload.get("event_type") or "").strip()
        if not local_task_id or not event_type:
            return
        subtask_id = runtime_subtask_id(payload, device_id, local_task_id)
        key = ("local", device_id, local_task_id, subtask_id)
        session = await self._checkout_session(key, local=True)
        terminal = is_runtime_terminal_event_type(event_type)
        try:
            handler = LocalTaskResponsesHandler(session.parser)
            source = payload.get("source")
            source_name = source.get("source") if isinstance(source, dict) else None
            if source_name == "im":
                await handler.forward_runtime_event_to_channels(
                    device_id=device_id,
                    payload=payload,
                )
                return
            await self._notify_runtime_event(
                handler=handler,
                user_id=user_id,
                device_id=device_id,
                local_task_id=local_task_id,
                event_type=event_type,
                payload=payload,
                source_name=source_name,
            )
        finally:
            await self._release_session(session, terminal=terminal)

    @staticmethod
    async def _notify_runtime_event(
        *,
        handler: LocalTaskResponsesHandler,
        user_id: int,
        device_id: str,
        local_task_id: str,
        event_type: str,
        payload: dict[str, Any],
        source_name: Any,
    ) -> None:
        if not is_runtime_terminal_event_type(event_type):
            return
        event_data = payload.get("data")
        event_data = event_data if isinstance(event_data, dict) else {}
        subtask_id = runtime_subtask_id(payload, device_id, local_task_id)
        event = runtime_terminal_event(
            event_type=event_type,
            event_data=event_data,
            subtask_id=subtask_id,
        )
        if event is None:
            event = await handler.execution_event(
                event_type=event_type,
                event_data=event_data,
                subtask_id=subtask_id,
                message_id=None,
            )
        if event is None or not is_terminal_event(event):
            return
        status = local_task_terminal_status(event)
        result = event.result if isinstance(event.result, dict) else {}
        content = str(result.get("value") or event.error or "")
        if status == "COMPLETED" and not content.strip():
            return
        title = str(
            payload.get("taskTitle")
            or payload.get("task_title")
            or event_data.get("title")
            or local_task_id
        ).strip()
        await im_notification_dispatcher.send_runtime_task_update_for_user(
            user_id=user_id,
            address={"deviceId": device_id, "localTaskId": local_task_id},
            title=title or local_task_id,
            status=status,
            content=content,
            source=str(source_name) if source_name else None,
        )

    async def _project_callback_events(
        self,
        events: list[CallbackRequest],
        *,
        batch: bool,
    ) -> dict[str, Any]:
        processed = 0
        skipped = 0
        errors: list[str] = []
        for request in events:
            try:
                result = await self._project_task_event(
                    request=request,
                    user_id=None,
                    source="Callback",
                    publish_callback=True,
                )
                if result.get("skipped"):
                    skipped += 1
                else:
                    processed += 1
            except Exception as error:
                if not batch:
                    raise
                errors.append(
                    f"Error processing event for subtask {request.subtask_id}: {error}"
                )

        if not batch:
            return {
                "status": "ok",
                "message": "Lifecycle event skipped" if skipped else None,
            }
        if errors:
            return {
                "status": "partial",
                "message": (
                    f"Processed {processed}/{len(events)} events. Errors: "
                    + "; ".join(errors[:5])
                ),
            }
        return {
            "status": "ok",
            "message": f"Processed {processed} events, {skipped} skipped",
        }

    async def _project_task_event(
        self,
        *,
        request: CallbackRequest,
        user_id: int | None,
        source: str,
        publish_callback: bool,
    ) -> dict[str, Any]:
        key = (request.task_id, request.subtask_id)
        session = await self._checkout_session(
            key,
            user_id=user_id,
            executor_name=request.executor_name,
            executor_namespace=request.executor_namespace,
        )
        terminal = False
        try:
            event = await _PROJECTOR_EXECUTOR.run(
                session.parser.parse,
                request.task_id,
                request.subtask_id,
                request.message_id,
                request.event_type,
                request.data,
            )
            if event is None:
                return {"skipped": True}
            terminal = event.type in _TERMINAL_TYPES
            await self._emit_task_event(
                session=session,
                event=event,
                source=source,
                publish_callback=publish_callback,
            )
            return {"skipped": False}
        finally:
            await self._release_session(session, terminal=terminal)

    @staticmethod
    async def _emit_task_event(
        *,
        session: _ProjectionSession,
        event: ExecutionEvent,
        source: str,
        publish_callback: bool,
    ) -> None:
        if session.emitter is None:
            raise RuntimeError("Task projection session has no status emitter")
        await session.emitter.emit(event)
        if publish_callback:
            await session_manager.publish_callback_event(event.subtask_id, event)
        await channel_worker_client.forward_event(
            task_id=event.task_id,
            subtask_id=event.subtask_id,
            event=event,
            source=source,
        )

    async def _project_local_device_event(
        self,
        *,
        user_id: int,
        device_id: str,
        local_task_id: str,
        subtask_id: int,
        event_type: str,
        data: dict[str, Any],
    ) -> dict[str, Any]:
        key = ("local", device_id, local_task_id, subtask_id)
        session = await self._checkout_session(key, local=True)
        terminal = False
        try:
            handler = LocalTaskResponsesHandler(session.parser)
            message_id = data.get("message_id")
            event_data = data.get("data")
            event_data = event_data if isinstance(event_data, dict) else {}
            await emit_response_api_event(
                event_name=event_type,
                payload=local_task_response_payload(
                    data=data,
                    device_id=device_id,
                    local_task_id=local_task_id,
                    subtask_id=subtask_id,
                    message_id=message_id,
                ),
                room=get_wework_user_room(user_id),
            )
            event = await handler.execution_event(
                event_type=event_type,
                event_data=event_data,
                subtask_id=subtask_id,
                message_id=message_id,
            )
            if event is None:
                return {"success": True}
            terminal = is_terminal_event(event)
            await handler.emit_execution_event(
                user_id=user_id,
                device_id=device_id,
                local_task_id=local_task_id,
                runtime=data.get("runtime"),
                event=event,
            )
            source = data.get("source")
            await channel_worker_client.runtime_local_event(
                device_id=device_id,
                local_task_id=local_task_id,
                source=source if isinstance(source, dict) else None,
                event=event,
            )
            return {"success": True}
        except Exception as error:
            logger.exception(
                "Local task point projection failed: device=%s task=%s",
                device_id,
                local_task_id,
            )
            return {"error": str(error)}
        finally:
            await self._release_session(session, terminal=terminal)

    async def _project_runtime_execution(
        self,
        device_id: str,
        event_type: str,
        data: dict[str, Any],
    ) -> None:
        runtime_task_id = data.get("task_id")
        if not runtime_task_id:
            return
        # Imported only in the non-Web worker process. These existing projection
        # functions remain the authoritative robot-queue transition logic.
        intent = await run_sync_in_executor(
            execution_runtime_event_sync,
            device_id,
            runtime_task_id,
            event_type,
            data,
        )
        await continue_projected_workflow(intent)

    async def _checkout_session(
        self,
        key: tuple[Any, ...],
        *,
        user_id: int | None = None,
        executor_name: str | None = None,
        executor_namespace: str | None = None,
        local: bool = False,
    ) -> _ProjectionSession:
        expired: list[_ProjectionSession] = []
        now = time.monotonic()
        async with self._sessions_lock:
            for candidate_key, candidate in tuple(self._sessions.items()):
                if (
                    candidate.users == 0
                    and now - candidate.last_used >= self._idle_ttl_seconds
                ):
                    self._sessions.pop(candidate_key)
                    expired.append(candidate)

            session = self._sessions.get(key)
            if session is None:
                if len(self._sessions) >= self._max_sessions:
                    raise PointProjectionError(
                        "Execution projection session capacity exhausted",
                        error_code="point_projection_session_overloaded",
                    )
                emitter = None
                if not local:
                    task_id, subtask_id = int(key[0]), int(key[1])
                    emitter = StatusUpdatingEmitter(
                        wrapped=_TaskOwnerWebSocketEmitter(
                            task_id,
                            subtask_id,
                            user_id,
                        ),
                        task_id=task_id,
                        subtask_id=subtask_id,
                        executor_name=executor_name,
                        executor_namespace=executor_namespace,
                        publish_completion_events=True,
                    )
                session = _ProjectionSession(
                    key=key,
                    parser=ResponsesAPIEventParser(),
                    emitter=emitter,
                    last_used=now,
                )
                self._sessions[key] = session
            session.users += 1
            session.last_used = now

        for stale in expired:
            await self._close_session(stale)
        return session

    async def _release_session(
        self,
        session: _ProjectionSession,
        *,
        terminal: bool,
    ) -> None:
        close = False
        async with self._sessions_lock:
            session.users -= 1
            session.last_used = time.monotonic()
            if terminal and self._sessions.get(session.key) is session:
                self._sessions.pop(session.key)
                close = True
        if close:
            await self._close_session(session)

    async def _close_session(self, session: _ProjectionSession) -> None:
        if session.emitter is not None:
            try:
                await asyncio.wait_for(
                    session.emitter.close(),
                    timeout=POINT_PROJECTION_SESSION_CLOSE_TIMEOUT_SECONDS,
                )
            except Exception:
                logger.exception(
                    "Failed to close execution projection session %s", session.key
                )
        if len(session.key) >= 2 and isinstance(session.key[0], int):
            session.parser.clear_request(int(session.key[0]), int(session.key[1]))

    async def close(self) -> None:
        """Close all live state during worker shutdown with a finite bound."""
        async with self._sessions_lock:
            sessions = list(self._sessions.values())
            self._sessions.clear()
        await asyncio.gather(
            *(self._close_session(session) for session in sessions),
            return_exceptions=True,
        )


execution_projection_service = ExecutionProjectionService()
