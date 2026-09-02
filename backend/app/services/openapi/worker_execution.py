# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Worker-owned execution and OpenAPI Responses stream projection."""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import Any, AsyncIterator, Protocol

from app.core.payload_codec import run_payload_codec
from app.services.execution.emitters.base import BaseResultEmitter
from app.services.execution.emitters.protocol import ResultEmitter
from app.services.execution.emitters.sse import SSEResultEmitter
from app.services.execution.router import CommunicationMode
from app.services.openapi.streaming import StreamingChunk, streaming_service
from shared.models import EventType, ExecutionEvent, ExecutionRequest

from .worker_protocol import (
    OPENAPI_STREAM_EVENT_QUEUE_CAPACITY,
    OPENAPI_STREAM_MAX_DURATION_SECONDS,
    OPENAPI_STREAM_MAX_FRAME_BYTES,
    OPENAPI_STREAM_MAX_TOTAL_BYTES,
    OpenAPIExecutionOutcome,
    OpenAPIStreamSpec,
)

logger = logging.getLogger(__name__)

_CALLBACK_READ_TIMEOUT_SECONDS = 1.0
_TERMINAL_TYPES = frozenset(
    {
        EventType.DONE.value,
        EventType.ERROR.value,
        EventType.CANCELLED.value,
    }
)
_DIRECT_SYNC_MODES = frozenset(
    {
        CommunicationMode.SSE,
        CommunicationMode.INPROCESS,
    }
)
_CALLBACK_MODES = frozenset(
    {
        CommunicationMode.HTTP_CALLBACK,
        CommunicationMode.WEBSOCKET,
    }
)


class WorkerOwnedDispatcher(Protocol):
    """Execution operations that may only be called by the Stream worker."""

    def execution_mode(self, request: ExecutionRequest) -> CommunicationMode: ...

    async def dispatch_worker_owned(
        self,
        request: ExecutionRequest,
        emitter: ResultEmitter,
    ) -> None: ...


class CallbackSessionManager(Protocol):
    async def attach_stream(self, subtask_id: int) -> asyncio.Event: ...

    async def is_cancelled(self, subtask_id: int) -> bool: ...

    async def subscribe_callback_channel(self, subtask_id: int) -> tuple[Any, Any]: ...

    async def unregister_stream(self, subtask_id: int) -> None: ...

    async def delete_streaming_content(self, subtask_id: int) -> bool: ...


class OpenAPIProjectionError(RuntimeError):
    """Raised when an internal execution event cannot form a valid response."""


class OpenAPIStreamLimitError(RuntimeError):
    """Raised when a bounded OpenAPI stream exceeds a hard resource limit."""


class _DiscardResultEmitter(BaseResultEmitter):
    """Run worker-owned side effects without retaining callback setup events."""

    async def emit(self, event: ExecutionEvent) -> None:
        del event


class _TerminalAwareSSEResultEmitter(SSEResultEmitter):
    """Expose terminal ownership without reading QueueBasedEmitter internals."""

    def __init__(self, task_id: int, subtask_id: int, *, maxsize: int) -> None:
        super().__init__(task_id, subtask_id, maxsize=maxsize)
        self.terminal_event: ExecutionEvent | None = None

    async def emit(self, event: ExecutionEvent) -> None:
        if self.terminal_event is not None:
            raise RuntimeError("OpenAPI execution emitted after termination")
        await super().emit(event)
        if event.type in _TERMINAL_TYPES:
            self.terminal_event = event


def _encode_json_text(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def _normalize_protocol_type(value: Any, tool_name: Any) -> str:
    if value in {"mcp", "mcp_call"}:
        return "mcp_call"
    if value == "shell_call" or tool_name == "exec":
        return "shell_call"
    return "function_call"


def _result_block_chunks(
    result: Any,
    known_blocks: dict[str, dict[str, Any]],
) -> list[StreamingChunk]:
    if not isinstance(result, dict):
        return []
    blocks = result.get("blocks")
    if not isinstance(blocks, list):
        return []

    chunks: list[StreamingChunk] = []
    for block in blocks:
        if not isinstance(block, dict) or not block.get("id"):
            continue
        block_id = str(block["id"])
        if block_id not in known_blocks:
            known_blocks[block_id] = dict(block)
            chunks.append(StreamingChunk(type="block_created", data={"block": block}))
            continue
        updates = {key: value for key, value in block.items() if key != "id"}
        known_blocks[block_id].update(updates)
        chunks.append(
            StreamingChunk(
                type="block_updated",
                data={"block_id": block_id, "updates": updates},
            )
        )
    return chunks


@dataclass
class _ToolState:
    protocol: str
    name: str
    arguments: Any
    server_label: str = ""


class OpenAPIEventProjector:
    """Own the complete internal-event to OpenAPI chunk state machine."""

    def __init__(self) -> None:
        self._tool_states: dict[str, _ToolState] = {}
        self._response_blocks: dict[str, dict[str, Any]] = {}

    def project(self, event: ExecutionEvent) -> list[StreamingChunk]:
        event_type = event.type
        if event_type == EventType.CHUNK.value:
            chunks = _result_block_chunks(event.result, self._response_blocks)
            if event.content:
                chunks.append(StreamingChunk(type="text", content=event.content))
            return chunks
        if event_type == EventType.THINKING.value:
            return (
                [StreamingChunk(type="reasoning", content=event.content)]
                if event.content
                else []
            )
        if event_type == EventType.BLOCK_CREATED.value:
            return self._project_block_created(event.data)
        if event_type == EventType.BLOCK_UPDATED.value:
            return self._project_block_updated(event.data)
        if event_type == EventType.TOOL_START.value:
            return self._project_tool_start(event)
        if event_type == EventType.TOOL.value:
            self._project_tool_update(event)
            return []
        if event_type == EventType.TOOL_RESULT.value:
            return self._project_tool_result(event)
        if event_type == EventType.DONE.value:
            return _result_block_chunks(event.result, self._response_blocks)
        if event_type == EventType.ERROR.value:
            raise OpenAPIProjectionError(event.error or "Unknown execution error")
        if event_type == EventType.CANCELLED.value:
            raise OpenAPIProjectionError("Execution cancelled")
        return []

    def _project_block_created(self, data: Any) -> list[StreamingChunk]:
        block = data.get("block") if isinstance(data, dict) else None
        if not isinstance(block, dict):
            return []
        block_id = str(block.get("id") or "")
        if block_id:
            self._response_blocks[block_id] = dict(block)
        return [StreamingChunk(type="block_created", data={"block": block})]

    def _project_block_updated(self, data: Any) -> list[StreamingChunk]:
        if not isinstance(data, dict):
            return []
        block_id = data.get("block_id")
        updates = data.get("updates")
        if not block_id or not isinstance(updates, dict):
            return []
        normalized_id = str(block_id)
        if normalized_id in self._response_blocks:
            self._response_blocks[normalized_id].update(updates)
        return [
            StreamingChunk(
                type="block_updated",
                data={"block_id": normalized_id, "updates": updates},
            )
        ]

    def _project_tool_start(self, event: ExecutionEvent) -> list[StreamingChunk]:
        tool_use_id = event.tool_use_id or ""
        if not tool_use_id:
            return []
        data = event.data if isinstance(event.data, dict) else {}
        tool_name = event.tool_name or ""
        arguments = event.tool_input if event.tool_input is not None else {}
        state = _ToolState(
            protocol=_normalize_protocol_type(data.get("tool_protocol"), tool_name),
            name=tool_name,
            arguments=arguments,
            server_label=str(data.get("server_label") or ""),
        )
        self._tool_states[tool_use_id] = state
        if state.protocol == "mcp_call":
            return [
                StreamingChunk(
                    type="mcp_call_added",
                    data={
                        "item_id": tool_use_id,
                        "name": tool_name,
                        "server_label": state.server_label,
                    },
                )
            ]
        if state.protocol == "shell_call":
            return [
                StreamingChunk(
                    type="shell_call_added",
                    data={
                        "call_id": tool_use_id,
                        "name": tool_name,
                        "arguments": arguments,
                    },
                )
            ]
        return [
            StreamingChunk(
                type="function_call_added",
                data={
                    "call_id": tool_use_id,
                    "name": tool_name,
                    "arguments": _encode_json_text(arguments),
                },
            )
        ]

    def _project_tool_update(self, event: ExecutionEvent) -> None:
        tool_use_id = event.tool_use_id or ""
        state = self._tool_states.get(tool_use_id)
        if state is not None and state.protocol == "mcp_call":
            state.arguments = event.tool_input if event.tool_input is not None else {}

    def _project_tool_result(self, event: ExecutionEvent) -> list[StreamingChunk]:
        tool_use_id = event.tool_use_id or ""
        if not tool_use_id:
            return []
        data = event.data if isinstance(event.data, dict) else {}
        state = self._tool_states.pop(tool_use_id, None)
        if state is None:
            tool_name = event.tool_name or ""
            state = _ToolState(
                protocol=_normalize_protocol_type(
                    data.get("tool_protocol"),
                    tool_name,
                ),
                name=tool_name,
                arguments=(event.tool_input if event.tool_input is not None else {}),
                server_label=str(data.get("server_label") or ""),
            )
        protocol = _normalize_protocol_type(
            state.protocol or data.get("tool_protocol"),
            state.name or event.tool_name,
        )
        name = state.name or event.tool_name or ""
        arguments = (
            event.tool_input if event.tool_input is not None else state.arguments or {}
        )
        failed = data.get("status") == "failed"
        if protocol == "mcp_call":
            return [
                StreamingChunk(
                    type="mcp_call_done",
                    data={
                        "item_id": tool_use_id,
                        "name": name,
                        "server_label": state.server_label,
                        "arguments": _encode_json_text(arguments) if arguments else "",
                        "output": event.tool_output,
                        "status": "failed" if failed else "completed",
                        "error": event.error or data.get("error"),
                    },
                )
            ]
        if protocol == "shell_call":
            return [
                StreamingChunk(
                    type="shell_call_done",
                    data={
                        "call_id": tool_use_id,
                        "name": name,
                        "arguments": arguments,
                        "status": "failed" if failed else "completed",
                    },
                )
            ]
        return [
            StreamingChunk(
                type="function_call_done",
                data={
                    "call_id": tool_use_id,
                    "name": name,
                    "arguments": _encode_json_text(arguments) if arguments else "",
                },
            )
        ]


class OpenAPIWorkerExecutionService:
    """Execute all modes and project every OpenAPI stream outside Web."""

    def __init__(
        self,
        dispatcher: WorkerOwnedDispatcher,
        session_manager: CallbackSessionManager,
        *,
        event_queue_capacity: int = OPENAPI_STREAM_EVENT_QUEUE_CAPACITY,
        max_frame_bytes: int = OPENAPI_STREAM_MAX_FRAME_BYTES,
        max_total_bytes: int = OPENAPI_STREAM_MAX_TOTAL_BYTES,
        max_duration_seconds: float = OPENAPI_STREAM_MAX_DURATION_SECONDS,
    ) -> None:
        if event_queue_capacity <= 0:
            raise ValueError("event_queue_capacity must be positive")
        if max_frame_bytes <= 1 or max_total_bytes < max_frame_bytes:
            raise ValueError("Invalid OpenAPI worker byte limits")
        if max_duration_seconds <= 0:
            raise ValueError("max_duration_seconds must be positive")
        self._dispatcher = dispatcher
        self._session_manager = session_manager
        self._event_queue_capacity = event_queue_capacity
        self._max_frame_bytes = max_frame_bytes
        self._max_total_bytes = max_total_bytes
        self._max_duration_seconds = max_duration_seconds

    def immediate_status(
        self,
        request: ExecutionRequest,
        *,
        background: bool,
    ) -> str | None:
        """Return the accepted status, or None when the caller must wait."""
        mode = self._dispatcher.execution_mode(request)
        if not background and mode in _DIRECT_SYNC_MODES:
            return None
        if background and mode in _DIRECT_SYNC_MODES:
            return "in_progress"
        return "queued"

    async def stream_sse(
        self,
        request: ExecutionRequest,
        spec: OpenAPIStreamSpec,
    ) -> AsyncIterator[bytes]:
        """Yield already encoded OpenAPI SSE bytes with hard resource bounds."""
        projector = OpenAPIEventProjector()

        async def chat_chunks() -> AsyncIterator[StreamingChunk]:
            async for event in self._execution_events(request):
                chunks = await run_payload_codec(
                    projector.project,
                    event,
                    payload_hint=event,
                    force_offload=True,
                )
                for chunk in chunks:
                    yield chunk

        total_bytes = 0
        source = chat_chunks()
        response_stream = streaming_service.create_streaming_response(
            response_id=spec.response_id,
            model_string=spec.model_string,
            chat_stream=source,
            created_at=spec.created_at,
            previous_response_id=spec.previous_response_id,
            task_context=spec.task_context,
        )
        try:
            async with asyncio.timeout(self._max_duration_seconds):
                async for event in response_stream:
                    encoded = event.encode("utf-8")
                    if len(encoded) + 1 > self._max_frame_bytes:
                        raise OpenAPIStreamLimitError(
                            "OpenAPI SSE event exceeded the single-frame limit"
                        )
                    total_bytes += len(encoded)
                    if total_bytes > self._max_total_bytes:
                        raise OpenAPIStreamLimitError(
                            "OpenAPI SSE stream exceeded the total byte limit"
                        )
                    yield encoded
        except TimeoutError as error:
            raise OpenAPIStreamLimitError(
                "OpenAPI SSE stream exceeded the total duration"
            ) from error
        finally:
            await response_stream.aclose()
            await source.aclose()

    async def collect(self, request: ExecutionRequest) -> OpenAPIExecutionOutcome:
        """Wait for worker-persisted terminal state without returning response data."""
        terminal: ExecutionEvent | None = None
        try:
            async with asyncio.timeout(self._max_duration_seconds):
                async for event in self._direct_events(request):
                    if event.type in _TERMINAL_TYPES:
                        terminal = event
                        break
        except TimeoutError as error:
            raise OpenAPIStreamLimitError(
                "OpenAPI execution exceeded the total duration"
            ) from error

        if terminal is None:
            return OpenAPIExecutionOutcome(
                status="failed",
                error="Execution ended without a terminal event",
                error_code="execution_missing_terminal",
            )
        if terminal.type == EventType.DONE.value:
            return OpenAPIExecutionOutcome(
                status="completed",
                terminal_type=terminal.type,
            )
        return OpenAPIExecutionOutcome(
            status="failed",
            terminal_type=terminal.type,
            error=terminal.error
            or (
                "Execution cancelled"
                if terminal.type == EventType.CANCELLED.value
                else "Unknown execution error"
            ),
            error_code=terminal.error_code,
        )

    async def run_background(self, request: ExecutionRequest) -> None:
        """Drain a worker-owned execution so its bounded event queue cannot stall."""
        mode = self._dispatcher.execution_mode(request)
        if mode in _CALLBACK_MODES:
            emitter = _DiscardResultEmitter(
                request.task_id,
                request.subtask_id,
            )
            await self._dispatcher.dispatch_worker_owned(request, emitter)
            return
        async for _ in self._direct_events(request):
            pass

    async def _execution_events(
        self,
        request: ExecutionRequest,
    ) -> AsyncIterator[ExecutionEvent]:
        mode = self._dispatcher.execution_mode(request)
        if mode in _CALLBACK_MODES:
            async for event in self._callback_events(request):
                yield event
            return
        async for event in self._direct_events(request):
            yield event

    async def _direct_events(
        self,
        request: ExecutionRequest,
    ) -> AsyncIterator[ExecutionEvent]:
        emitter = _TerminalAwareSSEResultEmitter(
            request.task_id,
            request.subtask_id,
            maxsize=self._event_queue_capacity,
        )

        async def dispatch() -> None:
            try:
                await self._dispatcher.dispatch_worker_owned(request, emitter)
            except asyncio.CancelledError:
                raise
            except Exception as error:
                logger.exception("Worker-owned OpenAPI execution failed")
                if emitter.terminal_event is None:
                    await emitter.emit_error(
                        task_id=request.task_id,
                        subtask_id=request.subtask_id,
                        error=str(error),
                    )
            finally:
                await emitter.close()

        dispatch_task = asyncio.create_task(dispatch())
        completed = False
        try:
            async for event in emitter.stream():
                yield event
                if event.type in _TERMINAL_TYPES:
                    completed = True
                    break
        finally:
            if not completed and not dispatch_task.done():
                dispatch_task.cancel()
            await asyncio.gather(dispatch_task, return_exceptions=True)

    async def _callback_events(
        self,
        request: ExecutionRequest,
    ) -> AsyncIterator[ExecutionEvent]:
        cancel_event = await self._session_manager.attach_stream(request.subtask_id)
        redis_client = None
        pubsub = None
        try:
            redis_client, pubsub = (
                await self._session_manager.subscribe_callback_channel(
                    request.subtask_id
                )
            )
            if redis_client is None or pubsub is None:
                raise RuntimeError("Failed to subscribe to callback stream channel")
            emitter = _DiscardResultEmitter(
                request.task_id,
                request.subtask_id,
            )
            await self._dispatcher.dispatch_worker_owned(request, emitter)

            while True:
                if cancel_event.is_set() or await self._session_manager.is_cancelled(
                    request.subtask_id
                ):
                    yield ExecutionEvent(
                        type=EventType.CANCELLED.value,
                        task_id=request.task_id,
                        subtask_id=request.subtask_id,
                        message_id=request.message_id,
                    )
                    return
                message = await pubsub.get_message(
                    ignore_subscribe_messages=True,
                    timeout=_CALLBACK_READ_TIMEOUT_SECONDS,
                )
                if message is None or message.get("type") != "message":
                    continue
                event = await run_payload_codec(
                    _decode_callback_event,
                    message.get("data"),
                    payload_hint=message.get("data"),
                    force_offload=True,
                )
                yield event
                if event.type in _TERMINAL_TYPES:
                    return
        finally:
            if pubsub is not None:
                try:
                    await pubsub.unsubscribe()
                except Exception:
                    logger.exception("Failed to unsubscribe OpenAPI callback stream")
            if redis_client is not None:
                try:
                    await redis_client.aclose()
                except Exception:
                    logger.exception("Failed to close OpenAPI callback Redis client")
            await self._session_manager.unregister_stream(request.subtask_id)
            await self._session_manager.delete_streaming_content(request.subtask_id)


def _decode_callback_event(data: Any) -> ExecutionEvent:
    if isinstance(data, bytes):
        data = data.decode("utf-8")
    if not isinstance(data, str):
        raise ValueError("Callback event must be JSON text")
    value = json.loads(data)
    if not isinstance(value, dict):
        raise ValueError("Callback event must be a JSON object")
    return ExecutionEvent.from_dict(value)
