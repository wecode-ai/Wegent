# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Thin Web-side relay for worker-owned non-Execution streams."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

import orjson

from app.core.byte_admission import ByteLease
from app.core.config import settings
from app.core.payload_codec import run_payload_codec

from .stream_client import (
    StreamRelayByteAdmission,
    StreamWorkerExecutionError,
    StreamWorkerUnavailableError,
    read_admitted_raw_frame,
    web_stream_relay_byte_admission,
    web_stream_rpc_admission,
    write_frame,
)
from .web_stream_protocol import (
    WEB_EXECUTE_MAX_RESULT_BYTES,
    WEB_EXECUTE_OPERATIONS,
    WEB_RAW_STREAM_OPERATIONS,
    WEB_STREAM_FRAME_COMPLETE,
    WEB_STREAM_FRAME_DATA,
    WEB_STREAM_FRAME_ERROR,
    WEB_STREAM_FRAME_HEARTBEAT,
    WEB_STREAM_FRAME_METADATA,
    WEB_STREAM_MAX_DURATION_SECONDS,
    WEB_STREAM_MAX_FRAME_BYTES,
    WEB_STREAM_MAX_TOTAL_BYTES,
    WEB_STREAM_OPERATIONS,
)

_FRAME_HEADER_BYTES = 4
_CONNECT_TIMEOUT_SECONDS = 3.0
_FIRST_FRAME_TIMEOUT_SECONDS = 10.0
_HEARTBEAT_TIMEOUT_SECONDS = 20.0
_FRAME_WRITE_TIMEOUT_SECONDS = 20.0
_CLOSE_TIMEOUT_SECONDS = 1.0
_SSE_HEARTBEAT = b": keep-alive\n\n"


class StreamAdmission(Protocol):
    def acquire(self) -> None: ...

    def release(self) -> None: ...


def _stream_envelope(
    operation: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    return {
        "type": "web_stream",
        "operation": operation,
        "payload": payload,
    }


def _execute_envelope(
    operation: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    return {
        "type": "web_execute",
        "operation": operation,
        "payload": payload,
    }


def _decode_error_payload(payload: bytes) -> dict[str, Any]:
    value = orjson.loads(payload)
    if not isinstance(value, dict):
        raise ValueError("Worker error must be a JSON object")
    return value


@dataclass(frozen=True)
class WebRawStreamResponse:
    metadata: dict[str, Any]
    body: AsyncIterator[bytes]


class _WebRawStreamBody:
    def __init__(
        self,
        client: WebStreamWorkerClient,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
        *,
        deadline: float,
    ) -> None:
        self._client = client
        self._reader = reader
        self._writer = writer
        self._deadline = deadline
        self._total_bytes = 0
        self._lease: ByteLease | None = None
        self._closed = False

    def __aiter__(self) -> _WebRawStreamBody:
        return self

    async def __anext__(self) -> bytes:
        if self._closed:
            raise StopAsyncIteration
        if self._lease is not None:
            await self._lease.release()
            self._lease = None

        loop = asyncio.get_running_loop()
        try:
            while True:
                remaining = self._deadline - loop.time()
                if remaining <= 0:
                    raise StreamWorkerExecutionError(
                        "Web raw stream exceeded its total duration",
                        error_code="web_stream_duration_exceeded",
                    )
                marker, data, lease = await self._client._read_frame(
                    self._reader,
                    min(remaining, self._client._heartbeat_timeout_seconds),
                )
                if marker == WEB_STREAM_FRAME_HEARTBEAT:
                    await lease.release()
                    if data:
                        raise StreamWorkerExecutionError(
                            "Invalid Web raw stream heartbeat frame"
                        )
                    continue
                if marker == WEB_STREAM_FRAME_COMPLETE:
                    await lease.release()
                    if data:
                        raise StreamWorkerExecutionError(
                            "Invalid Web raw stream completion frame"
                        )
                    await self.aclose()
                    raise StopAsyncIteration
                if marker == WEB_STREAM_FRAME_ERROR or marker == b"{":
                    try:
                        error_payload = (
                            data if marker == WEB_STREAM_FRAME_ERROR else marker + data
                        )
                        raise await self._client._worker_error(error_payload)
                    finally:
                        await lease.release()
                if marker != WEB_STREAM_FRAME_DATA or not data:
                    await lease.release()
                    raise StreamWorkerExecutionError(
                        "Invalid Web raw stream worker frame"
                    )
                self._total_bytes += len(data)
                if self._total_bytes > self._client._max_total_bytes:
                    await lease.release()
                    raise StreamWorkerExecutionError(
                        "Web raw stream exceeded its total byte limit",
                        error_code="web_stream_total_too_large",
                    )
                self._lease = lease
                return data
        except StopAsyncIteration:
            raise
        except BaseException:
            await self.aclose()
            raise

    async def aclose(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._lease is not None:
            await self._lease.release()
            self._lease = None
        await self._client._close_writer(self._writer)
        self._client._admission.release()


class WebStreamWorkerClient:
    """Forward one prepared stream and relay worker bytes without projection."""

    def __init__(
        self,
        socket_path: str | Path | None = None,
        *,
        connect_timeout_seconds: float = _CONNECT_TIMEOUT_SECONDS,
        first_frame_timeout_seconds: float = _FIRST_FRAME_TIMEOUT_SECONDS,
        heartbeat_timeout_seconds: float = _HEARTBEAT_TIMEOUT_SECONDS,
        max_duration_seconds: float = WEB_STREAM_MAX_DURATION_SECONDS,
        max_frame_bytes: int = WEB_STREAM_MAX_FRAME_BYTES,
        max_total_bytes: int = WEB_STREAM_MAX_TOTAL_BYTES,
        admission: StreamAdmission | None = None,
        byte_admission: StreamRelayByteAdmission | None = None,
    ) -> None:
        if (
            min(
                connect_timeout_seconds,
                first_frame_timeout_seconds,
                heartbeat_timeout_seconds,
                max_duration_seconds,
            )
            <= 0
        ):
            raise ValueError("Web stream timeouts must be positive")
        if max_frame_bytes <= 1 or max_total_bytes < max_frame_bytes:
            raise ValueError("Invalid Web stream byte limits")
        self._socket_path = Path(socket_path) if socket_path is not None else None
        self._connect_timeout_seconds = connect_timeout_seconds
        self._first_frame_timeout_seconds = first_frame_timeout_seconds
        self._heartbeat_timeout_seconds = heartbeat_timeout_seconds
        self._max_duration_seconds = max_duration_seconds
        self._max_frame_bytes = max_frame_bytes
        self._max_total_bytes = max_total_bytes
        self._admission = admission or web_stream_rpc_admission
        self._byte_admission = byte_admission or web_stream_relay_byte_admission

    @property
    def socket_path(self) -> Path:
        return self._socket_path or Path(settings.STREAM_WORKER_SOCKET_PATH)

    async def stream(
        self,
        operation: str,
        payload: dict[str, Any],
    ) -> AsyncIterator[bytes]:
        """Yield worker-produced bytes with connection, time and byte bounds."""
        if operation not in WEB_STREAM_OPERATIONS:
            raise ValueError(f"Unknown Web stream operation: {operation}")
        if not isinstance(payload, dict):
            raise TypeError("payload must be a dictionary")

        self._admission.acquire()
        writer: asyncio.StreamWriter | None = None
        try:
            envelope = await run_payload_codec(
                _stream_envelope,
                operation,
                payload,
                payload_hint=payload,
                force_offload=True,
            )
            reader, writer = await self._open_connection()
            try:
                await asyncio.wait_for(
                    write_frame(writer, envelope),
                    timeout=_FRAME_WRITE_TIMEOUT_SECONDS,
                )
            except TimeoutError as error:
                raise StreamWorkerExecutionError(
                    "Timed out sending Web stream request to local worker",
                    error_code="web_stream_worker_timeout",
                ) from error

            loop = asyncio.get_running_loop()
            deadline = loop.time() + self._max_duration_seconds
            first_payload_deadline = loop.time() + self._first_frame_timeout_seconds
            first_frame = True
            total_bytes = 0
            while True:
                remaining = deadline - loop.time()
                if remaining <= 0:
                    raise StreamWorkerExecutionError(
                        "Web stream exceeded its total duration",
                        error_code="web_stream_duration_exceeded",
                    )
                first_payload_remaining = first_payload_deadline - loop.time()
                if first_frame and first_payload_remaining <= 0:
                    raise StreamWorkerExecutionError(
                        "Web stream did not send its first payload in time",
                        error_code="web_stream_first_byte_timeout",
                    )
                timeout = min(
                    remaining,
                    (
                        first_payload_remaining
                        if first_frame
                        else self._heartbeat_timeout_seconds
                    ),
                )
                marker, data, lease = await self._read_frame(reader, timeout)
                if marker == WEB_STREAM_FRAME_HEARTBEAT:
                    await lease.release()
                    if data:
                        raise StreamWorkerExecutionError(
                            "Invalid Web stream heartbeat frame"
                        )
                    yield _SSE_HEARTBEAT
                    continue
                first_frame = False
                if marker == WEB_STREAM_FRAME_COMPLETE:
                    await lease.release()
                    if data:
                        raise StreamWorkerExecutionError(
                            "Invalid Web stream completion frame"
                        )
                    return
                if marker == WEB_STREAM_FRAME_ERROR or marker == b"{":
                    try:
                        error_payload = (
                            data if marker == WEB_STREAM_FRAME_ERROR else marker + data
                        )
                        raise await self._worker_error(error_payload)
                    finally:
                        await lease.release()
                if marker != WEB_STREAM_FRAME_DATA or not data:
                    await lease.release()
                    raise StreamWorkerExecutionError("Invalid Web stream worker frame")
                total_bytes += len(data)
                if total_bytes > self._max_total_bytes:
                    await lease.release()
                    raise StreamWorkerExecutionError(
                        "Web stream exceeded its total byte limit",
                        error_code="web_stream_total_too_large",
                    )
                try:
                    yield data
                finally:
                    await lease.release()
        finally:
            if writer is not None:
                await self._close_writer(writer)
            self._admission.release()

    async def open_raw_stream(
        self,
        operation: str,
        payload: dict[str, Any],
    ) -> WebRawStreamResponse:
        """Open a worker-owned binary stream after one bounded metadata frame."""
        if operation not in WEB_RAW_STREAM_OPERATIONS:
            raise ValueError(f"Unknown Web raw stream operation: {operation}")
        if not isinstance(payload, dict):
            raise TypeError("payload must be a dictionary")

        self._admission.acquire()
        writer: asyncio.StreamWriter | None = None
        lease: ByteLease | None = None
        transferred = False
        try:
            envelope = await run_payload_codec(
                _stream_envelope,
                operation,
                payload,
                payload_hint=payload,
                force_offload=True,
            )
            reader, writer = await self._open_connection()
            try:
                await asyncio.wait_for(
                    write_frame(writer, envelope),
                    timeout=_FRAME_WRITE_TIMEOUT_SECONDS,
                )
            except TimeoutError as error:
                raise StreamWorkerExecutionError(
                    "Timed out sending Web raw stream request to local worker",
                    error_code="web_stream_worker_timeout",
                ) from error

            loop = asyncio.get_running_loop()
            deadline = loop.time() + self._max_duration_seconds
            first_payload_deadline = loop.time() + self._first_frame_timeout_seconds
            while True:
                remaining = min(
                    deadline - loop.time(),
                    first_payload_deadline - loop.time(),
                )
                if remaining <= 0:
                    raise StreamWorkerExecutionError(
                        "Web raw stream did not send metadata before its "
                        "first-byte deadline",
                        error_code="web_stream_first_byte_timeout",
                    )
                try:
                    marker, data, lease = await self._read_frame(reader, remaining)
                except StreamWorkerExecutionError as error:
                    if error.error_code == "web_stream_worker_timeout":
                        raise StreamWorkerExecutionError(
                            "Web raw stream did not send metadata before its "
                            "first-byte deadline",
                            error_code="web_stream_first_byte_timeout",
                        ) from error
                    raise
                if marker == WEB_STREAM_FRAME_HEARTBEAT:
                    if data:
                        raise StreamWorkerExecutionError(
                            "Invalid Web raw stream heartbeat frame"
                        )
                    await lease.release()
                    lease = None
                    continue
                if marker == WEB_STREAM_FRAME_ERROR or marker == b"{":
                    error_payload = (
                        data if marker == WEB_STREAM_FRAME_ERROR else marker + data
                    )
                    raise await self._worker_error(error_payload)
                if marker != WEB_STREAM_FRAME_METADATA or not data:
                    raise StreamWorkerExecutionError(
                        "Web raw stream worker did not send metadata"
                    )
                metadata = await run_payload_codec(
                    _decode_error_payload,
                    data,
                    payload_hint=data,
                    force_offload=True,
                )
                await lease.release()
                lease = None
                body = _WebRawStreamBody(
                    self,
                    reader,
                    writer,
                    deadline=deadline,
                )
                transferred = True
                return WebRawStreamResponse(metadata=metadata, body=body)
        finally:
            if lease is not None:
                await lease.release()
            if not transferred:
                if writer is not None:
                    await self._close_writer(writer)
                self._admission.release()

    async def execute(
        self,
        operation: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        """Run one worker-owned point operation with hard time and byte bounds."""
        if operation not in WEB_EXECUTE_OPERATIONS:
            raise ValueError(f"Unknown Web execute operation: {operation}")
        if not isinstance(payload, dict):
            raise TypeError("payload must be a dictionary")

        self._admission.acquire()
        writer: asyncio.StreamWriter | None = None
        lease: ByteLease | None = None
        try:
            envelope = await run_payload_codec(
                _execute_envelope,
                operation,
                payload,
                payload_hint=payload,
                force_offload=True,
            )
            reader, writer = await self._open_connection()
            try:
                await asyncio.wait_for(
                    write_frame(writer, envelope),
                    timeout=_FRAME_WRITE_TIMEOUT_SECONDS,
                )
            except TimeoutError as error:
                raise StreamWorkerExecutionError(
                    "Timed out sending Web execute request to local worker",
                    error_code="web_execute_worker_timeout",
                ) from error

            loop = asyncio.get_running_loop()
            deadline = loop.time() + self._max_duration_seconds
            first_payload_deadline = loop.time() + self._first_frame_timeout_seconds
            first_frame = True
            while True:
                remaining = deadline - loop.time()
                if remaining <= 0:
                    raise StreamWorkerExecutionError(
                        "Web execute operation exceeded its total duration",
                        error_code="web_execute_duration_exceeded",
                    )
                first_payload_remaining = first_payload_deadline - loop.time()
                if first_frame and first_payload_remaining <= 0:
                    raise StreamWorkerExecutionError(
                        "Web execute operation did not return its first payload in time",
                        error_code="web_execute_first_byte_timeout",
                    )
                timeout = min(
                    remaining,
                    (
                        first_payload_remaining
                        if first_frame
                        else self._heartbeat_timeout_seconds
                    ),
                )
                frame, lease = await self._read_execute_frame(reader, timeout)
                marker = frame[:1]
                data = frame[1:]
                if marker == WEB_STREAM_FRAME_HEARTBEAT:
                    if data:
                        raise StreamWorkerExecutionError(
                            "Invalid Web execute heartbeat frame"
                        )
                    await lease.release()
                    lease = None
                    continue
                first_frame = False
                if marker == WEB_STREAM_FRAME_ERROR:
                    raise await self._worker_error(data)
                if marker != WEB_STREAM_FRAME_DATA or not data:
                    raise StreamWorkerExecutionError(
                        "Invalid Web execute worker result frame"
                    )
                result = await run_payload_codec(
                    orjson.loads,
                    data,
                    payload_hint=data,
                    force_offload=True,
                )
                if not isinstance(result, dict):
                    raise StreamWorkerExecutionError(
                        "Web execute worker result must be an object"
                    )
                return result
        except asyncio.IncompleteReadError as error:
            raise StreamWorkerExecutionError(
                "Local Web execute worker disconnected before completion"
            ) from error
        finally:
            if lease is not None:
                await lease.release()
            if writer is not None:
                await self._close_writer(writer)
            self._admission.release()

    async def _read_execute_frame(
        self,
        reader: asyncio.StreamReader,
        timeout: float,
    ) -> tuple[bytes, ByteLease]:
        try:
            return await asyncio.wait_for(
                read_admitted_raw_frame(
                    reader,
                    max_bytes=min(
                        self._max_frame_bytes,
                        WEB_EXECUTE_MAX_RESULT_BYTES,
                    ),
                    admission=self._byte_admission,
                ),
                timeout=timeout,
            )
        except TimeoutError as error:
            raise StreamWorkerExecutionError(
                "Local Web execute worker stopped responding",
                error_code="web_execute_worker_timeout",
            ) from error

    async def _read_frame(
        self,
        reader: asyncio.StreamReader,
        timeout: float,
    ) -> tuple[bytes, bytes, ByteLease]:
        try:
            return await asyncio.wait_for(
                self._read_admitted_frame(reader),
                timeout=timeout,
            )
        except TimeoutError as error:
            raise StreamWorkerExecutionError(
                "Local Web stream worker stopped responding",
                error_code="web_stream_worker_timeout",
            ) from error
        except asyncio.IncompleteReadError as error:
            raise StreamWorkerExecutionError(
                "Local Web stream worker disconnected before completion"
            ) from error

    async def _read_admitted_frame(
        self,
        reader: asyncio.StreamReader,
    ) -> tuple[bytes, bytes, ByteLease]:
        header = await reader.readexactly(_FRAME_HEADER_BYTES)
        size = int.from_bytes(header, "big")
        if size <= 0 or size > self._max_frame_bytes:
            raise StreamWorkerExecutionError(
                f"Invalid local Web stream frame size: {size}"
            )
        lease = await self._byte_admission.acquire(size)
        try:
            marker = await reader.readexactly(1)
            data = await reader.readexactly(size - 1) if size > 1 else b""
            return marker, data, lease
        except BaseException:
            await lease.release()
            raise

    async def _worker_error(self, payload: bytes) -> StreamWorkerExecutionError:
        try:
            value = await run_payload_codec(
                _decode_error_payload,
                payload,
                payload_hint=payload,
                force_offload=True,
            )
        except Exception as error:
            return StreamWorkerExecutionError(
                f"Invalid Web stream worker error response: {error}"
            )
        message = value.get("message")
        error_code = value.get("error_code")
        status_code = value.get("status_code")
        return StreamWorkerExecutionError(
            message if isinstance(message, str) and message else "Web stream failed",
            error_code=error_code if isinstance(error_code, str) else None,
            status_code=(
                status_code
                if isinstance(status_code, int) and 400 <= status_code <= 599
                else None
            ),
        )

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


web_stream_worker_client = WebStreamWorkerClient()
