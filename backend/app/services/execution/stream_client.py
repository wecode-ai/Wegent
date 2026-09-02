# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Pod-local IPC client for isolated upstream SSE execution."""

from __future__ import annotations

import asyncio
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import orjson

from app.core.bounded_executor import BoundedExecutor
from app.core.byte_admission import (
    ByteAdmissionTooLarge,
    ByteLease,
    LoopLocalByteAdmission,
)
from app.core.config import settings
from app.core.loop_rate_admission import (
    LoopLocalTokenBucket,
    web_realtime_event_admission,
)
from shared.models import EventType, ExecutionEvent, ExecutionRequest
from shared.telemetry.decorators import trace_async

from .emitters.base import BaseResultEmitter
from .emitters.protocol import ResultEmitter

_FRAME_HEADER_BYTES = 4
_MAX_FRAME_BYTES = 32 * 1024 * 1024
_HEARTBEAT_FRAME_BYTES = b'{"type":"heartbeat"}'
_CONNECT_TIMEOUT_SECONDS = 3.0
_FIRST_FRAME_TIMEOUT_SECONDS = 10.0
_HEARTBEAT_TIMEOUT_SECONDS = 20.0
_FRAME_WRITE_TIMEOUT_SECONDS = 20.0
_CLOSE_TIMEOUT_SECONDS = 1.0
_EVENT_RELAY_CAPACITY = 64
_EVENT_RELAY_MAX_BYTES = 64 * 1024 * 1024
POINT_EVENT_MAX_BODY_BYTES = 4 * 1024 * 1024
POINT_EVENT_MAX_IN_FLIGHT_RPCS = 128
_POINT_EVENT_RESPONSE_TIMEOUT_SECONDS = 140.0
STREAM_WORKER_MAX_CONNECTIONS = 256
_CODEC_EXECUTOR = BoundedExecutor(
    max_workers=4,
    max_in_flight=8,
    max_waiters=STREAM_WORKER_MAX_CONNECTIONS,
    thread_name_prefix="wegent-ipc-codec",
)
_RELAY_COMPLETE = object()
_TERMINAL_EVENT_TYPES = frozenset(
    {
        EventType.DONE.value,
        EventType.ERROR.value,
        EventType.CANCELLED.value,
    }
)


class StreamRelayByteAdmission(LoopLocalByteAdmission):
    """Bound IPC frame bytes retained by all Web streams on one event loop."""

    def __init__(self, max_bytes: int) -> None:
        super().__init__(max_bytes, label="Local IPC frame")

    async def acquire(self, size: int) -> ByteLease:
        try:
            return await super().acquire(size)
        except ByteAdmissionTooLarge as error:
            raise StreamWorkerExecutionError(
                f"Local IPC frame exceeds relay byte budget: {size}"
            ) from error


@dataclass(frozen=True)
class _RelayedEvent:
    event: ExecutionEvent
    lease: ByteLease


web_stream_relay_byte_admission = StreamRelayByteAdmission(_EVENT_RELAY_MAX_BYTES)


class StreamWorkerUnavailableError(RuntimeError):
    """Raised when the Pod-local stream process cannot be reached."""


class StreamWorkerExecutionError(RuntimeError):
    """Raised when isolated upstream SSE execution fails."""

    def __init__(
        self,
        message: str,
        *,
        error_code: str | None = None,
        details: list[dict[str, Any]] | None = None,
        status_code: int | None = None,
    ) -> None:
        super().__init__(message)
        self.error_code = error_code
        self.details = details
        self.status_code = status_code


class _RPCAdmission:
    """Bound process-local IPC sockets before connecting to the worker."""

    def __init__(
        self,
        capacity: int,
        *,
        message: str,
        error_code: str,
    ) -> None:
        if capacity <= 0:
            raise ValueError("RPC admission capacity must be positive")
        self._capacity = capacity
        self._message = message
        self._error_code = error_code
        self._in_flight = 0
        self._lock = threading.Lock()

    def acquire(self) -> None:
        with self._lock:
            if self._in_flight >= self._capacity:
                raise StreamWorkerExecutionError(
                    self._message,
                    error_code=self._error_code,
                )
            self._in_flight += 1

    def release(self) -> None:
        with self._lock:
            if self._in_flight <= 0:
                raise RuntimeError("RPC admission released without acquire")
            self._in_flight -= 1


_POINT_RPC_ADMISSION = _RPCAdmission(
    POINT_EVENT_MAX_IN_FLIGHT_RPCS,
    message="Execution projection RPC capacity exhausted",
    error_code="point_projection_overloaded",
)
web_stream_rpc_admission = _RPCAdmission(
    settings.WEB_MAX_STREAM_CONNECTIONS,
    message="Web stream connection capacity exhausted",
    error_code="web_stream_overloaded",
)


class StreamExecutionClient:
    """Execute one SSE request through the local Unix-domain socket."""

    def __init__(
        self,
        socket_path: str | Path | None = None,
        *,
        connect_timeout_seconds: float = _CONNECT_TIMEOUT_SECONDS,
        first_frame_timeout_seconds: float = _FIRST_FRAME_TIMEOUT_SECONDS,
        heartbeat_timeout_seconds: float = _HEARTBEAT_TIMEOUT_SECONDS,
        point_response_timeout_seconds: float = _POINT_EVENT_RESPONSE_TIMEOUT_SECONDS,
        event_relay_capacity: int = _EVENT_RELAY_CAPACITY,
        relay_byte_admission: StreamRelayByteAdmission | None = None,
        event_admission: LoopLocalTokenBucket | None = None,
        stream_admission: _RPCAdmission | None = None,
    ) -> None:
        if connect_timeout_seconds <= 0:
            raise ValueError("connect_timeout_seconds must be positive")
        if first_frame_timeout_seconds <= 0:
            raise ValueError("first_frame_timeout_seconds must be positive")
        if heartbeat_timeout_seconds <= 0:
            raise ValueError("heartbeat_timeout_seconds must be positive")
        if point_response_timeout_seconds <= 0:
            raise ValueError("point_response_timeout_seconds must be positive")
        if event_relay_capacity <= 0:
            raise ValueError("event_relay_capacity must be positive")
        self._socket_path = Path(socket_path) if socket_path is not None else None
        self._connect_timeout_seconds = connect_timeout_seconds
        self._first_frame_timeout_seconds = first_frame_timeout_seconds
        self._heartbeat_timeout_seconds = heartbeat_timeout_seconds
        self._point_response_timeout_seconds = point_response_timeout_seconds
        self._event_relay_capacity = event_relay_capacity
        self._relay_byte_admission = (
            relay_byte_admission or web_stream_relay_byte_admission
        )
        self._event_admission = event_admission or web_realtime_event_admission
        self._stream_admission = stream_admission or web_stream_rpc_admission

    @property
    def socket_path(self) -> Path:
        """Resolve the configured socket lazily for test and process isolation."""
        return self._socket_path or Path(settings.STREAM_WORKER_SOCKET_PATH)

    async def ping(self) -> None:
        """Verify that the stream worker accepts and processes IPC frames."""
        reader, writer = await self._open_connection()
        try:
            try:
                await asyncio.wait_for(
                    write_frame(writer, {"type": "ping"}),
                    timeout=self._first_frame_timeout_seconds,
                )
                frame = await asyncio.wait_for(
                    read_frame(reader),
                    timeout=self._first_frame_timeout_seconds,
                )
            except TimeoutError as error:
                raise StreamWorkerExecutionError(
                    "Local stream worker ping timed out",
                    error_code="stream_worker_timeout",
                ) from error
            except asyncio.IncompleteReadError as error:
                raise StreamWorkerExecutionError(
                    "Local stream worker disconnected during ping"
                ) from error

            frame_type = frame.get("type")
            if frame_type == "pong":
                return
            if frame_type == "error":
                message = frame.get("message")
                error_code = frame.get("error_code")
                raise StreamWorkerExecutionError(
                    (
                        message
                        if isinstance(message, str) and message
                        else "Local stream worker rejected ping"
                    ),
                    error_code=(
                        error_code
                        if isinstance(error_code, str) and error_code
                        else None
                    ),
                )
            raise StreamWorkerExecutionError(
                f"Unexpected local stream worker ping response: {frame_type!r}"
            )
        finally:
            await self._close_writer(writer)

    async def dispatch_callback_body(
        self,
        body: bytes,
        *,
        batch: bool,
    ) -> dict[str, Any]:
        """Send bounded raw callback JSON for worker-owned validation/projection."""
        if not isinstance(body, bytes):
            raise TypeError("body must be bytes")
        if not body or len(body) > POINT_EVENT_MAX_BODY_BYTES:
            raise StreamWorkerExecutionError(
                f"Callback body must be 1..{POINT_EVENT_MAX_BODY_BYTES} bytes",
                error_code="point_projection_frame_too_large",
            )
        return await self._request_point_event(
            {
                "type": "point_callback",
                "batch": batch,
                "body_size": len(body),
            },
            raw_body=body,
        )

    async def dispatch_device_event(
        self,
        *,
        user_id: int,
        device_id: str,
        event_type: str,
        data: dict[str, Any],
    ) -> dict[str, Any]:
        """Forward one authenticated device event to the projection worker."""
        if not isinstance(user_id, int) or user_id <= 0:
            raise ValueError("user_id must be positive")
        if not isinstance(device_id, str) or not device_id:
            raise ValueError("device_id must be non-empty")
        if not isinstance(event_type, str) or not event_type:
            raise ValueError("event_type must be non-empty")
        if not isinstance(data, dict):
            raise ValueError("data must be a dictionary")
        return await self._request_point_event(
            {
                "type": "point_device",
                "user_id": user_id,
                "device_id": device_id,
                "event_type": event_type,
                "data": data,
            }
        )

    async def dispatch_runtime_event(
        self,
        *,
        user_id: int,
        device_id: str,
        logical_device_id: str,
        data: dict[str, Any],
    ) -> dict[str, Any]:
        """Forward one authenticated native-runtime relay event."""
        if not isinstance(user_id, int) or user_id <= 0:
            raise ValueError("user_id must be positive")
        if not device_id or not logical_device_id or not isinstance(data, dict):
            raise ValueError("Invalid native-runtime event envelope")
        return await self._request_point_event(
            {
                "type": "point_runtime",
                "user_id": user_id,
                "device_id": device_id,
                "logical_device_id": logical_device_id,
                "data": data,
            }
        )

    async def dispatch_runtime_task_updated(
        self,
        *,
        user_id: int,
        device_id: str,
        data: dict[str, Any],
    ) -> dict[str, Any]:
        """Forward one authenticated native-runtime task update."""
        if not isinstance(user_id, int) or user_id <= 0:
            raise ValueError("user_id must be positive")
        if not isinstance(device_id, str) or not device_id:
            raise ValueError("device_id must be non-empty")
        if not isinstance(data, dict):
            raise ValueError("data must be a dictionary")
        return await self._request_point_event(
            {
                "type": "point_runtime_task_updated",
                "user_id": user_id,
                "device_id": device_id,
                "data": data,
            }
        )

    async def dispatch_execution_event(
        self,
        event: ExecutionEvent,
        *,
        user_id: int | None,
        source: str,
        publish_callback: bool = False,
        executor_name: str | None = None,
        executor_namespace: str | None = None,
    ) -> None:
        """Project one already-materialized event in the Stream worker."""
        if not isinstance(event, ExecutionEvent):
            raise TypeError("event must be an ExecutionEvent")
        result = await self._request_point_event(
            {
                "type": "point_execution",
                "event": await _CODEC_EXECUTOR.run(event.to_dict),
                "user_id": user_id,
                "source": source,
                "publish_callback": publish_callback,
                "executor_name": executor_name,
                "executor_namespace": executor_namespace,
            }
        )
        if result != {"success": True}:
            raise StreamWorkerExecutionError(
                "Execution projection returned an invalid acknowledgement"
            )

    async def _request_point_event(
        self,
        envelope: dict[str, Any],
        *,
        raw_body: bytes | None = None,
    ) -> dict[str, Any]:
        _POINT_RPC_ADMISSION.acquire()
        writer: asyncio.StreamWriter | None = None
        try:
            reader, writer = await self._open_connection()
            try:
                await asyncio.wait_for(
                    write_frame(
                        writer,
                        envelope,
                        max_bytes=POINT_EVENT_MAX_BODY_BYTES,
                    ),
                    timeout=_FRAME_WRITE_TIMEOUT_SECONDS,
                )
                if raw_body is not None:
                    await asyncio.wait_for(
                        write_raw_frame(
                            writer,
                            raw_body,
                            max_bytes=POINT_EVENT_MAX_BODY_BYTES,
                        ),
                        timeout=_FRAME_WRITE_TIMEOUT_SECONDS,
                    )
                response = await asyncio.wait_for(
                    read_frame(reader),
                    timeout=self._point_response_timeout_seconds,
                )
            except TimeoutError as error:
                raise StreamWorkerExecutionError(
                    "Execution projection worker timed out",
                    error_code="point_projection_timeout",
                ) from error
            except asyncio.IncompleteReadError as error:
                raise StreamWorkerExecutionError(
                    "Execution projection worker disconnected"
                ) from error

            if response.get("type") == "point_result":
                result = response.get("result")
                if not isinstance(result, dict):
                    raise StreamWorkerExecutionError(
                        "Execution projection returned an invalid result"
                    )
                return result
            if response.get("type") == "error":
                message = response.get("message")
                error_code = response.get("error_code")
                details = response.get("details")
                raise StreamWorkerExecutionError(
                    message if isinstance(message, str) else "Projection failed",
                    error_code=error_code if isinstance(error_code, str) else None,
                    details=(
                        details
                        if isinstance(details, list)
                        and all(isinstance(item, dict) for item in details)
                        else None
                    ),
                )
            raise StreamWorkerExecutionError(
                "Execution projection returned an unknown response"
            )
        finally:
            if writer is not None:
                await self._close_writer(writer)
            _POINT_RPC_ADMISSION.release()

    async def _open_connection(
        self,
    ) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
        try:
            return await asyncio.wait_for(
                asyncio.open_unix_connection(self.socket_path),
                timeout=self._connect_timeout_seconds,
            )
        except TimeoutError as error:
            raise StreamWorkerUnavailableError(
                f"Timed out connecting to local stream worker: {self.socket_path}"
            ) from error
        except (FileNotFoundError, ConnectionError, OSError) as error:
            raise StreamWorkerUnavailableError(
                f"Local stream worker is unavailable: {self.socket_path}"
            ) from error

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

    @trace_async("execution.stream_client.dispatch", "execution.stream_client")
    async def dispatch(
        self,
        request: ExecutionRequest,
        emitter: ResultEmitter,
        *,
        project_to_web: bool = True,
    ) -> None:
        """Send a request locally and forward parsed events to the original emitter."""
        self._stream_admission.acquire()
        try:
            await self._dispatch_admitted(
                request,
                emitter,
                project_to_web=project_to_web,
            )
        finally:
            self._stream_admission.release()

    async def _dispatch_admitted(
        self,
        request: ExecutionRequest,
        emitter: ResultEmitter,
        *,
        project_to_web: bool = True,
    ) -> None:
        """Own one admitted stream socket until delivery has terminated."""
        encoded_request = await _CODEC_EXECUTOR.run(request.to_dict)
        reader, writer = await self._open_connection()

        relay: asyncio.Queue[_RelayedEvent | object] = asyncio.Queue(
            maxsize=self._event_relay_capacity
        )
        receive_task: asyncio.Task[StreamWorkerExecutionError | None] | None = None
        drain_task: asyncio.Task[None] | None = None
        try:
            # Read concurrently with the initial write. An overloaded worker may
            # reject immediately after accept; starting the reader first keeps
            # its structured error from being hidden by a connection reset.
            receive_task = asyncio.create_task(self._receive_frames(reader, relay))
            drain_task = asyncio.create_task(self._drain_events(relay, emitter))
            try:
                await asyncio.wait_for(
                    write_frame(
                        writer,
                        {
                            "type": "execute",
                            "request": encoded_request,
                            "project_to_web": project_to_web,
                        },
                    ),
                    timeout=_FRAME_WRITE_TIMEOUT_SECONDS,
                )
            except TimeoutError as error:
                raise StreamWorkerExecutionError(
                    "Timed out sending request to local stream worker",
                    error_code="stream_worker_timeout",
                ) from error
            except (ConnectionError, OSError) as error:
                try:
                    receive_error = await asyncio.wait_for(
                        asyncio.shield(receive_task),
                        timeout=min(self._first_frame_timeout_seconds, 1.0),
                    )
                    await drain_task
                except TimeoutError:
                    raise StreamWorkerExecutionError(
                        "Local stream worker disconnected while receiving request",
                    ) from error
                if receive_error is not None:
                    raise receive_error from error
                raise StreamWorkerExecutionError(
                    "Local stream worker disconnected while receiving request",
                ) from error
            done, _ = await asyncio.wait(
                {receive_task, drain_task},
                return_when=asyncio.FIRST_COMPLETED,
            )

            if drain_task in done:
                await drain_task

            receive_error = await receive_task
            await drain_task
            if receive_error is not None:
                raise receive_error
        finally:
            pending_tasks = [
                task
                for task in (receive_task, drain_task)
                if task is not None and not task.done()
            ]
            for pending_task in pending_tasks:
                pending_task.cancel()
            if pending_tasks:
                await asyncio.gather(*pending_tasks, return_exceptions=True)
            await self._close_writer(writer)

    async def _receive_frames(
        self,
        reader: asyncio.StreamReader,
        relay: asyncio.Queue[_RelayedEvent | object],
    ) -> StreamWorkerExecutionError | None:
        """Read IPC frames without coupling socket progress to a slow emitter."""
        receive_error: StreamWorkerExecutionError | None = None
        first_frame = True
        try:
            while True:
                lease: ByteLease | None = None
                lease_forwarded = False
                try:
                    frame, lease = await asyncio.wait_for(
                        _read_admitted_frame(
                            reader,
                            self._relay_byte_admission,
                            self._event_admission,
                        ),
                        timeout=(
                            self._first_frame_timeout_seconds
                            if first_frame
                            else self._heartbeat_timeout_seconds
                        ),
                    )
                    first_frame = False
                except TimeoutError:
                    receive_error = StreamWorkerExecutionError(
                        (
                            "Local stream worker did not send an initial response"
                            if first_frame
                            else "Local stream worker stopped responding"
                        ),
                        error_code="stream_worker_timeout",
                    )
                    break
                except asyncio.IncompleteReadError:
                    receive_error = StreamWorkerExecutionError(
                        "Local stream worker disconnected before completion"
                    )
                    break

                frame_type = frame.get("type")
                if frame_type == "heartbeat":
                    await lease.release()
                    continue
                if frame_type == "event":
                    raw_event = frame.get("event")
                    if not isinstance(raw_event, dict):
                        receive_error = StreamWorkerExecutionError(
                            "Local stream worker returned an invalid event"
                        )
                        await lease.release()
                        break
                    event = await _execution_event_from_dict(raw_event)
                    if event.type in _TERMINAL_EVENT_TYPES:
                        receive_error = StreamWorkerExecutionError(
                            "Local stream worker sent a terminal event in a "
                            "non-terminal frame"
                        )
                        await lease.release()
                        break
                    await relay.put(_RelayedEvent(event=event, lease=lease))
                    lease_forwarded = True
                    continue
                if frame_type == "terminal":
                    raw_event = frame.get("event")
                    if not isinstance(raw_event, dict):
                        receive_error = StreamWorkerExecutionError(
                            "Local stream worker returned an invalid terminal event"
                        )
                        await lease.release()
                        break
                    event = await _execution_event_from_dict(raw_event)
                    if event.type not in _TERMINAL_EVENT_TYPES:
                        receive_error = StreamWorkerExecutionError(
                            "Local stream worker terminal frame did not contain a "
                            "terminal event"
                        )
                        await lease.release()
                        break
                    await relay.put(_RelayedEvent(event=event, lease=lease))
                    lease_forwarded = True
                    break
                if frame_type == "complete":
                    await lease.release()
                    break
                if frame_type == "error":
                    message = frame.get("message")
                    error_code = frame.get("error_code")
                    receive_error = StreamWorkerExecutionError(
                        (
                            message
                            if isinstance(message, str) and message
                            else "Local stream worker execution failed"
                        ),
                        error_code=(
                            error_code
                            if isinstance(error_code, str) and error_code
                            else None
                        ),
                    )
                    await lease.release()
                    break
                receive_error = StreamWorkerExecutionError(
                    f"Unknown local stream worker frame: {frame_type!r}"
                )
                await lease.release()
                break
        except asyncio.CancelledError:
            if lease is not None and not lease_forwarded:
                await lease.release()
            raise
        except Exception as error:
            if lease is not None and not lease_forwarded:
                await lease.release()
            receive_error = StreamWorkerExecutionError(
                f"Invalid local stream worker response: {error}"
            )

        await relay.put(_RELAY_COMPLETE)
        return receive_error

    @staticmethod
    async def _drain_events(
        relay: asyncio.Queue[_RelayedEvent | object],
        emitter: ResultEmitter,
    ) -> None:
        """Deliver bounded relayed events in order on an independent task."""
        try:
            while True:
                item = await relay.get()
                if item is _RELAY_COMPLETE:
                    return
                if not isinstance(item, _RelayedEvent):
                    raise StreamWorkerExecutionError("Invalid local event relay item")
                try:
                    await emitter.emit(item.event)
                finally:
                    await item.lease.release()
        finally:
            while True:
                try:
                    pending = relay.get_nowait()
                except asyncio.QueueEmpty:
                    break
                if isinstance(pending, _RelayedEvent):
                    await pending.lease.release()


async def write_frame(
    writer: asyncio.StreamWriter,
    payload: dict[str, Any],
    *,
    max_bytes: int = _MAX_FRAME_BYTES,
) -> None:
    """Write one length-prefixed JSON frame with asyncio backpressure."""
    encoded = await _CODEC_EXECUTOR.run(orjson.dumps, payload)
    if len(encoded) > max_bytes:
        raise ValueError(f"Local IPC frame exceeds {max_bytes} bytes")
    writer.write(len(encoded).to_bytes(_FRAME_HEADER_BYTES, "big") + encoded)
    await writer.drain()


async def write_raw_frame(
    writer: asyncio.StreamWriter,
    payload: bytes,
    *,
    max_bytes: int,
) -> None:
    """Write one bounded binary frame without JSON transformation."""
    if not payload or len(payload) > max_bytes:
        raise StreamWorkerExecutionError(
            f"Invalid local IPC raw frame size: {len(payload)}"
        )
    writer.write(len(payload).to_bytes(_FRAME_HEADER_BYTES, "big") + payload)
    await writer.drain()


async def read_raw_frame(
    reader: asyncio.StreamReader,
    *,
    max_bytes: int,
) -> bytes:
    """Read one bounded binary frame without spending codec CPU."""
    header = await reader.readexactly(_FRAME_HEADER_BYTES)
    size = int.from_bytes(header, "big")
    if size <= 0 or size > max_bytes:
        raise StreamWorkerExecutionError(f"Invalid local IPC raw frame size: {size}")
    return await reader.readexactly(size)


async def read_admitted_raw_frame(
    reader: asyncio.StreamReader,
    *,
    max_bytes: int,
    admission: StreamRelayByteAdmission,
) -> tuple[bytes, ByteLease]:
    """Read one raw frame while retaining its shared Web byte lease."""
    header = await reader.readexactly(_FRAME_HEADER_BYTES)
    size = int.from_bytes(header, "big")
    if size <= 0 or size > max_bytes:
        raise StreamWorkerExecutionError(f"Invalid local IPC raw frame size: {size}")
    lease = await admission.acquire(size)
    try:
        return await reader.readexactly(size), lease
    except BaseException:
        await lease.release()
        raise


async def read_frame(reader: asyncio.StreamReader) -> dict[str, Any]:
    """Read and validate one length-prefixed JSON object."""
    payload, _ = await _read_frame_with_size(reader)
    return payload


async def discard_frame(reader: asyncio.StreamReader) -> None:
    """Consume one bounded IPC frame without spending CPU decoding its JSON."""
    header = await reader.readexactly(_FRAME_HEADER_BYTES)
    size = int.from_bytes(header, "big")
    if size <= 0 or size > _MAX_FRAME_BYTES:
        raise StreamWorkerExecutionError(f"Invalid local IPC frame size: {size}")
    await reader.readexactly(size)


async def _read_frame_with_size(
    reader: asyncio.StreamReader,
) -> tuple[dict[str, Any], int]:
    """Read one frame and keep its size for bounded CPU deserialization."""
    header = await reader.readexactly(_FRAME_HEADER_BYTES)
    size = int.from_bytes(header, "big")
    if size <= 0 or size > _MAX_FRAME_BYTES:
        raise StreamWorkerExecutionError(f"Invalid local IPC frame size: {size}")
    encoded = await reader.readexactly(size)
    payload = await _CODEC_EXECUTOR.run(orjson.loads, encoded)
    if not isinstance(payload, dict):
        raise StreamWorkerExecutionError("Local IPC frame must be a JSON object")
    return payload, size


async def _read_admitted_frame(
    reader: asyncio.StreamReader,
    admission: StreamRelayByteAdmission,
    event_admission: LoopLocalTokenBucket,
) -> tuple[dict[str, Any], ByteLease]:
    """Reserve process bytes and event CPU before decoding an IPC frame."""
    header = await reader.readexactly(_FRAME_HEADER_BYTES)
    size = int.from_bytes(header, "big")
    if size <= 0 or size > _MAX_FRAME_BYTES:
        raise StreamWorkerExecutionError(f"Invalid local IPC frame size: {size}")
    lease = await admission.acquire(size)
    try:
        encoded = await reader.readexactly(size)
        if encoded == _HEARTBEAT_FRAME_BYTES:
            payload = {"type": "heartbeat"}
        else:
            # This process-wide await propagates aggregate small-frame pressure
            # back through the per-stream relay and UDS before codec CPU runs.
            await event_admission.acquire()
            payload = await _CODEC_EXECUTOR.run(orjson.loads, encoded)
        if not isinstance(payload, dict):
            raise StreamWorkerExecutionError("Local IPC frame must be a JSON object")
        return payload, lease
    except BaseException:
        await lease.release()
        raise


async def _execution_event_from_dict(
    raw_event: dict[str, Any],
) -> ExecutionEvent:
    """Construct every relayed event outside the sole Web event loop."""
    return await _CODEC_EXECUTOR.run(ExecutionEvent.from_dict, raw_event)


stream_execution_client = StreamExecutionClient()


class RemoteProjectionEmitter(BaseResultEmitter):
    """Move event side effects to the worker, then feed an explicit transport."""

    def __init__(
        self,
        *,
        task_id: int,
        subtask_id: int,
        user_id: int | None,
        source: str,
        wrapped: ResultEmitter | None = None,
        executor_name: str | None = None,
        executor_namespace: str | None = None,
    ) -> None:
        super().__init__(task_id, subtask_id)
        self._user_id = user_id
        self._source = source
        self._wrapped = wrapped
        self._executor_name = executor_name
        self._executor_namespace = executor_namespace

    async def emit(self, event: ExecutionEvent) -> None:
        await stream_execution_client.dispatch_execution_event(
            event,
            user_id=self._user_id,
            source=self._source,
            executor_name=self._executor_name,
            executor_namespace=self._executor_namespace,
        )
        if self._wrapped is not None:
            await self._wrapped.emit(event)

    async def close(self) -> None:
        if self._wrapped is not None:
            await self._wrapped.close()
