# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Bounded Pod-local RPC client for the isolated channel process."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import orjson

from app.core.bounded_executor import BoundedExecutor
from app.core.config import settings
from shared.models import ExecutionEvent

_FRAME_HEADER_BYTES = 4
CHANNEL_WORKER_MAX_FRAME_BYTES = 4 * 1024 * 1024
CHANNEL_WORKER_MAX_CONNECTIONS = 64
CHANNEL_COMPLETION_CONTENT_MAX_CHARS = 4000
_CONNECT_TIMEOUT_SECONDS = 2.0
_RESPONSE_TIMEOUT_SECONDS = 125.0
_FRAME_WRITE_TIMEOUT_SECONDS = 5.0
_CLOSE_TIMEOUT_SECONDS = 1.0
_CODEC_EXECUTOR = BoundedExecutor(
    max_workers=2,
    max_in_flight=4,
    max_waiters=CHANNEL_WORKER_MAX_CONNECTIONS,
    thread_name_prefix="wegent-channel-ipc-codec",
)


class ChannelWorkerUnavailableError(RuntimeError):
    """Raised when the required Pod-local channel process is unavailable."""


class ChannelWorkerError(RuntimeError):
    """Raised when the channel process rejects or cannot finish an operation."""

    def __init__(self, message: str, *, error_code: str | None = None) -> None:
        super().__init__(message)
        self.error_code = error_code


class ChannelWorkerClient:
    """Invoke channel lifecycle operations without owning providers in Web."""

    def __init__(
        self,
        socket_path: str | Path | None = None,
        *,
        connect_timeout_seconds: float = _CONNECT_TIMEOUT_SECONDS,
        response_timeout_seconds: float = _RESPONSE_TIMEOUT_SECONDS,
        frame_write_timeout_seconds: float = _FRAME_WRITE_TIMEOUT_SECONDS,
    ) -> None:
        if connect_timeout_seconds <= 0:
            raise ValueError("connect_timeout_seconds must be positive")
        if response_timeout_seconds <= 0:
            raise ValueError("response_timeout_seconds must be positive")
        if frame_write_timeout_seconds <= 0:
            raise ValueError("frame_write_timeout_seconds must be positive")
        self._socket_path = Path(socket_path) if socket_path is not None else None
        self._connect_timeout_seconds = connect_timeout_seconds
        self._response_timeout_seconds = response_timeout_seconds
        self._frame_write_timeout_seconds = frame_write_timeout_seconds

    @property
    def socket_path(self) -> Path:
        """Resolve process configuration lazily for tests and spawned workers."""
        return self._socket_path or Path(settings.CHANNEL_WORKER_SOCKET_PATH)

    async def ping(self) -> None:
        """Require one complete request/response round trip."""
        response = await self._request({"type": "ping"})
        if response != {"type": "pong"}:
            raise ChannelWorkerError("Channel worker returned an invalid ping result")

    async def reconcile(self, channel_id: int, *, force_restart: bool = False) -> bool:
        """Reconcile one provider against its authoritative database row."""
        _validate_channel_id(channel_id)
        if not isinstance(force_restart, bool):
            raise ValueError("force_restart must be a boolean")
        response = await self._request(
            {
                "type": "reconcile",
                "channel_id": channel_id,
                "force_restart": force_restart,
            }
        )
        _validate_result_response(response)
        result = response.get("result")
        if not isinstance(result, bool):
            raise ChannelWorkerError("Channel worker returned an invalid result")
        return result

    async def stop(self, channel_id: int) -> None:
        """Stop one provider in the channel process."""
        _validate_channel_id(channel_id)
        response = await self._request({"type": "stop", "channel_id": channel_id})
        _validate_result_response(response)
        if response.get("result") is not None:
            raise ChannelWorkerError("Channel worker returned an invalid stop result")

    async def status(self, channel_id: int) -> dict[str, Any] | None:
        """Return the live provider status owned by the channel process."""
        _validate_channel_id(channel_id)
        response = await self._request({"type": "status", "channel_id": channel_id})
        _validate_result_response(response)
        result = response.get("result")
        if result is not None and not isinstance(result, dict):
            raise ChannelWorkerError("Channel worker returned an invalid status")
        return result

    async def forward_event(
        self,
        *,
        task_id: int,
        subtask_id: int,
        event: ExecutionEvent,
        source: str,
    ) -> None:
        """Forward one execution event inside the provider-owning process."""
        _validate_task_coordinates(task_id, subtask_id)
        _validate_source(source)
        if not isinstance(event, ExecutionEvent):
            raise ValueError("event must be an ExecutionEvent")
        event_payload = await _CODEC_EXECUTOR.run(event.to_dict)
        response = await self._request(
            {
                "type": "forward_event",
                "task_id": task_id,
                "subtask_id": subtask_id,
                "event": event_payload,
                "source": source,
            }
        )
        _validate_result_response(response)
        if response.get("result") is not None:
            raise ChannelWorkerError(
                "Channel worker returned an invalid forward-event result"
            )

    async def task_completed(
        self,
        *,
        task_id: int,
        subtask_id: int,
        status: str,
        content: str,
        error: str | None,
    ) -> bool:
        """Finish an IM callback inside the provider-owning process."""
        _validate_task_coordinates(task_id, subtask_id)
        if status not in {"COMPLETED", "FAILED", "CANCELLED"}:
            raise ValueError("status must be COMPLETED, FAILED, or CANCELLED")
        if not isinstance(content, str):
            raise ValueError("content must be a string")
        if len(content) > CHANNEL_COMPLETION_CONTENT_MAX_CHARS:
            raise ValueError(
                "content must contain at most "
                f"{CHANNEL_COMPLETION_CONTENT_MAX_CHARS} characters"
            )
        if error is not None and (
            not isinstance(error, str)
            or len(error) > CHANNEL_COMPLETION_CONTENT_MAX_CHARS
        ):
            raise ValueError(
                "error must be None or a string of at most "
                f"{CHANNEL_COMPLETION_CONTENT_MAX_CHARS} characters"
            )
        response = await self._request(
            {
                "type": "task_completed",
                "task_id": task_id,
                "subtask_id": subtask_id,
                "status": status,
                "content": content,
                "error": error,
            }
        )
        _validate_result_response(response)
        sent = response.get("result")
        if not isinstance(sent, bool):
            raise ChannelWorkerError(
                "Channel worker returned an invalid task-completed result"
            )
        return sent

    async def runtime_local_event(
        self,
        *,
        device_id: str,
        local_task_id: str,
        source: dict[str, Any] | None,
        event: ExecutionEvent,
    ) -> None:
        """Deliver one device-runtime event to process-local IM callbacks."""
        _validate_runtime_identifier("device_id", device_id)
        _validate_runtime_identifier("local_task_id", local_task_id)
        if source is not None and not isinstance(source, dict):
            raise ValueError("source must be a dictionary or None")
        if not isinstance(event, ExecutionEvent):
            raise ValueError("event must be an ExecutionEvent")
        event_payload = await _CODEC_EXECUTOR.run(event.to_dict)
        response = await self._request(
            {
                "type": "runtime_local_event",
                "device_id": device_id,
                "local_task_id": local_task_id,
                "source": source,
                "event": event_payload,
            }
        )
        _validate_result_response(response)
        if response.get("result") is not None:
            raise ChannelWorkerError(
                "Channel worker returned an invalid runtime-local-event result"
            )

    async def send_device_notification(
        self,
        *,
        user_id: int,
        target_type: str,
        device_name: str | None,
    ) -> dict[str, Any]:
        """Send default-target notifications inside the channel process."""
        if isinstance(user_id, bool) or not isinstance(user_id, int) or user_id <= 0:
            raise ValueError("user_id must be a positive integer")
        if target_type not in {"cloud", "device"}:
            raise ValueError("target_type must be cloud or device")
        if device_name is not None and (
            not isinstance(device_name, str) or len(device_name) > 256
        ):
            raise ValueError("device_name must be a string of at most 256 characters")
        response = await self._request(
            {
                "type": "device_notification",
                "user_id": user_id,
                "target_type": target_type,
                "device_name": device_name,
            }
        )
        _validate_result_response(response)
        result = response.get("result")
        if not isinstance(result, dict):
            raise ChannelWorkerError(
                "Channel worker returned an invalid device-notification result"
            )
        return result

    async def _request(self, request: dict[str, Any]) -> dict[str, Any]:
        reader, writer = await self._open_connection()
        try:
            try:
                await asyncio.wait_for(
                    write_channel_frame(writer, request),
                    timeout=self._frame_write_timeout_seconds,
                )
                response = await asyncio.wait_for(
                    read_channel_frame(reader),
                    timeout=self._response_timeout_seconds,
                )
            except TimeoutError as error:
                raise ChannelWorkerError(
                    "Channel worker request timed out",
                    error_code="channel_worker_timeout",
                ) from error
            except asyncio.IncompleteReadError as error:
                raise ChannelWorkerError(
                    "Channel worker disconnected before responding",
                    error_code="channel_worker_disconnected",
                ) from error
            except (ConnectionError, OSError) as error:
                raise ChannelWorkerError(
                    "Channel worker connection failed during request",
                    error_code="channel_worker_disconnected",
                ) from error

            response_type = response.get("type")
            if response_type == "error":
                if set(response) != {"type", "message", "error_code"}:
                    raise ChannelWorkerError(
                        "Channel worker returned an invalid error response"
                    )
                message = response.get("message")
                error_code = response.get("error_code")
                raise ChannelWorkerError(
                    (
                        message
                        if isinstance(message, str) and message
                        else "Channel worker rejected the request"
                    ),
                    error_code=(
                        error_code
                        if isinstance(error_code, str) and error_code
                        else None
                    ),
                )
            if response_type not in {"pong", "result"}:
                raise ChannelWorkerError(
                    f"Unexpected channel worker response: {response_type!r}"
                )
            return response
        finally:
            await _close_writer(writer)

    async def _open_connection(
        self,
    ) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
        try:
            return await asyncio.wait_for(
                asyncio.open_unix_connection(self.socket_path),
                timeout=self._connect_timeout_seconds,
            )
        except TimeoutError as error:
            raise ChannelWorkerUnavailableError(
                f"Timed out connecting to channel worker: {self.socket_path}"
            ) from error
        except (FileNotFoundError, ConnectionError, OSError) as error:
            raise ChannelWorkerUnavailableError(
                f"Channel worker is unavailable: {self.socket_path}"
            ) from error


async def write_channel_frame(
    writer: asyncio.StreamWriter,
    payload: dict[str, Any],
) -> None:
    """Write one length-prefixed JSON object with a hard size limit."""
    encoded = await _CODEC_EXECUTOR.run(orjson.dumps, payload)
    if len(encoded) > CHANNEL_WORKER_MAX_FRAME_BYTES:
        raise ChannelWorkerError(
            f"Channel worker frame exceeds {CHANNEL_WORKER_MAX_FRAME_BYTES} bytes",
            error_code="channel_worker_frame_too_large",
        )
    writer.write(len(encoded).to_bytes(_FRAME_HEADER_BYTES, "big") + encoded)
    await writer.drain()


async def read_channel_frame(reader: asyncio.StreamReader) -> dict[str, Any]:
    """Read and validate one bounded length-prefixed JSON object."""
    header = await reader.readexactly(_FRAME_HEADER_BYTES)
    size = int.from_bytes(header, "big")
    if size <= 0 or size > CHANNEL_WORKER_MAX_FRAME_BYTES:
        raise ChannelWorkerError(
            f"Invalid channel worker frame size: {size}",
            error_code="channel_worker_invalid_frame",
        )
    encoded = await reader.readexactly(size)
    try:
        payload = await _CODEC_EXECUTOR.run(orjson.loads, encoded)
    except orjson.JSONDecodeError as error:
        raise ChannelWorkerError(
            "Channel worker frame is not valid JSON",
            error_code="channel_worker_invalid_frame",
        ) from error
    if not isinstance(payload, dict):
        raise ChannelWorkerError(
            "Channel worker frame must contain a JSON object",
            error_code="channel_worker_invalid_frame",
        )
    return payload


async def _close_writer(writer: asyncio.StreamWriter) -> None:
    writer.close()
    try:
        await asyncio.wait_for(writer.wait_closed(), timeout=_CLOSE_TIMEOUT_SECONDS)
    except (ConnectionError, OSError, TimeoutError):
        pass


def _validate_channel_id(channel_id: int) -> None:
    if (
        isinstance(channel_id, bool)
        or not isinstance(channel_id, int)
        or channel_id <= 0
    ):
        raise ValueError("channel_id must be a positive integer")


def _validate_result_response(response: dict[str, Any]) -> None:
    if set(response) != {"type", "result"} or response.get("type") != "result":
        raise ChannelWorkerError("Channel worker returned an invalid result response")


def _validate_task_coordinates(task_id: int, subtask_id: int) -> None:
    for name, value in (("task_id", task_id), ("subtask_id", subtask_id)):
        if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
            raise ValueError(f"{name} must be a positive integer")


def _validate_source(source: str) -> None:
    if not isinstance(source, str) or not source or len(source) > 64:
        raise ValueError("source must be a non-empty string of at most 64 characters")


def _validate_runtime_identifier(name: str, value: str) -> None:
    if not isinstance(value, str) or not value or len(value) > 256:
        raise ValueError(f"{name} must be a non-empty string of at most 256 characters")


channel_worker_client = ChannelWorkerClient()
