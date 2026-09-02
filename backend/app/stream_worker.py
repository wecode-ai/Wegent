# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Process entry point for Pod-local upstream SSE execution."""

from __future__ import annotations

import asyncio
import logging
import os
import signal
from collections.abc import AsyncIterator, Awaitable, Callable
from pathlib import Path
from typing import Any, Protocol

import orjson

from app.core.config import settings
from app.core.logging import setup_logging
from app.core.payload_codec import run_payload_codec
from app.services.execution.dispatcher import execution_dispatcher
from app.services.execution.emitters.base import BaseResultEmitter
from app.services.execution.emitters.protocol import ResultEmitter
from app.services.execution.emitters.status_updating import StatusUpdatingEmitter
from app.services.execution.emitters.websocket import WebSocketResultEmitter
from app.services.execution.router import CommunicationMode
from app.services.execution.stream_client import (
    POINT_EVENT_MAX_BODY_BYTES,
    STREAM_WORKER_MAX_CONNECTIONS,
    StreamWorkerExecutionError,
    discard_frame,
    read_frame,
    read_raw_frame,
    write_frame,
    write_raw_frame,
)
from app.services.execution.web_stream_protocol import (
    WEB_EXECUTE_MAX_RESULT_BYTES,
    WEB_RAW_STREAM_OPERATIONS,
    WEB_STREAM_FRAME_COMPLETE,
    WEB_STREAM_FRAME_DATA,
    WEB_STREAM_FRAME_ERROR,
    WEB_STREAM_FRAME_HEARTBEAT,
    WEB_STREAM_FRAME_METADATA,
    WEB_STREAM_MAX_FRAME_BYTES,
)
from app.services.openapi.worker_protocol import (
    OPENAPI_STREAM_FRAME_COMPLETE,
    OPENAPI_STREAM_FRAME_ERROR,
    OPENAPI_STREAM_FRAME_HEARTBEAT,
    OPENAPI_STREAM_FRAME_SSE,
    OPENAPI_STREAM_MAX_FRAME_BYTES,
    OpenAPIExecutionOutcome,
    OpenAPIStreamSpec,
)
from shared.models import EventType, ExecutionEvent, ExecutionRequest
from shared.utils.error_classifier import classify_error, format_error_message

logger = logging.getLogger(__name__)

_FIRST_FRAME_TIMEOUT_SECONDS = 5.0
_HEARTBEAT_INTERVAL_SECONDS = 5.0
_FRAME_WRITE_TIMEOUT_SECONDS = 20.0
_CLOSE_TIMEOUT_SECONDS = 1.0
_POINT_EVENT_PROCESSING_TIMEOUT_SECONDS = 130.0
_TERMINAL_EVENT_TYPES = frozenset(
    {
        EventType.DONE.value,
        EventType.ERROR.value,
        EventType.CANCELLED.value,
    }
)


def _decode_openapi_stream_request(
    raw_request: dict[str, Any],
    raw_response: dict[str, Any],
) -> tuple[ExecutionRequest, OpenAPIStreamSpec]:
    return (
        ExecutionRequest.from_dict(raw_request),
        OpenAPIStreamSpec.from_dict(raw_response),
    )


class UpstreamSSEDispatcher(Protocol):
    """Minimal dispatcher boundary owned by the stream process."""

    async def dispatch_sse_upstream(
        self,
        request: ExecutionRequest,
        emitter: ResultEmitter,
    ) -> None:
        """Execute one upstream streaming request."""
        ...

    def execution_mode(self, request: ExecutionRequest) -> CommunicationMode: ...

    async def dispatch_worker_owned(
        self,
        request: ExecutionRequest,
        emitter: ResultEmitter,
    ) -> None: ...


class PointEventProjector(Protocol):
    """Worker-owned stateful projection boundary for point events."""

    async def project_callback_body(
        self,
        body: bytes,
        *,
        batch: bool,
    ) -> dict[str, Any]: ...

    async def project_device_event(
        self,
        *,
        user_id: int,
        device_id: str,
        event_type: str,
        data: dict[str, Any],
    ) -> dict[str, Any]: ...

    async def project_execution_event(
        self,
        *,
        event: ExecutionEvent,
        user_id: int | None,
        source: str,
        publish_callback: bool,
        executor_name: str | None,
        executor_namespace: str | None,
    ) -> dict[str, Any]: ...

    async def project_runtime_event(
        self,
        *,
        user_id: int,
        device_id: str,
        logical_device_id: str,
        data: dict[str, Any],
    ) -> dict[str, Any]: ...

    async def project_runtime_task_updated(
        self,
        *,
        user_id: int,
        device_id: str,
        data: dict[str, Any],
    ) -> dict[str, Any]: ...

    async def close(self) -> None: ...


class OpenAPIExecutionProjector(Protocol):
    """Worker-owned OpenAPI projection and non-stream execution boundary."""

    def immediate_status(
        self,
        request: ExecutionRequest,
        *,
        background: bool,
    ) -> str | None: ...

    async def stream_sse(
        self,
        request: ExecutionRequest,
        spec: OpenAPIStreamSpec,
    ) -> AsyncIterator[bytes]: ...

    async def collect(self, request: ExecutionRequest) -> OpenAPIExecutionOutcome: ...

    async def run_background(self, request: ExecutionRequest) -> None: ...


class WebStreamProjector(Protocol):
    """Worker-owned boundary for non-Execution Web operations."""

    async def execute(
        self,
        operation: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]: ...

    async def stream(
        self,
        operation: str,
        payload: dict[str, Any],
    ) -> AsyncIterator[bytes]: ...

    async def open_raw_stream(
        self,
        operation: str,
        payload: dict[str, Any],
    ) -> tuple[dict[str, Any], AsyncIterator[bytes]]: ...


class LocalIPCFrameWriter:
    """Serialize control and event frames on one connection."""

    def __init__(
        self,
        writer: asyncio.StreamWriter,
        write_timeout_seconds: float,
    ) -> None:
        self._writer = writer
        self._write_timeout_seconds = write_timeout_seconds
        self._lock = asyncio.Lock()

    async def write(self, payload: dict[str, Any]) -> None:
        async with self._lock:
            await asyncio.wait_for(
                write_frame(self._writer, payload),
                timeout=self._write_timeout_seconds,
            )


class LocalIPCRawFrameWriter:
    """Write bounded marker-prefixed binary frames without JSON projection."""

    def __init__(
        self,
        writer: asyncio.StreamWriter,
        write_timeout_seconds: float,
        max_frame_bytes: int,
    ) -> None:
        self._writer = writer
        self._write_timeout_seconds = write_timeout_seconds
        self._max_frame_bytes = max_frame_bytes
        self._lock = asyncio.Lock()

    async def write(self, marker: bytes, payload: bytes = b"") -> None:
        if marker not in {
            OPENAPI_STREAM_FRAME_SSE,
            OPENAPI_STREAM_FRAME_HEARTBEAT,
            OPENAPI_STREAM_FRAME_COMPLETE,
            OPENAPI_STREAM_FRAME_ERROR,
            WEB_STREAM_FRAME_DATA,
            WEB_STREAM_FRAME_HEARTBEAT,
            WEB_STREAM_FRAME_COMPLETE,
            WEB_STREAM_FRAME_ERROR,
            WEB_STREAM_FRAME_METADATA,
        }:
            raise ValueError("Unknown local raw stream frame marker")
        frame = marker + payload
        async with self._lock:
            await asyncio.wait_for(
                write_raw_frame(
                    self._writer,
                    frame,
                    max_bytes=self._max_frame_bytes,
                ),
                timeout=self._write_timeout_seconds,
            )


class LocalIPCResultEmitter(BaseResultEmitter):
    """Return raw execution events to the Web process over one socket.

    The terminal event is held until upstream dispatch and cleanup have both
    returned. Dispatch completion is transport state; a business terminal
    event is optional because callback-based execution completes asynchronously.
    """

    def __init__(
        self,
        task_id: int,
        subtask_id: int,
        frame_writer: LocalIPCFrameWriter,
    ) -> None:
        super().__init__(task_id, subtask_id)
        self._frame_writer = frame_writer
        self._terminal_event: ExecutionEvent | None = None

    @property
    def terminal_event(self) -> ExecutionEvent | None:
        """Return the single terminal event after upstream completion."""
        return self._terminal_event

    async def emit(self, event: ExecutionEvent) -> None:
        if self._terminal_event is not None:
            raise RuntimeError("Local stream dispatcher emitted after termination")
        if event.type in _TERMINAL_EVENT_TYPES:
            self._terminal_event = event
            return
        await self._frame_writer.write(
            {
                "type": "event",
                "event": event.to_dict(),
            },
        )


class _TerminalTrackingEmitter(BaseResultEmitter):
    """Track the terminal event forwarded by a status-owning dispatcher."""

    def __init__(self, wrapped: ResultEmitter, task_id: int, subtask_id: int) -> None:
        super().__init__(task_id, subtask_id)
        self._wrapped = wrapped
        self.terminal_event: ExecutionEvent | None = None

    async def emit(self, event: ExecutionEvent) -> None:
        if event.type in _TERMINAL_EVENT_TYPES:
            self.terminal_event = event
        await self._wrapped.emit(event)

    async def close(self) -> None:
        await self._wrapped.close()


class _WorkerProjectionEmitter(BaseResultEmitter):
    """Tee worker-owned projection to Socket.IO and the optional Web relay."""

    def __init__(
        self,
        relay: ResultEmitter,
        websocket: ResultEmitter,
        task_id: int,
        subtask_id: int,
    ) -> None:
        super().__init__(task_id, subtask_id)
        self._relay = relay
        self._websocket = websocket
        self._relay_connected = True

    async def emit(self, event: ExecutionEvent) -> None:
        await self._websocket.emit(event)
        if not self._relay_connected:
            return
        try:
            await self._relay.emit(event)
        except (ConnectionError, OSError, TimeoutError):
            self._relay_connected = False
            logger.info("Local Web relay disconnected; worker execution remains active")

    async def close(self) -> None:
        await self._websocket.close()
        if self._relay_connected:
            try:
                await self._relay.close()
            except (ConnectionError, OSError, TimeoutError):
                self._relay_connected = False


class StatusOwningSSEDispatcher:
    """Run SSE status, Redis and completion side effects in the Stream process."""

    def __init__(self, wrapped: UpstreamSSEDispatcher) -> None:
        self._wrapped = wrapped

    def execution_mode(self, request: ExecutionRequest) -> CommunicationMode:
        return self._wrapped.execution_mode(request)

    async def dispatch_worker_owned(
        self,
        request: ExecutionRequest,
        emitter: ResultEmitter,
        *,
        project_to_web: bool = True,
    ) -> None:
        await self._dispatch_with_status(
            request,
            emitter,
            self._wrapped.dispatch_worker_owned,
            project_to_web=project_to_web,
        )

    async def dispatch_sse_upstream(
        self,
        request: ExecutionRequest,
        emitter: ResultEmitter,
    ) -> None:
        await self._dispatch_with_status(
            request,
            emitter,
            self._wrapped.dispatch_sse_upstream,
            project_to_web=True,
        )

    async def _dispatch_with_status(
        self,
        request: ExecutionRequest,
        emitter: ResultEmitter,
        dispatch: Callable[[ExecutionRequest, ResultEmitter], Awaitable[None]],
        *,
        project_to_web: bool,
    ) -> None:
        tracking_emitter = _TerminalTrackingEmitter(
            emitter,
            request.task_id,
            request.subtask_id,
        )
        user_id = request.user.get("id") if request.user else request.user_id
        user_id = user_id if isinstance(user_id, int) else None
        team = request.bot[0] if request.bot else {}
        projection_emitter: ResultEmitter = tracking_emitter
        if project_to_web:
            projection_emitter = _WorkerProjectionEmitter(
                tracking_emitter,
                WebSocketResultEmitter(
                    task_id=request.task_id,
                    subtask_id=request.subtask_id,
                    user_id=user_id,
                    team_id=team.get("team_id"),
                    team_name=team.get("team_name"),
                    task_title=request.task_title,
                    is_group_chat=bool(team.get("is_group_chat", False)),
                ),
                request.task_id,
                request.subtask_id,
            )
        status_emitter = StatusUpdatingEmitter(
            wrapped=projection_emitter,
            task_id=request.task_id,
            subtask_id=request.subtask_id,
            publish_completion_events=True,
        )
        try:
            await dispatch(request, status_emitter)
        except asyncio.CancelledError:
            if tracking_emitter.terminal_event is None:
                # A vanished Web relay is an execution cancellation, not merely
                # a transport detail. Persist it in the status-owning process
                # before allowing the upstream task to unwind.
                await status_emitter.emit_cancelled(
                    task_id=request.task_id,
                    subtask_id=request.subtask_id,
                )
            raise
        except Exception as error:
            if tracking_emitter.terminal_event is None:
                error_code = getattr(error, "error_code", None) or classify_error(error)
                await status_emitter.emit_error(
                    task_id=request.task_id,
                    subtask_id=request.subtask_id,
                    error=format_error_message(error),
                    error_code=error_code,
                )
            else:
                logger.exception(
                    "SSE upstream failed after its terminal event; preserving the "
                    "already-finalized result"
                )
        finally:
            try:
                await status_emitter.close()
            except Exception:
                if tracking_emitter.terminal_event is None:
                    raise
                logger.exception(
                    "Failed to close SSE status emitter after terminal completion"
                )


class LocalStreamServer:
    """Serve concurrent SSE executions on a container-local Unix socket."""

    def __init__(
        self,
        socket_path: str | Path,
        dispatcher: UpstreamSSEDispatcher,
        *,
        max_connections: int = STREAM_WORKER_MAX_CONNECTIONS,
        first_frame_timeout_seconds: float = _FIRST_FRAME_TIMEOUT_SECONDS,
        heartbeat_interval_seconds: float = _HEARTBEAT_INTERVAL_SECONDS,
        frame_write_timeout_seconds: float = _FRAME_WRITE_TIMEOUT_SECONDS,
        point_projector: PointEventProjector | None = None,
        openapi_projector: OpenAPIExecutionProjector | None = None,
        web_stream_projector: WebStreamProjector | None = None,
    ) -> None:
        if max_connections <= 0:
            raise ValueError("max_connections must be positive")
        if first_frame_timeout_seconds <= 0:
            raise ValueError("first_frame_timeout_seconds must be positive")
        if heartbeat_interval_seconds <= 0:
            raise ValueError("heartbeat_interval_seconds must be positive")
        if frame_write_timeout_seconds <= 0:
            raise ValueError("frame_write_timeout_seconds must be positive")
        self._socket_path = Path(socket_path)
        self._dispatcher = dispatcher
        self._max_connections = max_connections
        self._first_frame_timeout_seconds = first_frame_timeout_seconds
        self._heartbeat_interval_seconds = heartbeat_interval_seconds
        self._frame_write_timeout_seconds = frame_write_timeout_seconds
        self._point_projector = point_projector
        self._openapi_projector = openapi_projector
        self._web_stream_projector = web_stream_projector
        self._server: asyncio.AbstractServer | None = None
        self._active: set[asyncio.Task[Any]] = set()
        self._background: set[asyncio.Task[Any]] = set()

    async def run(self, stop_event: asyncio.Event) -> None:
        """Listen until shutdown, then drain active streams."""
        self._prepare_socket_path()
        self._server = await asyncio.start_unix_server(
            self._handle_connection,
            path=self._socket_path,
            backlog=self._max_connections,
        )
        os.chmod(self._socket_path, 0o600)
        logger.info("Local stream worker listening on %s", self._socket_path)
        try:
            await stop_event.wait()
        finally:
            self._server.close()
            await self._server.wait_closed()
            if self._active:
                await asyncio.gather(*tuple(self._active), return_exceptions=True)
            background_tasks = tuple(self._background)
            for background_task in background_tasks:
                background_task.cancel()
            if background_tasks:
                await asyncio.gather(*background_tasks, return_exceptions=True)
            self._socket_path.unlink(missing_ok=True)

    def _prepare_socket_path(self) -> None:
        self._socket_path.parent.mkdir(parents=True, exist_ok=True)
        if self._socket_path.exists():
            if not self._socket_path.is_socket():
                raise RuntimeError(
                    f"Local stream socket path is not a socket: {self._socket_path}"
                )
            self._socket_path.unlink()

    async def _handle_connection(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        connection_task = asyncio.current_task()
        frame_writer = LocalIPCFrameWriter(
            writer,
            self._frame_write_timeout_seconds,
        )
        if len(self._active) >= self._max_connections:
            try:
                await frame_writer.write(
                    {
                        "type": "error",
                        "message": "Local stream worker is at capacity",
                        "error_code": "stream_worker_overloaded",
                    }
                )
                # Drain the single request frame before closing. Closing a Unix
                # socket with unread peer data can reset the connection and
                # discard the structured overload response already written.
                await asyncio.wait_for(
                    discard_frame(reader),
                    timeout=self._first_frame_timeout_seconds,
                )
            except (
                asyncio.IncompleteReadError,
                ConnectionError,
                OSError,
                StreamWorkerExecutionError,
                TimeoutError,
            ):
                pass
            finally:
                await self._close_writer(writer)
            return
        if connection_task is not None:
            self._active.add(connection_task)
        emitter: LocalIPCResultEmitter | None = None
        emitter_closed = False
        execution_task: asyncio.Task[None] | None = None
        disconnect_task: asyncio.Task[bytes] | None = None
        heartbeat_task: asyncio.Task[None] | None = None
        try:
            frame = await asyncio.wait_for(
                read_frame(reader),
                timeout=self._first_frame_timeout_seconds,
            )
            if frame.get("type") == "ping":
                await frame_writer.write({"type": "pong"})
                return
            if frame.get("type") in {
                "point_callback",
                "point_device",
                "point_execution",
                "point_runtime",
                "point_runtime_task_updated",
            }:
                await self._handle_point_event(frame, reader, frame_writer)
                return
            if frame.get("type") == "openapi_stream":
                await self._handle_openapi_stream(frame, reader, writer)
                return
            if frame.get("type") == "openapi_execute":
                await self._handle_openapi_execute(
                    frame,
                    reader,
                    frame_writer,
                )
                return
            if frame.get("type") == "web_stream":
                await self._handle_web_stream(frame, reader, writer)
                return
            if frame.get("type") == "web_execute":
                await self._handle_web_execute(frame, reader, writer)
                return
            if frame.get("type") != "execute" or not isinstance(
                frame.get("request"), dict
            ):
                raise ValueError("First local IPC frame must contain an execution")
            request = ExecutionRequest.from_dict(frame["request"])
            project_to_web = frame.get("project_to_web")
            if not isinstance(project_to_web, bool):
                raise ValueError("Execution frame requires project_to_web")
            emitter = LocalIPCResultEmitter(
                request.task_id,
                request.subtask_id,
                frame_writer,
            )
            if project_to_web:
                execution = self._dispatcher.dispatch_worker_owned(request, emitter)
            else:
                execution = self._dispatcher.dispatch_worker_owned(
                    request,
                    emitter,
                    project_to_web=False,
                )
            execution_task = asyncio.create_task(execution)
            disconnect_task = asyncio.create_task(reader.read(1))
            heartbeat_task = asyncio.create_task(self._send_heartbeats(frame_writer))
            done, _ = await asyncio.wait(
                {execution_task, disconnect_task, heartbeat_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
            if execution_task in done:
                await execution_task
                heartbeat_task.cancel()
                await asyncio.gather(heartbeat_task, return_exceptions=True)
                await emitter.close()
                emitter_closed = True
                terminal_event = emitter.terminal_event
                if terminal_event is None:
                    await frame_writer.write({"type": "complete"})
                else:
                    await frame_writer.write(
                        {
                            "type": "terminal",
                            "event": terminal_event.to_dict(),
                        }
                    )
                return
            if disconnect_task in done:
                heartbeat_task.cancel()
                await asyncio.gather(heartbeat_task, return_exceptions=True)
                self._background.add(execution_task)
                execution_task.add_done_callback(self._background.discard)
                execution_task = None
                return
            await heartbeat_task
        except asyncio.CancelledError:
            raise
        except Exception as error:
            logger.exception("Local stream execution failed")
            if emitter is not None and not emitter_closed:
                try:
                    await emitter.close()
                except Exception:
                    logger.exception("Failed to close local stream emitter")
            try:
                error_code = getattr(error, "error_code", None)
                if not isinstance(error_code, str) or not error_code:
                    error_code = (
                        "stream_worker_first_frame_timeout"
                        if isinstance(error, TimeoutError) and emitter is None
                        else classify_error(error)
                    )
                await frame_writer.write(
                    {
                        "type": "error",
                        "message": format_error_message(error),
                        "error_code": error_code,
                        **(
                            {"details": error.details}
                            if isinstance(getattr(error, "details", None), list)
                            else {}
                        ),
                    },
                )
            except (ConnectionError, OSError, TimeoutError):
                pass
        finally:
            pending_tasks = [
                child_task
                for child_task in (
                    execution_task,
                    disconnect_task,
                    heartbeat_task,
                )
                if child_task is not None and not child_task.done()
            ]
            for pending_task in pending_tasks:
                pending_task.cancel()
            if pending_tasks:
                await asyncio.gather(*pending_tasks, return_exceptions=True)
            await self._close_writer(writer)
            if connection_task is not None:
                self._active.discard(connection_task)

    async def _handle_openapi_stream(
        self,
        frame: dict[str, Any],
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        raw_writer = LocalIPCRawFrameWriter(
            writer,
            self._frame_write_timeout_seconds,
            OPENAPI_STREAM_MAX_FRAME_BYTES,
        )
        stream_task: asyncio.Task[None] | None = None
        disconnect_task: asyncio.Task[bytes] | None = None
        heartbeat_task: asyncio.Task[None] | None = None
        try:
            if self._openapi_projector is None:
                raise StreamWorkerExecutionError(
                    "OpenAPI worker execution is not configured"
                )
            raw_request = frame.get("request")
            raw_response = frame.get("response")
            if not isinstance(raw_request, dict) or not isinstance(raw_response, dict):
                raise StreamWorkerExecutionError(
                    "Invalid OpenAPI stream execution envelope"
                )
            request, spec = await run_payload_codec(
                _decode_openapi_stream_request,
                raw_request,
                raw_response,
                payload_hint=(raw_request, raw_response),
                force_offload=True,
            )

            async def relay() -> None:
                async for payload in self._openapi_projector.stream_sse(request, spec):
                    await raw_writer.write(OPENAPI_STREAM_FRAME_SSE, payload)
                await raw_writer.write(OPENAPI_STREAM_FRAME_COMPLETE)

            stream_task = asyncio.create_task(relay())
            disconnect_task = asyncio.create_task(reader.read(1))
            heartbeat_task = asyncio.create_task(
                self._send_raw_stream_heartbeats(
                    raw_writer,
                    OPENAPI_STREAM_FRAME_HEARTBEAT,
                )
            )
            done, _ = await asyncio.wait(
                {stream_task, disconnect_task, heartbeat_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
            if disconnect_task in done:
                stream_task.cancel()
                await asyncio.gather(stream_task, return_exceptions=True)
                return
            if stream_task in done:
                await stream_task
                return
            await heartbeat_task
        except asyncio.CancelledError:
            raise
        except Exception as error:
            logger.exception("Worker-owned OpenAPI stream failed")
            await self._write_raw_stream_error(
                raw_writer,
                OPENAPI_STREAM_FRAME_ERROR,
                error,
            )
        finally:
            pending_tasks = [
                task
                for task in (stream_task, disconnect_task, heartbeat_task)
                if task is not None and not task.done()
            ]
            for pending_task in pending_tasks:
                pending_task.cancel()
            if pending_tasks:
                await asyncio.gather(*pending_tasks, return_exceptions=True)

    async def _handle_web_stream(
        self,
        frame: dict[str, Any],
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        raw_writer = LocalIPCRawFrameWriter(
            writer,
            self._frame_write_timeout_seconds,
            WEB_STREAM_MAX_FRAME_BYTES,
        )
        stream_task: asyncio.Task[None] | None = None
        disconnect_task: asyncio.Task[bytes] | None = None
        heartbeat_task: asyncio.Task[None] | None = None
        try:
            if self._web_stream_projector is None:
                raise StreamWorkerExecutionError(
                    "Web stream execution is not configured"
                )
            operation = frame.get("operation")
            payload = frame.get("payload")
            if (
                not isinstance(operation, str)
                or not operation
                or not isinstance(payload, dict)
            ):
                raise StreamWorkerExecutionError(
                    "Invalid Web stream execution envelope"
                )

            async def relay() -> None:
                source: AsyncIterator[bytes] | None = None
                try:
                    if operation in WEB_RAW_STREAM_OPERATIONS:
                        metadata, source = (
                            await self._web_stream_projector.open_raw_stream(
                                operation,
                                payload,
                            )
                        )
                        encoded_metadata = await run_payload_codec(
                            orjson.dumps,
                            metadata,
                            payload_hint=metadata,
                            force_offload=True,
                        )
                        await raw_writer.write(
                            WEB_STREAM_FRAME_METADATA,
                            encoded_metadata,
                        )
                    else:
                        source = self._web_stream_projector.stream(
                            operation,
                            payload,
                        )
                    async for chunk in source:
                        if not isinstance(chunk, bytes) or not chunk:
                            raise StreamWorkerExecutionError(
                                "Web stream worker produced an invalid payload"
                            )
                        await raw_writer.write(WEB_STREAM_FRAME_DATA, chunk)
                    await raw_writer.write(WEB_STREAM_FRAME_COMPLETE)
                finally:
                    if source is not None:
                        close = getattr(source, "aclose", None)
                        if close is not None:
                            await close()

            stream_task = asyncio.create_task(relay())
            disconnect_task = asyncio.create_task(reader.read(1))
            heartbeat_task = asyncio.create_task(
                self._send_raw_stream_heartbeats(
                    raw_writer,
                    WEB_STREAM_FRAME_HEARTBEAT,
                )
            )
            done, _ = await asyncio.wait(
                {stream_task, disconnect_task, heartbeat_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
            if disconnect_task in done:
                stream_task.cancel()
                await asyncio.gather(stream_task, return_exceptions=True)
                return
            if stream_task in done:
                await stream_task
                return
            await heartbeat_task
        except asyncio.CancelledError:
            raise
        except Exception as error:
            logger.exception("Worker-owned Web stream failed")
            await self._write_raw_stream_error(
                raw_writer,
                WEB_STREAM_FRAME_ERROR,
                error,
            )
        finally:
            pending_tasks = [
                task
                for task in (stream_task, disconnect_task, heartbeat_task)
                if task is not None and not task.done()
            ]
            for pending_task in pending_tasks:
                pending_task.cancel()
            if pending_tasks:
                await asyncio.gather(*pending_tasks, return_exceptions=True)

    async def _handle_web_execute(
        self,
        frame: dict[str, Any],
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        raw_writer = LocalIPCRawFrameWriter(
            writer,
            self._frame_write_timeout_seconds,
            WEB_EXECUTE_MAX_RESULT_BYTES,
        )
        execution_task: asyncio.Task[dict[str, Any]] | None = None
        disconnect_task: asyncio.Task[bytes] | None = None
        heartbeat_task: asyncio.Task[None] | None = None
        try:
            if self._web_stream_projector is None:
                raise StreamWorkerExecutionError(
                    "Web execute operation is not configured"
                )
            operation = frame.get("operation")
            payload = frame.get("payload")
            if (
                not isinstance(operation, str)
                or not operation
                or not isinstance(payload, dict)
            ):
                raise StreamWorkerExecutionError(
                    "Invalid Web execute operation envelope"
                )
            execution_task = asyncio.create_task(
                self._web_stream_projector.execute(operation, payload)
            )
            disconnect_task = asyncio.create_task(reader.read(1))
            heartbeat_task = asyncio.create_task(
                self._send_raw_stream_heartbeats(
                    raw_writer,
                    WEB_STREAM_FRAME_HEARTBEAT,
                )
            )
            done, _ = await asyncio.wait(
                {execution_task, disconnect_task, heartbeat_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
            if disconnect_task in done:
                execution_task.cancel()
                await asyncio.gather(execution_task, return_exceptions=True)
                return
            if execution_task in done:
                result = await execution_task
                encoded = await run_payload_codec(
                    orjson.dumps,
                    result,
                    payload_hint=result,
                    force_offload=True,
                )
                await raw_writer.write(WEB_STREAM_FRAME_DATA, encoded)
                return
            await heartbeat_task
        except asyncio.CancelledError:
            raise
        except Exception as error:
            logger.exception("Worker-owned Web execute operation failed")
            await self._write_raw_stream_error(
                raw_writer,
                WEB_STREAM_FRAME_ERROR,
                error,
            )
        finally:
            pending_tasks = [
                task
                for task in (execution_task, disconnect_task, heartbeat_task)
                if task is not None and not task.done()
            ]
            for pending_task in pending_tasks:
                pending_task.cancel()
            if pending_tasks:
                await asyncio.gather(*pending_tasks, return_exceptions=True)

    async def _handle_openapi_execute(
        self,
        frame: dict[str, Any],
        reader: asyncio.StreamReader,
        frame_writer: LocalIPCFrameWriter,
    ) -> None:
        if self._openapi_projector is None:
            raise StreamWorkerExecutionError(
                "OpenAPI worker execution is not configured"
            )
        raw_request = frame.get("request")
        background = frame.get("background")
        if not isinstance(raw_request, dict) or not isinstance(background, bool):
            raise StreamWorkerExecutionError(
                "Invalid OpenAPI non-stream execution envelope"
            )
        request = await run_payload_codec(
            ExecutionRequest.from_dict,
            raw_request,
            payload_hint=raw_request,
            force_offload=True,
        )
        immediate_status = self._openapi_projector.immediate_status(
            request,
            background=background,
        )
        if immediate_status is not None:
            if len(self._background) >= self._max_connections:
                raise StreamWorkerExecutionError(
                    "OpenAPI background execution capacity exhausted",
                    error_code="openapi_background_overloaded",
                )
            background_task = asyncio.create_task(
                self._openapi_projector.run_background(request)
            )
            self._track_background_task(background_task)
            await frame_writer.write(
                {
                    "type": "openapi_result",
                    "result": OpenAPIExecutionOutcome(
                        status=immediate_status
                    ).to_dict(),
                }
            )
            return

        collect_task = asyncio.create_task(self._openapi_projector.collect(request))
        disconnect_task = asyncio.create_task(reader.read(1))
        try:
            done, _ = await asyncio.wait(
                {collect_task, disconnect_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
            if disconnect_task in done:
                collect_task.cancel()
                await asyncio.gather(collect_task, return_exceptions=True)
                return
            outcome = await collect_task
            await frame_writer.write(
                {
                    "type": "openapi_result",
                    "result": outcome.to_dict(),
                }
            )
        finally:
            for task in (collect_task, disconnect_task):
                if not task.done():
                    task.cancel()
            await asyncio.gather(
                collect_task,
                disconnect_task,
                return_exceptions=True,
            )

    def _track_background_task(self, task: asyncio.Task[Any]) -> None:
        self._background.add(task)

        def completed(completed_task: asyncio.Task[Any]) -> None:
            self._background.discard(completed_task)
            try:
                error = completed_task.exception()
            except asyncio.CancelledError:
                return
            if error is not None:
                logger.error(
                    "Worker-owned OpenAPI background execution failed: %s",
                    error,
                    exc_info=error,
                )

        task.add_done_callback(completed)

    async def _send_raw_stream_heartbeats(
        self,
        frame_writer: LocalIPCRawFrameWriter,
        marker: bytes,
    ) -> None:
        while True:
            await asyncio.sleep(self._heartbeat_interval_seconds)
            await frame_writer.write(marker)

    @staticmethod
    async def _write_raw_stream_error(
        frame_writer: LocalIPCRawFrameWriter,
        marker: bytes,
        error: Exception,
    ) -> None:
        error_code = getattr(error, "error_code", None)
        if not isinstance(error_code, str) or not error_code:
            error_code = classify_error(error)
        payload = await run_payload_codec(
            orjson.dumps,
            {
                "type": "error",
                "message": format_error_message(error),
                "error_code": error_code,
                **(
                    {"status_code": error.status_code}
                    if isinstance(getattr(error, "status_code", None), int)
                    else {}
                ),
            },
            payload_hint=error,
            force_offload=True,
        )
        try:
            await frame_writer.write(marker, payload)
        except (ConnectionError, OSError, TimeoutError):
            pass

    async def _handle_point_event(
        self,
        frame: dict[str, Any],
        reader: asyncio.StreamReader,
        frame_writer: LocalIPCFrameWriter,
    ) -> None:
        if self._point_projector is None:
            raise StreamWorkerExecutionError(
                "Execution point projection is not configured"
            )
        frame_type = frame.get("type")
        if frame_type == "point_callback":
            batch = frame.get("batch")
            body_size = frame.get("body_size")
            if not isinstance(batch, bool) or not isinstance(body_size, int):
                raise StreamWorkerExecutionError("Invalid callback point envelope")
            body = await asyncio.wait_for(
                read_raw_frame(reader, max_bytes=POINT_EVENT_MAX_BODY_BYTES),
                timeout=self._first_frame_timeout_seconds,
            )
            if len(body) != body_size:
                raise StreamWorkerExecutionError("Callback body size mismatch")
            result = await asyncio.wait_for(
                self._point_projector.project_callback_body(body, batch=batch),
                timeout=_POINT_EVENT_PROCESSING_TIMEOUT_SECONDS,
            )
        elif frame_type == "point_device":
            user_id = frame.get("user_id")
            device_id = frame.get("device_id")
            event_type = frame.get("event_type")
            data = frame.get("data")
            if (
                not isinstance(user_id, int)
                or user_id <= 0
                or not isinstance(device_id, str)
                or not device_id
                or not isinstance(event_type, str)
                or not event_type
                or not isinstance(data, dict)
            ):
                raise StreamWorkerExecutionError("Invalid device point envelope")
            result = await asyncio.wait_for(
                self._point_projector.project_device_event(
                    user_id=user_id,
                    device_id=device_id,
                    event_type=event_type,
                    data=data,
                ),
                timeout=_POINT_EVENT_PROCESSING_TIMEOUT_SECONDS,
            )
        elif frame_type == "point_execution":
            raw_event = frame.get("event")
            user_id = frame.get("user_id")
            source = frame.get("source")
            publish_callback = frame.get("publish_callback")
            executor_name = frame.get("executor_name")
            executor_namespace = frame.get("executor_namespace")
            if (
                not isinstance(raw_event, dict)
                or (user_id is not None and not isinstance(user_id, int))
                or not isinstance(source, str)
                or not source
                or not isinstance(publish_callback, bool)
                or (executor_name is not None and not isinstance(executor_name, str))
                or (
                    executor_namespace is not None
                    and not isinstance(executor_namespace, str)
                )
            ):
                raise StreamWorkerExecutionError("Invalid execution point envelope")
            result = await asyncio.wait_for(
                self._point_projector.project_execution_event(
                    event=ExecutionEvent.from_dict(raw_event),
                    user_id=user_id,
                    source=source,
                    publish_callback=publish_callback,
                    executor_name=executor_name,
                    executor_namespace=executor_namespace,
                ),
                timeout=_POINT_EVENT_PROCESSING_TIMEOUT_SECONDS,
            )
        elif frame_type == "point_runtime":
            user_id = frame.get("user_id")
            device_id = frame.get("device_id")
            logical_device_id = frame.get("logical_device_id")
            data = frame.get("data")
            if (
                not isinstance(user_id, int)
                or user_id <= 0
                or not isinstance(device_id, str)
                or not device_id
                or not isinstance(logical_device_id, str)
                or not logical_device_id
                or not isinstance(data, dict)
            ):
                raise StreamWorkerExecutionError("Invalid runtime point envelope")
            result = await asyncio.wait_for(
                self._point_projector.project_runtime_event(
                    user_id=user_id,
                    device_id=device_id,
                    logical_device_id=logical_device_id,
                    data=data,
                ),
                timeout=_POINT_EVENT_PROCESSING_TIMEOUT_SECONDS,
            )
        else:
            user_id = frame.get("user_id")
            device_id = frame.get("device_id")
            data = frame.get("data")
            if (
                not isinstance(user_id, int)
                or user_id <= 0
                or not isinstance(device_id, str)
                or not device_id
                or not isinstance(data, dict)
            ):
                raise StreamWorkerExecutionError(
                    "Invalid runtime task update point envelope"
                )
            result = await asyncio.wait_for(
                self._point_projector.project_runtime_task_updated(
                    user_id=user_id,
                    device_id=device_id,
                    data=data,
                ),
                timeout=_POINT_EVENT_PROCESSING_TIMEOUT_SECONDS,
            )
        await frame_writer.write({"type": "point_result", "result": result})

    async def _send_heartbeats(self, frame_writer: LocalIPCFrameWriter) -> None:
        while True:
            await asyncio.sleep(self._heartbeat_interval_seconds)
            await frame_writer.write({"type": "heartbeat"})

    @staticmethod
    async def _close_writer(writer: asyncio.StreamWriter) -> None:
        writer.close()
        try:
            await asyncio.wait_for(
                writer.wait_closed(),
                timeout=_CLOSE_TIMEOUT_SECONDS,
            )
        except (ConnectionError, OSError, TimeoutError):
            pass


async def run_worker() -> None:
    """Run the Pod-local IPC server until SIGINT or SIGTERM."""
    setup_logging()
    from app.core.socketio import get_sio
    from app.services.chat.storage import session_manager
    from app.services.chat.webpage_ws_chat_emitter import init_ws_emitter
    from app.services.execution.completion_handlers import (
        initialize_execution_completion_handlers,
    )
    from app.services.execution.point_projection import execution_projection_service
    from app.services.execution.web_stream_execution import (
        web_stream_execution_service,
    )
    from app.services.openapi.worker_execution import OpenAPIWorkerExecutionService

    init_ws_emitter(get_sio())
    initialize_execution_completion_handlers()
    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    for handled_signal in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(handled_signal, stop_event.set)

    status_dispatcher = StatusOwningSSEDispatcher(execution_dispatcher)
    openapi_projector = OpenAPIWorkerExecutionService(
        status_dispatcher,
        session_manager,
    )
    server = LocalStreamServer(
        settings.STREAM_WORKER_SOCKET_PATH,
        status_dispatcher,
        point_projector=execution_projection_service,
        openapi_projector=openapi_projector,
        web_stream_projector=web_stream_execution_service,
    )
    try:
        await server.run(stop_event)
    finally:
        await execution_projection_service.close()
        await execution_dispatcher.close()


def main() -> None:
    """Run the isolated upstream SSE process."""
    asyncio.run(run_worker())


if __name__ == "__main__":
    main()
