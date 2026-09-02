# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Thin Web-side client for worker-owned OpenAPI Responses execution."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import AsyncIterator, Protocol

import orjson

from app.core.byte_admission import ByteLease
from app.core.config import settings
from app.core.payload_codec import run_payload_codec
from app.services.execution.stream_client import (
    StreamRelayByteAdmission,
    StreamWorkerExecutionError,
    StreamWorkerUnavailableError,
    read_admitted_raw_frame,
    read_frame,
    web_stream_relay_byte_admission,
    web_stream_rpc_admission,
    write_frame,
)
from shared.models import ExecutionRequest

from .worker_protocol import (
    OPENAPI_STREAM_FRAME_COMPLETE,
    OPENAPI_STREAM_FRAME_ERROR,
    OPENAPI_STREAM_FRAME_HEARTBEAT,
    OPENAPI_STREAM_FRAME_SSE,
    OPENAPI_STREAM_MAX_DURATION_SECONDS,
    OPENAPI_STREAM_MAX_FRAME_BYTES,
    OPENAPI_STREAM_MAX_TOTAL_BYTES,
    OpenAPIExecutionOutcome,
    OpenAPIStreamSpec,
)

_CONNECT_TIMEOUT_SECONDS = 3.0
_FIRST_FRAME_TIMEOUT_SECONDS = 10.0
_HEARTBEAT_TIMEOUT_SECONDS = 20.0
_FRAME_WRITE_TIMEOUT_SECONDS = 20.0
_CLOSE_TIMEOUT_SECONDS = 1.0


class StreamAdmission(Protocol):
    """Synchronous process-local admission shared by long-lived Web relays."""

    def acquire(self) -> None: ...

    def release(self) -> None: ...


def _stream_envelope(
    request: ExecutionRequest,
    spec: OpenAPIStreamSpec,
) -> dict[str, object]:
    return {
        "type": "openapi_stream",
        "request": request.to_dict(),
        "response": spec.to_dict(),
    }


def _execute_envelope(
    request: ExecutionRequest,
    background: bool,
) -> dict[str, object]:
    return {
        "type": "openapi_execute",
        "request": request.to_dict(),
        "background": background,
    }


class OpenAPIWorkerClient:
    """Forward prepared executions and return worker-produced bytes unchanged."""

    def __init__(
        self,
        socket_path: str | Path | None = None,
        *,
        connect_timeout_seconds: float = _CONNECT_TIMEOUT_SECONDS,
        first_frame_timeout_seconds: float = _FIRST_FRAME_TIMEOUT_SECONDS,
        heartbeat_timeout_seconds: float = _HEARTBEAT_TIMEOUT_SECONDS,
        max_duration_seconds: float = OPENAPI_STREAM_MAX_DURATION_SECONDS,
        max_frame_bytes: int = OPENAPI_STREAM_MAX_FRAME_BYTES,
        max_total_bytes: int = OPENAPI_STREAM_MAX_TOTAL_BYTES,
        admission: StreamAdmission | None = None,
        relay_byte_admission: StreamRelayByteAdmission | None = None,
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
            raise ValueError("OpenAPI worker timeouts must be positive")
        if max_frame_bytes <= 1 or max_total_bytes < max_frame_bytes:
            raise ValueError("Invalid OpenAPI worker byte limits")
        self._socket_path = Path(socket_path) if socket_path is not None else None
        self._connect_timeout_seconds = connect_timeout_seconds
        self._first_frame_timeout_seconds = first_frame_timeout_seconds
        self._heartbeat_timeout_seconds = heartbeat_timeout_seconds
        self._max_duration_seconds = max_duration_seconds
        self._max_frame_bytes = max_frame_bytes
        self._max_total_bytes = max_total_bytes
        self._admission = admission or web_stream_rpc_admission
        self._relay_byte_admission = (
            relay_byte_admission or web_stream_relay_byte_admission
        )

    @property
    def socket_path(self) -> Path:
        return self._socket_path or Path(settings.STREAM_WORKER_SOCKET_PATH)

    async def stream(
        self,
        request: ExecutionRequest,
        spec: OpenAPIStreamSpec,
    ) -> AsyncIterator[bytes]:
        """Yield framed SSE payloads without JSON or Pydantic reconstruction."""
        self._admission.acquire()
        writer: asyncio.StreamWriter | None = None
        try:
            envelope = await run_payload_codec(
                _stream_envelope,
                request,
                spec,
                payload_hint=(request, spec),
                force_offload=True,
            )
            reader, writer = await self._open_connection()
            await self._write_request(
                writer,
                envelope,
            )
            loop = asyncio.get_running_loop()
            deadline = loop.time() + self._max_duration_seconds
            first_frame = True
            total_bytes = 0
            while True:
                lease: ByteLease | None = None
                try:
                    remaining = deadline - loop.time()
                    if remaining <= 0:
                        raise StreamWorkerExecutionError(
                            "OpenAPI stream exceeded its total duration",
                            error_code="openapi_stream_duration_exceeded",
                        )
                    frame, lease = await self._read_stream_frame(
                        reader,
                        timeout=min(
                            remaining,
                            (
                                self._first_frame_timeout_seconds
                                if first_frame
                                else self._heartbeat_timeout_seconds
                            ),
                        ),
                        first_frame=first_frame,
                    )
                    first_frame = False
                    if frame.startswith(b"{"):
                        raise await self._decode_worker_error(frame)
                    marker = frame[:1]
                    payload = frame[1:]
                    if marker == OPENAPI_STREAM_FRAME_HEARTBEAT:
                        if payload:
                            raise StreamWorkerExecutionError(
                                "Invalid OpenAPI heartbeat frame"
                            )
                        continue
                    if marker == OPENAPI_STREAM_FRAME_COMPLETE:
                        if payload:
                            raise StreamWorkerExecutionError(
                                "Invalid OpenAPI completion frame"
                            )
                        return
                    if marker == OPENAPI_STREAM_FRAME_ERROR:
                        raise await self._decode_worker_error(payload)
                    if marker != OPENAPI_STREAM_FRAME_SSE or not payload:
                        raise StreamWorkerExecutionError(
                            "Invalid OpenAPI stream worker frame"
                        )
                    total_bytes += len(payload)
                    if total_bytes > self._max_total_bytes:
                        raise StreamWorkerExecutionError(
                            "OpenAPI stream exceeded its total byte limit",
                            error_code="openapi_stream_total_too_large",
                        )
                    yield payload
                finally:
                    if lease is not None:
                        await lease.release()
        finally:
            if writer is not None:
                await self._close_writer(writer)
            self._admission.release()

    async def execute(
        self,
        request: ExecutionRequest,
        *,
        background: bool,
    ) -> OpenAPIExecutionOutcome:
        """Run or start one non-stream execution entirely in the worker."""
        self._admission.acquire()
        writer: asyncio.StreamWriter | None = None
        try:
            envelope = await run_payload_codec(
                _execute_envelope,
                request,
                background,
                payload_hint=request,
                force_offload=True,
            )
            reader, writer = await self._open_connection()
            await self._write_request(
                writer,
                envelope,
            )
            try:
                response = await asyncio.wait_for(
                    read_frame(reader),
                    timeout=self._max_duration_seconds,
                )
            except TimeoutError as error:
                raise StreamWorkerExecutionError(
                    "OpenAPI execution exceeded its total duration",
                    error_code="openapi_execution_duration_exceeded",
                ) from error
            except asyncio.IncompleteReadError as error:
                raise StreamWorkerExecutionError(
                    "OpenAPI execution worker disconnected"
                ) from error

            if response.get("type") == "openapi_result" and isinstance(
                response.get("result"), dict
            ):
                try:
                    return OpenAPIExecutionOutcome.from_dict(response["result"])
                except ValueError as error:
                    raise StreamWorkerExecutionError(
                        "OpenAPI execution worker returned an invalid result"
                    ) from error
            if response.get("type") == "error":
                raise self._error_from_control_frame(response)
            raise StreamWorkerExecutionError(
                "OpenAPI execution worker returned an unknown response"
            )
        finally:
            if writer is not None:
                await self._close_writer(writer)
            self._admission.release()

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

    async def _write_request(
        self,
        writer: asyncio.StreamWriter,
        payload: dict[str, object],
    ) -> None:
        try:
            await asyncio.wait_for(
                write_frame(writer, payload),
                timeout=_FRAME_WRITE_TIMEOUT_SECONDS,
            )
        except TimeoutError as error:
            raise StreamWorkerExecutionError(
                "Timed out sending OpenAPI request to local worker",
                error_code="stream_worker_timeout",
            ) from error
        except (ConnectionError, OSError) as error:
            raise StreamWorkerExecutionError(
                "Local stream worker disconnected while receiving OpenAPI request"
            ) from error

    async def _read_stream_frame(
        self,
        reader: asyncio.StreamReader,
        *,
        timeout: float,
        first_frame: bool,
    ) -> tuple[bytes, ByteLease]:
        try:
            return await asyncio.wait_for(
                read_admitted_raw_frame(
                    reader,
                    max_bytes=self._max_frame_bytes,
                    admission=self._relay_byte_admission,
                ),
                timeout=timeout,
            )
        except TimeoutError as error:
            message = (
                "OpenAPI worker did not send an initial response"
                if first_frame
                else "OpenAPI worker stopped responding"
            )
            raise StreamWorkerExecutionError(
                message,
                error_code="stream_worker_timeout",
            ) from error
        except asyncio.IncompleteReadError as error:
            raise StreamWorkerExecutionError(
                "OpenAPI worker disconnected before stream completion"
            ) from error

    @staticmethod
    async def _decode_worker_error(payload: bytes) -> StreamWorkerExecutionError:
        if not payload:
            return StreamWorkerExecutionError("OpenAPI stream worker failed")
        try:
            value = await run_payload_codec(
                orjson.loads,
                payload,
                payload_hint=payload,
                force_offload=True,
            )
        except Exception as error:
            return StreamWorkerExecutionError(
                f"Invalid OpenAPI worker error frame: {error}"
            )
        if not isinstance(value, dict):
            return StreamWorkerExecutionError("Invalid OpenAPI worker error frame")
        return OpenAPIWorkerClient._error_from_control_frame(value)

    @staticmethod
    def _error_from_control_frame(
        value: dict[str, object],
    ) -> StreamWorkerExecutionError:
        message = value.get("message")
        error_code = value.get("error_code")
        return StreamWorkerExecutionError(
            (
                message
                if isinstance(message, str) and message
                else "OpenAPI worker failed"
            ),
            error_code=error_code if isinstance(error_code, str) else None,
        )

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


openapi_worker_client = OpenAPIWorkerClient()
