# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unified task dispatcher for execution.

Dispatches tasks to execution services based on routing configuration.

All external code should use the unified `dispatch` method with an appropriate
emitter. Different emitter types support different use cases:
- WebSocketResultEmitter: Push events to WebSocket clients
- SSEResultEmitter: Queue-based emitter for streaming responses
- SubscriptionResultEmitter: For subscription task execution

For SSE mode (Chat shell), uses OpenAI AsyncClient to consume the
OpenAI Responses API compatible endpoint.
"""

import asyncio
import json
import logging
from concurrent.futures import ThreadPoolExecutor
from typing import TYPE_CHECKING, Any, List, Optional

if TYPE_CHECKING:
    from openai import AsyncOpenAI

from app.core.async_utils import run_in_main_loop
from app.db.session import SessionLocal
from app.models.subtask import Subtask
from app.models.task import TaskResource
from app.services.task_status import extract_task_error
from shared.models import (
    EventType,
    ExecutionEvent,
    ExecutionRequest,
    OpenAIRequestConverter,
)
from shared.models.responses_api import ResponsesAPIStreamEvents
from shared.utils.http_client import traced_async_client

from .emitters import (
    CompositeResultEmitter,
    ResultEmitter,
    ResultEmitterFactory,
    StatusUpdatingEmitter,
    WebSocketResultEmitter,
)
from .polling_dispatcher import dispatch_polling
from .recovery_service import recovery_service
from .router import CommunicationMode, ExecutionRouter, ExecutionTarget

logger = logging.getLogger(__name__)


class InvalidToolCallEventError(ValueError):
    """Raised when a Responses API tool event is missing its correlation ID."""


def _require_non_empty_tool_use_id(tool_use_id: Any, *, context: str) -> str:
    """Return a validated tool-use ID or raise for blank/missing values."""
    if tool_use_id is None:
        value = ""
    elif isinstance(tool_use_id, str):
        value = tool_use_id
    else:
        value = str(tool_use_id)

    if not value.strip():
        raise InvalidToolCallEventError(f"{context}: missing non-empty tool_use_id")

    return value


def extract_completed_result(response_data: dict) -> dict:
    """Build a result dict from a ``response.completed`` payload.

    Shared by :class:`ResponsesAPIEventParser` and
    :class:`EmitterBridgeTransport` so the field list is maintained in one
    place.
    """
    # Extract text content from response output
    value = ""
    for item in response_data.get("output", []):
        if isinstance(item, dict):
            for content_block in item.get("content", []):
                if isinstance(content_block, dict) and content_block.get("text"):
                    value += content_block["text"]

    return {
        "value": value,
        "usage": response_data.get("usage"),
        "sources": response_data.get("sources"),
        "blocks": response_data.get("blocks"),
        "silent_exit": response_data.get("silent_exit"),
        "silent_exit_reason": response_data.get("silent_exit_reason"),
        "loaded_skills": response_data.get("loaded_skills"),
        "stop_reason": response_data.get("stop_reason"),
        "messages_chain": response_data.get("messages_chain"),
        "reasoning_content": response_data.get("reasoning_content"),
    }


class ResponsesAPIEventParser:
    """Parser for OpenAI Responses API format events.

    This parser is shared between SSE and HTTP callback modes.
    It converts OpenAI Responses API events to internal ExecutionEvent format.
    """

    @staticmethod
    def parse(
        task_id: int,
        subtask_id: int,
        message_id: Optional[int],
        event_type: str,
        data: dict,
    ) -> Optional[ExecutionEvent]:
        """Parse OpenAI Responses API event to ExecutionEvent.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            message_id: Optional message ID
            event_type: Event type string (e.g., "response.output_text.delta")
            data: Event data dictionary

        Returns:
            Parsed ExecutionEvent or None if event should be skipped
        """
        # Map OpenAI Responses API events to internal EventType
        if event_type == ResponsesAPIStreamEvents.OUTPUT_TEXT_DELTA.value:
            # response.output_text.delta -> CHUNK
            # Wegent extension: offset field tracks cumulative text position
            return ExecutionEvent(
                type=EventType.CHUNK,
                task_id=task_id,
                subtask_id=subtask_id,
                content=data.get("delta", ""),
                offset=data.get("offset", 0),
                result=data.get("result"),
                data={
                    "block_id": data.get("block_id"),
                    "block_offset": data.get("block_offset"),
                },
                message_id=message_id,
            )

        elif event_type == ResponsesAPIStreamEvents.RESPONSE_COMPLETED.value:
            # response.completed -> DONE
            response_data = data.get("response", {})
            return ExecutionEvent(
                type=EventType.DONE,
                task_id=task_id,
                subtask_id=subtask_id,
                content="",
                result=extract_completed_result(response_data),
                message_id=message_id,
            )

        elif event_type == ResponsesAPIStreamEvents.ERROR.value:
            # error -> ERROR
            return ExecutionEvent(
                type=EventType.ERROR,
                task_id=task_id,
                subtask_id=subtask_id,
                error=data.get("message", "Unknown error"),
                message_id=message_id,
            )

        elif event_type == ResponsesAPIStreamEvents.RESPONSE_INCOMPLETE.value:
            # response.incomplete -> CANCELLED
            return ExecutionEvent(
                type=EventType.CANCELLED,
                task_id=task_id,
                subtask_id=subtask_id,
                message_id=message_id,
            )

        elif event_type == ResponsesAPIStreamEvents.FUNCTION_CALL_ARGUMENTS_DELTA.value:
            # function_call_arguments.delta -> incremental arguments update
            # Standard OpenAI protocol: this event only contains delta, no status field
            # Tool start is signaled by response.output_item.added with type=function_call
            # We skip this event as it's just incremental argument streaming
            return None

        elif event_type == ResponsesAPIStreamEvents.FUNCTION_CALL_ARGUMENTS_DONE.value:
            # function_call_arguments.done -> TOOL_RESULT
            tool_use_id = _require_non_empty_tool_use_id(
                data.get("call_id") or data.get("item_id"),
                context="function_call_arguments.done",
            )
            # Parse arguments from the event data to get tool_input
            arguments_str = data.get("arguments", "")
            tool_input = None
            if arguments_str:
                try:
                    tool_input = json.loads(arguments_str)
                except (json.JSONDecodeError, TypeError):
                    pass
            return ExecutionEvent(
                type=EventType.TOOL_RESULT,
                task_id=task_id,
                subtask_id=subtask_id,
                tool_use_id=tool_use_id,
                tool_input=tool_input,
                tool_output=data.get("output"),
                data={"blocks": data.get("blocks", [])},
                message_id=message_id,
            )

        elif event_type == ResponsesAPIStreamEvents.RESPONSE_PART_ADDED.value:
            # response.reasoning_summary_part.added -> THINKING
            part = data.get("part", {})
            if part.get("type") == "reasoning":
                return ExecutionEvent(
                    type=EventType.THINKING,
                    task_id=task_id,
                    subtask_id=subtask_id,
                    content=part.get("text", ""),
                    message_id=message_id,
                )
            return None

        elif event_type == ResponsesAPIStreamEvents.OUTPUT_ITEM_ADDED.value:
            # response.output_item.added -> check if it's a function_call
            # Standard OpenAI protocol: when item.type == "function_call", it signals tool start
            item = data.get("item", {})
            if item.get("type") == "function_call":
                # Extract function call info from item
                call_id = _require_non_empty_tool_use_id(
                    item.get("call_id") or item.get("id"),
                    context="response.output_item.added(function_call)",
                )
                name = item.get("name", "")
                # Arguments may be empty string initially, parse if present
                arguments_str = item.get("arguments", "")
                arguments = {}
                if arguments_str:
                    try:
                        arguments = json.loads(arguments_str)
                    except (json.JSONDecodeError, TypeError):
                        pass

                return ExecutionEvent(
                    type=EventType.TOOL_START,
                    task_id=task_id,
                    subtask_id=subtask_id,
                    tool_use_id=call_id,
                    tool_name=name,
                    tool_input=arguments,
                    data={
                        "blocks": data.get("blocks", []),
                        "display_name": data.get("display_name"),
                    },
                    message_id=message_id,
                )
            # Other item types (message) are lifecycle events, skip
            return None

        elif event_type in (
            ResponsesAPIStreamEvents.RESPONSE_CREATED.value,
            ResponsesAPIStreamEvents.RESPONSE_IN_PROGRESS.value,
            ResponsesAPIStreamEvents.OUTPUT_ITEM_DONE.value,
            ResponsesAPIStreamEvents.CONTENT_PART_ADDED.value,
            ResponsesAPIStreamEvents.CONTENT_PART_DONE.value,
            ResponsesAPIStreamEvents.OUTPUT_TEXT_DONE.value,
        ):
            # These are lifecycle events, skip them
            return None

        # Unknown event type, skip
        logger.debug(
            f"[ResponsesAPIEventParser] Unknown event type: {event_type}, skipping"
        )
        return None


class ExecutionDispatcher:
    """Unified task dispatcher.

    Core responsibilities:
    1. Use ExecutionRouter to determine target
    2. Send request based on communication mode
    3. Unified event handling via ResultEmitter

    Design principles:
    - Does not know what the execution service is
    - Only knows communication mode and target address
    - Uses ResultEmitter for all event emission
    - All external code should use the unified `dispatch` method
    """

    def __init__(self):
        """Initialize the execution dispatcher."""
        self.router = ExecutionRouter()
        self.http_client = traced_async_client(timeout=300.0)
        self.event_parser = ResponsesAPIEventParser()

    async def dispatch(
        self,
        request: ExecutionRequest,
        device_id: Optional[str] = None,
        emitter: Optional[ResultEmitter] = None,
    ) -> None:
        """Unified dispatch entry point for task execution.

        This is the ONLY public method for dispatching tasks. All external code
        should use this method with an appropriate emitter.

        For different use cases, pass different emitter types:
        - WebSocketResultEmitter: Events pushed to WebSocket (default)
        - SSEResultEmitter: Use emitter.stream() to iterate events
        - SubscriptionResultEmitter: For subscription task callbacks

        Example usage with SSEResultEmitter for streaming:
            emitter = SSEResultEmitter(task_id, subtask_id)
            task = asyncio.create_task(dispatcher.dispatch(request, emitter=emitter))
            async for event in emitter.stream():
                yield process_event(event)
            await task

        Example usage with SSEResultEmitter for sync (collect all):
            emitter = SSEResultEmitter(task_id, subtask_id)
            task = asyncio.create_task(dispatcher.dispatch(request, emitter=emitter))
            content, final_event = await emitter.collect()
            await task

        Args:
            request: Unified execution request
            device_id: Optional device ID - uses WebSocket mode when specified
            emitter: Optional custom emitter, defaults to WebSocketResultEmitter
        """
        wrapped_emitter = None
        try:
            await self._recover_executor_if_needed(request)

            # Route to execution target
            target = self.router.route(request, device_id)
            logger.info(
                f"[ExecutionDispatcher] Routed: task_id={request.task_id}, "
                f"subtask_id={request.subtask_id}, device_id={device_id} -> {target}"
            )
            # Create default emitter if not provided
            if emitter is None:
                # Extract team info from request for task:created event
                team_id = None
                team_name = None
                is_group_chat = False
                if request.bot and len(request.bot) > 0:
                    team_id = request.bot[0].get("team_id")
                    team_name = request.bot[0].get("team_name")
                    is_group_chat = request.bot[0].get("is_group_chat", False)

                # Extract task title from request
                task_title = request.task_title

                emitter = WebSocketResultEmitter(
                    task_id=request.task_id,
                    subtask_id=request.subtask_id,
                    user_id=request.user.get("id") if request.user else None,
                    team_id=team_id,
                    team_name=team_name,
                    task_title=task_title,
                    is_group_chat=is_group_chat,
                )

            # Wrap emitter with StatusUpdatingEmitter for unified status updates
            # This ensures task status is updated to COMPLETED/FAILED/CANCELLED
            # when terminal events are received, regardless of execution mode
            wrapped_emitter = StatusUpdatingEmitter(
                wrapped=emitter,
                task_id=request.task_id,
                subtask_id=request.subtask_id,
            )

            logger.info(
                f"[ExecutionDispatcher] Dispatching: task_id={request.task_id}, "
                f"subtask_id={request.subtask_id}, mode={target.mode.value}"
            )

            # Update subtask status to RUNNING before dispatching
            # This applies to all execution modes (SSE, WebSocket, HTTP+Callback)
            await self._update_subtask_to_running(request.subtask_id)

            if target.mode == CommunicationMode.SSE:
                await self._dispatch_sse(request, target, wrapped_emitter)
            elif target.mode == CommunicationMode.WEBSOCKET:
                await self._dispatch_websocket(request, target, wrapped_emitter)
            elif target.mode == CommunicationMode.POLLING:
                await self._dispatch_polling(request, target, wrapped_emitter)
            elif target.mode == CommunicationMode.INPROCESS:
                await self._dispatch_inprocess(request, target, wrapped_emitter)
            else:
                await self._dispatch_http_callback(request, target, wrapped_emitter)
        except Exception as e:
            logger.exception(
                f"[ExecutionDispatcher] Dispatch error: task_id={request.task_id}, "
                f"subtask_id={request.subtask_id}, error={e}"
            )
            # Try to emit error to frontend if emitter is available
            if wrapped_emitter is not None:
                try:
                    await wrapped_emitter.emit_error(
                        task_id=request.task_id,
                        subtask_id=request.subtask_id,
                        error=str(e),
                    )
                except Exception as emit_error:
                    logger.error(
                        f"[ExecutionDispatcher] Failed to emit error: {emit_error}"
                    )
            # Re-raise the exception so the caller knows dispatch failed
            raise
        finally:
            if wrapped_emitter is not None:
                try:
                    await wrapped_emitter.close()
                except Exception as close_error:
                    logger.error(
                        f"[ExecutionDispatcher] Failed to close emitter: {close_error}"
                    )

    async def _recover_executor_if_needed(self, request: ExecutionRequest) -> None:
        """Recover executor state for deleted runtime instances before dispatching."""
        shell_type = self._get_shell_type(request)
        if shell_type not in {"ClaudeCode", "Agno"}:
            return

        db = SessionLocal()
        try:
            subtask = db.query(Subtask).filter(Subtask.id == request.subtask_id).first()
            if not subtask:
                return

            # Save reference to current subtask for later update
            current_subtask = subtask

            if not subtask.executor_deleted_at:
                return

            task = (
                db.query(TaskResource)
                .filter(
                    TaskResource.id == request.task_id,
                    TaskResource.kind == "Task",
                )
                .first()
            )
            if not task:
                raise RuntimeError(
                    f"Task {request.task_id} not found for executor recovery"
                )

            logger.info(
                "[ExecutionDispatcher] Recovering deleted executor: "
                "task_id=%s, subtask_id=%s, executor=%s",
                request.task_id,
                request.subtask_id,
                subtask.executor_name,
            )

            recovered_info = await recovery_service.recover(
                db=db,
                subtask=subtask,
                task=task,
                request=request,
            )
            if not recovered_info:
                subtask_error = getattr(subtask, "error_message", None)
                error_message = (
                    subtask_error
                    if isinstance(subtask_error, str) and subtask_error.strip()
                    else extract_task_error(task)
                )
                if not error_message:
                    error_message = (
                        f"Failed to recover executor for subtask {request.subtask_id}"
                    )
                raise RuntimeError(error_message)

            # Update the current subtask to reflect the recovered executor.
            current_subtask.executor_name = recovered_info["executor_name"]
            current_subtask.executor_namespace = recovered_info["executor_namespace"]
            current_subtask.executor_deleted_at = False
            db.add(current_subtask)
            db.commit()

            request.executor_name = recovered_info["executor_name"]
            request.executor_namespace = recovered_info["executor_namespace"]
            logger.info(
                "[ExecutionDispatcher] Recovered executor: "
                "task_id=%s, current_subtask_id=%s, executor=%s/%s",
                request.task_id,
                current_subtask.id,
                request.executor_namespace,
                request.executor_name,
            )
        finally:
            db.close()

    async def _update_subtask_to_running(self, subtask_id: int) -> None:
        """Update subtask status to RUNNING in database.

        This is called before dispatching to any executor type to ensure
        the subtask status is updated to RUNNING at the start of execution.

        Args:
            subtask_id: Subtask ID to update
        """
        from app.services.chat.storage.db import db_handler

        try:
            await db_handler.update_subtask_status(subtask_id, "RUNNING")
            logger.info(
                f"[ExecutionDispatcher] Updated subtask {subtask_id} status to RUNNING"
            )
        except Exception as e:
            logger.error(
                f"[ExecutionDispatcher] Failed to update subtask {subtask_id} to RUNNING: {e}"
            )

    async def _set_subtask_executor(
        self,
        subtask_id: int,
        device_id: str,
        user_id: Optional[int],
    ) -> None:
        """Set executor info on subtask for device-mode dispatch.

        This is required so that subsequent progress/result events from the device
        pass the ownership check in device_namespace._update_subtask_progress().

        Args:
            subtask_id: Subtask ID to update
            device_id: Device ID
            user_id: User ID
        """
        from app.db.session import SessionLocal
        from app.models.subtask import Subtask

        db = SessionLocal()
        try:
            subtask = db.query(Subtask).filter(Subtask.id == subtask_id).first()
            if subtask:
                subtask.executor_name = f"device-{device_id}"
                subtask.executor_namespace = f"user-{user_id}" if user_id else None
                db.commit()
                logger.info(
                    f"[ExecutionDispatcher] Set executor on subtask {subtask_id}: "
                    f"executor_name=device-{device_id}"
                )
        except Exception as e:
            logger.error(
                f"[ExecutionDispatcher] Failed to set executor on subtask {subtask_id}: {e}"
            )
            db.rollback()
        finally:
            db.close()

    def supports_streaming(self, request: ExecutionRequest) -> bool:
        """Check if the request supports streaming.

        Only SSE mode supports streaming responses.

        Args:
            request: Execution request

        Returns:
            True if streaming is supported
        """
        target = self.router.route(request, device_id=None)
        return target.mode == CommunicationMode.SSE

    @staticmethod
    def _get_shell_type(request: ExecutionRequest) -> str:
        """Extract shell_type from execution request.

        Args:
            request: Execution request

        Returns:
            Shell type string (e.g., "ClaudeCode", "Chat", "Agno")
        """
        if request.bot and len(request.bot) > 0:
            return request.bot[0].get("shell_type", "Chat")
        return "Chat"

    @staticmethod
    def _get_model_type(request: ExecutionRequest) -> str:
        """Get model type from request's model_config.

        Args:
            request: Execution request

        Returns:
            Model type string (e.g., "llm", "image")
        """
        model_config = request.model_config or {}
        return model_config.get("modelType", "llm")

    @staticmethod
    def _resolve_request_id(
        request: ExecutionRequest,
        metadata: dict[str, Any],
    ) -> tuple[str, str]:
        """Resolve request_id for backend -> chat_shell correlation.

        Priority:
        1. Existing metadata.request_id (already propagated)
        2. request.request_id
        3. Generated fallback: req_{subtask_id}

        Returns:
            tuple: (request_id, source)
        """
        metadata_request_id = str(metadata.get("request_id", "")).strip()
        if metadata_request_id:
            return metadata_request_id, "metadata"

        request_request_id = str(getattr(request, "request_id", "")).strip()
        if request_request_id:
            return request_request_id, "request"

        return f"req_{request.subtask_id}", "generated"

    async def dispatch_with_composite(
        self,
        request: ExecutionRequest,
        emitter_configs: List[dict],
        device_id: Optional[str] = None,
    ) -> None:
        """Dispatch task with composite emitter.

        Supports sending events to multiple targets simultaneously.

        Args:
            request: Execution request
            emitter_configs: List of emitter configurations
            device_id: Optional device ID
        """
        emitter = ResultEmitterFactory.create_composite(
            task_id=request.task_id,
            subtask_id=request.subtask_id,
            emitter_configs=emitter_configs,
        )

        await self.dispatch(request, device_id, emitter)

    async def _dispatch_sse(
        self,
        request: ExecutionRequest,
        target: ExecutionTarget,
        emitter: ResultEmitter,
    ) -> None:
        """Dispatch task via SSE.

        Routes based on modelType:
        - modelType == "image" -> ImageAgent (direct API call)
        - modelType == "llm" or default -> chat_shell via OpenAI client

        Uses AsyncOpenAI client to consume OpenAI Responses API compatible endpoint.
        Converts ExecutionRequest to OpenAI format, sends request, and processes
        streaming events.

        Supports distributed cancellation via Redis: periodically checks Redis
        cancellation flag and breaks out of stream loop if cancelled.

        Args:
            request: Execution request
            target: Execution target configuration
            emitter: Result emitter for event emission
        """
        # Check if this is an image generation request
        model_type = self._get_model_type(request)

        if model_type == "image":
            # Route to ImageAgent for direct image generation
            await self._dispatch_image_generation(request, emitter)
            return

        # Default: route to chat_shell via OpenAI client
        from app.services.chat.storage.session import session_manager

        # OpenAI client appends /responses to base_url, so we need to include /v1
        # e.g., base_url=http://127.0.0.1:8100/v1 -> POST http://127.0.0.1:8100/v1/responses
        base_url = f"{target.url}/v1"

        logger.info(
            f"[ExecutionDispatcher] SSE dispatch via OpenAI client: base_url={base_url}"
        )

        # Register stream for cancellation tracking
        cancel_event = await session_manager.register_stream(request.subtask_id)

        # Send START event
        await emitter.emit_start(
            task_id=request.task_id,
            subtask_id=request.subtask_id,
            message_id=request.message_id,
            data={"shell_type": self._get_shell_type(request)},
        )

        # Lazy import OpenAI SDK for memory optimization
        from openai import AsyncOpenAI

        # Create OpenAI client pointing to chat_shell
        client = AsyncOpenAI(
            base_url=base_url,
            api_key="dummy",  # Not used by chat_shell but required by client
            timeout=300.0,
        )

        # Convert ExecutionRequest to OpenAI format
        openai_request = OpenAIRequestConverter.from_execution_request(request)

        # Ensure request_id is set in metadata for backend -> chat_shell correlation.
        # Preserve existing request_id if provided by upstream backend request context.
        metadata = openai_request.get("metadata", {})
        request_id, request_id_source = self._resolve_request_id(request, metadata)
        metadata["request_id"] = request_id
        openai_request["metadata"] = metadata

        # Get tools from openai_request (includes MCP servers converted to tools)
        tools = openai_request.get("tools", [])

        logger.info(
            f"[ExecutionDispatcher] Sending OpenAI request: model={openai_request.get('model')}, "
            f"task_id={request.task_id}, subtask_id={request.subtask_id}, "
            f"tools_count={len(tools)}, request_id={request_id}, request_id_source={request_id_source}"
        )

        # Stream response using OpenAI client
        # Note: tools is a first-class parameter in OpenAI Responses API, not in extra_body
        logger.info(
            f"[ExecutionDispatcher] About to call client.responses.create: "
            f"task_id={request.task_id}, subtask_id={request.subtask_id}"
        )
        stream = await client.responses.create(
            model=openai_request.get("model", ""),
            input=openai_request.get("input", ""),
            instructions=openai_request.get("instructions"),
            tools=tools if tools else None,
            stream=True,
            extra_body={
                "metadata": openai_request.get("metadata", {}),
                "model_config": openai_request.get("model_config", {}),
            },
        )
        logger.info(
            f"[ExecutionDispatcher] Stream created, starting to iterate events: "
            f"task_id={request.task_id}, subtask_id={request.subtask_id}"
        )

        event_count = 0
        last_cancel_check = 0
        cancelled = False
        terminal_event_type = ""

        try:
            # Process streaming events
            async for event in stream:
                event_count += 1

                # Check for cancellation every 10 events (to avoid too frequent Redis calls)
                if event_count - last_cancel_check >= 10:
                    last_cancel_check = event_count
                    if await session_manager.is_cancelled(request.subtask_id):
                        logger.info(
                            f"[ExecutionDispatcher] Cancellation detected via Redis, "
                            f"breaking stream loop: task_id={request.task_id}, "
                            f"subtask_id={request.subtask_id}"
                        )
                        cancelled = True
                        break

                # Also check local event (fast path, no Redis call)
                if cancel_event.is_set():
                    logger.info(
                        f"[ExecutionDispatcher] Cancellation detected via local event, "
                        f"breaking stream loop: task_id={request.task_id}, "
                        f"subtask_id={request.subtask_id}"
                    )
                    cancelled = True
                    break

                # Get event type from the event object
                event_type = getattr(event, "type", None)
                if not event_type:
                    continue

                # Log every event for debugging
                if event_count <= 5 or event_type in ("response.completed", "error"):
                    logger.info(
                        f"[ExecutionDispatcher] SSE event #{event_count}: type={event_type}, "
                        f"task_id={request.task_id}, subtask_id={request.subtask_id}"
                    )

                # Convert event to dict for parsing
                event_data = (
                    event.model_dump() if hasattr(event, "model_dump") else vars(event)
                )

                # Parse event using shared parser
                parsed_event = self.event_parser.parse(
                    task_id=request.task_id,
                    subtask_id=request.subtask_id,
                    message_id=request.message_id,
                    event_type=event_type,
                    data=event_data,
                )

                if parsed_event:
                    logger.info(
                        "[ExecutionDispatcher] Parsed SSE event -> internal event: "
                        "task_id=%d, subtask_id=%d, request_id=%s, sse_event=%s, internal_event=%s",
                        request.task_id,
                        request.subtask_id,
                        request_id,
                        event_type,
                        parsed_event.type,
                    )
                    await emitter.emit(parsed_event)

                # Break out of loop on terminal events
                # OpenAI SDK's stream iterator doesn't auto-exit after response.completed,
                # so we need to manually break to avoid hanging
                if event_type in (
                    ResponsesAPIStreamEvents.RESPONSE_COMPLETED.value,
                    ResponsesAPIStreamEvents.ERROR.value,
                    ResponsesAPIStreamEvents.RESPONSE_INCOMPLETE.value,
                ):
                    terminal_event_type = event_type
                    logger.info(
                        f"[ExecutionDispatcher] Terminal event received, breaking stream loop: "
                        f"task_id={request.task_id}, subtask_id={request.subtask_id}, "
                        f"event_type={event_type}, request_id={request_id}"
                    )
                    break

            # If cancelled, emit CANCELLED event
            if cancelled:
                await emitter.emit(
                    ExecutionEvent(
                        type=EventType.CANCELLED,
                        task_id=request.task_id,
                        subtask_id=request.subtask_id,
                        message_id=request.message_id,
                    )
                )

            if not cancelled and not terminal_event_type:
                logger.warning(
                    "[ExecutionDispatcher] SSE stream ended without terminal event: "
                    "task_id=%d, subtask_id=%d, request_id=%s, total_events=%d",
                    request.task_id,
                    request.subtask_id,
                    request_id,
                    event_count,
                )

            # Log when stream iteration completes
            logger.info(
                f"[ExecutionDispatcher] SSE stream completed: "
                f"task_id={request.task_id}, subtask_id={request.subtask_id}, "
                f"total_events={event_count}, cancelled={cancelled}, "
                f"terminal_event_type={terminal_event_type or 'none'}, request_id={request_id}"
            )
        finally:
            # Unregister stream to clean up
            await session_manager.unregister_stream(request.subtask_id)

    async def _dispatch_image_generation(
        self,
        request: ExecutionRequest,
        emitter: ResultEmitter,
    ) -> None:
        """Dispatch image generation task to ImageAgent.

        ImageAgent handles:
        1. Calling Seedream API directly
        2. Uploading result as attachment
        3. Emitting events via emitter

        Args:
            request: Execution request
            emitter: Result emitter for event emission
        """
        from .agents.image.image_agent import ImageAgent

        logger.info(
            f"[ExecutionDispatcher] Dispatching to ImageAgent: "
            f"task_id={request.task_id}, subtask_id={request.subtask_id}"
        )

        agent = ImageAgent()
        await agent.execute(request, emitter)

    async def _dispatch_polling(
        self,
        request: ExecutionRequest,
        target: ExecutionTarget,
        emitter: ResultEmitter,
    ) -> None:
        """Dispatch task via polling mode for long-running async APIs.

        Delegates to polling_dispatcher module which calls Gemini API directly.
        """
        await dispatch_polling(request, target, emitter)

    async def _dispatch_websocket(
        self,
        request: ExecutionRequest,
        target: ExecutionTarget,
        emitter: ResultEmitter,
    ) -> None:
        """Dispatch task via WebSocket - passive request with long connection.

        Executor has already connected to Backend, Backend pushes task to specified room.

        Args:
            request: Execution request
            target: Execution target configuration
            emitter: Result emitter for event emission
        """
        from app.core.socketio import get_sio

        sio = get_sio()

        # Set executor_name on subtask so progress/result events pass ownership check
        # target.room format: "device:{user_id}:{device_id}"
        if target.room:
            parts = target.room.split(":")
            if len(parts) == 3 and parts[0] == "device":
                device_id = parts[2]
                user_id = request.user.get("id") if request.user else None
                await self._set_subtask_executor(request.subtask_id, device_id, user_id)

        # Send START event to frontend (creates AI message placeholder)
        await emitter.emit_start(
            task_id=request.task_id,
            subtask_id=request.subtask_id,
            message_id=request.message_id,
            data={"shell_type": self._get_shell_type(request)},
        )

        # Send task to specified room
        await self._emit_socketio_in_main_loop(sio, target, request.to_dict())

        logger.info(
            f"[ExecutionDispatcher] WebSocket dispatch: "
            f"namespace={target.namespace}, room={target.room}, event={target.event}"
        )

        # In WebSocket mode, subsequent events are handled by DeviceNamespace's
        # on_task_progress/on_task_complete
        # No need to wait for response here

    async def _emit_socketio_in_main_loop(
        self,
        sio: Any,
        target: ExecutionTarget,
        payload: dict,
    ) -> None:
        """Emit Socket.IO events from the main application loop.

        Socket.IO and its Redis manager are owned by the main app loop. Subscription
        device execution runs in a background thread with a separate event loop, so
        direct awaits against `sio.emit()` can fail with cross-loop Future errors.
        """

        async def _emit() -> None:
            await sio.emit(
                target.event,
                payload,
                room=target.room,
                namespace=target.namespace,
            )

        await run_in_main_loop(_emit)

    async def _dispatch_inprocess(
        self,
        request: ExecutionRequest,
        target: ExecutionTarget,
        emitter: ResultEmitter,
    ) -> None:
        """Dispatch task via in-process execution (standalone mode).

        Directly executes tasks within the Backend process. For Chat shell type,
        uses chat_shell module. For ClaudeCode/Agno, uses executor module.

        Args:
            request: Execution request
            target: Execution target configuration (not used, kept for interface consistency)
            emitter: Result emitter for event emission
        """
        shell_type = self._get_shell_type(request)

        logger.info(
            f"[ExecutionDispatcher] In-process dispatch: "
            f"task_id={request.task_id}, subtask_id={request.subtask_id}, "
            f"shell_type={shell_type}"
        )

        # Send START event to frontend (creates AI message placeholder)
        await emitter.emit_start(
            task_id=request.task_id,
            subtask_id=request.subtask_id,
            message_id=request.message_id,
            data={"shell_type": shell_type},
        )

        if shell_type == "Chat":
            # Use chat_shell module for Chat type
            await self._dispatch_inprocess_chat(request, emitter)
        else:
            # Use executor module for ClaudeCode/Agno
            from .inprocess_executor import InprocessExecutor

            executor = InprocessExecutor()
            await executor.execute(request, emitter)

        logger.info(
            f"[ExecutionDispatcher] In-process dispatch completed: "
            f"task_id={request.task_id}, subtask_id={request.subtask_id}"
        )

    async def _dispatch_inprocess_chat(
        self,
        request: ExecutionRequest,
        emitter: ResultEmitter,
    ) -> None:
        """Dispatch Chat type task via in-process chat_shell module.

        Uses chat_shell's ChatService directly for in-process execution.
        Creates a bridge emitter that converts ResponsesAPIEmitter events
        to ResultEmitter events.

        Args:
            request: Execution request
            emitter: Result emitter for event emission
        """
        logger.info(
            f"[ExecutionDispatcher] In-process chat dispatch: "
            f"task_id={request.task_id}, subtask_id={request.subtask_id}"
        )

        try:
            # Import chat_shell's ChatService
            from chat_shell.services.chat_service import ChatService
            from shared.models import EmitterBuilder, ResponsesAPIEmitter

            # Create a bridge transport that forwards events to our ResultEmitter
            bridge_transport = ChatShellBridgeTransport(
                emitter=emitter,
                event_parser=self.event_parser,
                task_id=request.task_id,
                subtask_id=request.subtask_id,
                message_id=request.message_id,
            )

            # Create ResponsesAPIEmitter with bridge transport
            responses_emitter = (
                EmitterBuilder()
                .with_task(request.task_id, request.subtask_id)
                .with_transport(bridge_transport)
                .with_executor_info(name="inprocess-chat", namespace="standalone")
                .build()
            )

            # Create ChatService and process request
            chat_service = ChatService()

            logger.info(
                f"[ExecutionDispatcher] In-process chat: "
                f"task_id={request.task_id}, subtask_id={request.subtask_id}"
            )

            # Call ChatService.chat() which handles all the streaming internally
            await chat_service.chat(request, responses_emitter)

            logger.info(
                f"[ExecutionDispatcher] In-process chat completed: "
                f"task_id={request.task_id}, subtask_id={request.subtask_id}"
            )
        except Exception as e:
            logger.exception(
                f"[ExecutionDispatcher] In-process chat error: "
                f"task_id={request.task_id}, error={e}"
            )
            # Emit error event
            await emitter.emit_error(
                task_id=request.task_id,
                subtask_id=request.subtask_id,
                error=str(e),
                message_id=request.message_id,
            )
            raise

    async def _dispatch_http_callback(
        self,
        request: ExecutionRequest,
        target: ExecutionTarget,
        emitter: ResultEmitter,
    ) -> None:
        """Dispatch task via HTTP+Callback using OpenAI background mode.

        Uses OpenAI Responses API background mode (non-streaming).
        Backend sends HTTP request with background=true, executor executes
        asynchronously and returns result via callback.

        Args:
            request: Execution request
            target: Execution target configuration
            emitter: Result emitter for event emission
        """
        # OpenAI client appends /responses to base_url, so we need to include /v1
        # e.g., base_url=http://127.0.0.1:8001/v1 -> POST http://127.0.0.1:8001/v1/responses
        base_url = f"{target.url}/v1"

        logger.info(
            f"[ExecutionDispatcher] HTTP+Callback dispatch via OpenAI client: "
            f"base_url={base_url}"
        )

        # Convert ExecutionRequest to OpenAI format
        openai_request = OpenAIRequestConverter.from_execution_request(request)

        # Get tools from openai_request (includes MCP servers converted to tools)
        tools = openai_request.get("tools", [])

        logger.info(
            f"[ExecutionDispatcher] Sending OpenAI background request: "
            f"base_url={base_url}, model={openai_request.get('model')}, "
            f"task_id={request.task_id}, subtask_id={request.subtask_id}"
        )

        # Lazy import OpenAI SDK for memory optimization
        from openai import AsyncOpenAI

        # Create OpenAI client pointing to executor-manager
        client = AsyncOpenAI(
            base_url=base_url,
            api_key="dummy",  # Not used by executor_manager but required by client
            timeout=300.0,
        )

        # Send request using OpenAI client with background mode
        # background=true: Execute asynchronously, result via callback
        # stream=false: No streaming, just return queued status
        response = await client.responses.create(
            model=openai_request.get("model", ""),
            input=openai_request.get("input", ""),
            instructions=openai_request.get("instructions"),
            tools=tools if tools else None,
            stream=False,
            extra_body={
                "background": True,
                "metadata": openai_request.get("metadata", {}),
                "model_config": openai_request.get("model_config", {}),
            },
        )

        logger.info(
            f"[ExecutionDispatcher] HTTP+Callback dispatch (OpenAI background): "
            f"response_id={getattr(response, 'id', 'N/A')}"
        )

        # In HTTP+Callback mode, subsequent events are handled via /callback API
        # Only send START event here
        await emitter.emit_start(
            task_id=request.task_id,
            subtask_id=request.subtask_id,
            message_id=request.message_id,
            data={"shell_type": self._get_shell_type(request)},
        )

    def parse_callback_event(
        self,
        task_id: int,
        subtask_id: int,
        message_id: Optional[int],
        event_type: str,
        data: dict,
    ) -> Optional[ExecutionEvent]:
        """Parse callback event data using shared parser.

        This method is exposed for use by HTTP callback handlers.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            message_id: Optional message ID
            event_type: Event type string
            data: Event data dictionary

        Returns:
            Parsed ExecutionEvent or None if event should be skipped
        """
        return self.event_parser.parse(
            task_id=task_id,
            subtask_id=subtask_id,
            message_id=message_id,
            event_type=event_type,
            data=data,
        )

    async def cancel(
        self,
        request: ExecutionRequest,
        device_id: Optional[str] = None,
    ) -> bool:
        """Cancel task.

        Args:
            request: Execution request
            device_id: Optional device ID

        Returns:
            True if cancel request was sent successfully
        """
        target = self.router.route(request, device_id)

        if target.mode == CommunicationMode.SSE:
            return await self._cancel_sse(request, target)
        elif target.mode == CommunicationMode.WEBSOCKET:
            return await self._cancel_websocket(request, target)
        elif target.mode == CommunicationMode.POLLING:
            return await self._cancel_sse(request, target)
        elif target.mode == CommunicationMode.INPROCESS:
            return await self._cancel_inprocess(request, target)
        else:
            return await self._cancel_http(request, target)

    async def _cancel_inprocess(
        self,
        request: ExecutionRequest,
        target: ExecutionTarget,
    ) -> bool:
        """Cancel in-process task.

        For in-process mode, we directly call the executor's cancel method.

        Args:
            request: Execution request
            target: Execution target configuration (not used, kept for interface consistency)

        Returns:
            True if cancel was successful
        """
        from .inprocess_executor import InprocessExecutor

        try:
            executor = InprocessExecutor()
            success = await executor.cancel(request.task_id)
            if success:
                logger.info(
                    f"[ExecutionDispatcher] In-process task cancelled: "
                    f"task_id={request.task_id}"
                )
            return success
        except Exception as e:
            logger.error(
                f"[ExecutionDispatcher] Failed to cancel in-process task: "
                f"task_id={request.task_id}, error={e}"
            )
            return False

    async def _cancel_sse(
        self,
        request: ExecutionRequest,
        target: ExecutionTarget,
    ) -> bool:
        """Cancel SSE task via Redis.

        Uses Redis-based cancellation for distributed multi-instance support.
        The cancellation flag is set in Redis, and the _dispatch_sse method
        periodically checks this flag and breaks out of the stream loop.

        Args:
            request: Execution request
            target: Execution target configuration (not used, kept for interface consistency)

        Returns:
            True if cancel flag was set successfully
        """
        from app.services.chat.storage.session import session_manager

        try:
            success = await session_manager.cancel_stream(request.subtask_id)
            if success:
                logger.info(
                    f"[ExecutionDispatcher] SSE cancel flag set via Redis: "
                    f"subtask_id={request.subtask_id}"
                )
            return success
        except Exception as e:
            logger.error(
                f"[ExecutionDispatcher] Failed to set SSE cancel flag: "
                f"subtask_id={request.subtask_id}, error={e}"
            )
            return False

    async def _cancel_websocket(
        self,
        request: ExecutionRequest,
        target: ExecutionTarget,
    ) -> bool:
        """Cancel task via WebSocket.

        Args:
            request: Execution request
            target: Execution target configuration

        Returns:
            True if cancel request was sent successfully
        """
        from app.core.socketio import get_sio

        sio = get_sio()
        await sio.emit(
            "task:cancel",
            {"task_id": request.task_id, "subtask_id": request.subtask_id},
            room=target.room,
            namespace=target.namespace,
        )
        return True

    async def _cancel_http(
        self,
        request: ExecutionRequest,
        target: ExecutionTarget,
    ) -> bool:
        """Cancel task via HTTP.

        Args:
            request: Execution request
            target: Execution target configuration

        Returns:
            True if cancel request was sent successfully
        """
        url = f"{target.url}/v1/cancel"
        try:
            response = await self.http_client.post(
                url,
                json={"task_id": request.task_id, "subtask_id": request.subtask_id},
            )
            return response.status_code == 200
        except Exception:
            return False

    async def error(
        self,
        request: ExecutionRequest,
        error_message: str,
        device_id: Optional[str] = None,
        emitter: Optional[ResultEmitter] = None,
    ) -> None:
        """Send error event for a task.

        This is used for errors that occur before or outside of task execution,
        such as validation errors in retry/cancel handlers.

        Routes to the appropriate channel based on the request configuration,
        similar to dispatch and cancel methods.

        Args:
            request: Execution request (used for routing and task info)
            error_message: Error message to send
            device_id: Optional device ID for routing
            emitter: Optional emitter for frontend notification. If not provided,
                     only the execution service is notified (no frontend callback).
        """
        # Route to execution target
        target = self.router.route(request, device_id)

        logger.info(
            f"[ExecutionDispatcher] Sending error: task_id={request.task_id}, "
            f"subtask_id={request.subtask_id}, mode={target.mode.value}, "
            f"error={error_message}"
        )

        # Notify execution service based on communication mode
        if target.mode == CommunicationMode.SSE:
            await self._error_sse(request, target, error_message)
        elif target.mode == CommunicationMode.WEBSOCKET:
            await self._error_websocket(request, target, error_message)
        # HTTP mode doesn't need explicit error notification to executor

        # If emitter is provided, also emit error event to frontend
        if emitter is not None:
            # Wrap with StatusUpdatingEmitter for unified status updates
            wrapped_emitter = StatusUpdatingEmitter(
                wrapped=emitter,
                task_id=request.task_id,
                subtask_id=request.subtask_id,
            )
            try:
                await wrapped_emitter.emit_error(
                    task_id=request.task_id,
                    subtask_id=request.subtask_id,
                    error=error_message,
                    message_id=request.message_id,
                )
            finally:
                await wrapped_emitter.close()

    async def _error_sse(
        self,
        request: ExecutionRequest,
        target: ExecutionTarget,
        error_message: str,
    ) -> None:
        """Send error to SSE service.

        For SSE mode, we notify the chat_shell service about the error
        so it can clean up any pending state.

        Args:
            request: Execution request
            target: Execution target configuration
            error_message: Error message
        """
        url = f"{target.url}/v1/responses/error"
        try:
            request_id, _ = self._resolve_request_id(
                request, {"request_id": getattr(request, "request_id", "")}
            )
            await self.http_client.post(
                url,
                json={
                    "request_id": request_id,
                    "error": error_message,
                },
            )
        except Exception as e:
            # Error notification to chat_shell is best-effort
            logger.warning(
                f"[ExecutionDispatcher] Failed to notify SSE service about error: {e}"
            )

    async def _error_websocket(
        self,
        request: ExecutionRequest,
        target: ExecutionTarget,
        error_message: str,
    ) -> None:
        """Send error via WebSocket.

        For WebSocket mode, we send an error event to the device room.

        Args:
            request: Execution request
            target: Execution target configuration
            error_message: Error message
        """
        from app.core.socketio import get_sio

        sio = get_sio()
        await sio.emit(
            "task:error",
            {
                "task_id": request.task_id,
                "subtask_id": request.subtask_id,
                "error": error_message,
            },
            room=target.room,
            namespace=target.namespace,
        )


class ChatShellBridgeTransport:
    """Transport that bridges chat_shell's ResponsesAPIEmitter to Backend's ResultEmitter.

    This transport receives OpenAI Responses API format events from chat_shell
    and converts them to ExecutionEvent format for the Backend's ResultEmitter.
    """

    def __init__(
        self,
        emitter: ResultEmitter,
        event_parser: ResponsesAPIEventParser,
        task_id: int,
        subtask_id: int,
        message_id: Optional[int] = None,
    ):
        """Initialize the bridge transport.

        Args:
            emitter: Backend's ResultEmitter to forward events to
            event_parser: Parser for converting OpenAI events to ExecutionEvent
            task_id: Task ID
            subtask_id: Subtask ID
            message_id: Optional message ID
        """
        self.emitter = emitter
        self.event_parser = event_parser
        self.task_id = task_id
        self.subtask_id = subtask_id
        self.message_id = message_id

    async def send(
        self,
        event_type: str,
        task_id: int,
        subtask_id: int,
        data: dict,
        message_id: Optional[int] = None,
        executor_name: Optional[str] = None,
        executor_namespace: Optional[str] = None,
    ) -> dict:
        """Send event by converting and forwarding to ResultEmitter.

        Args:
            event_type: OpenAI Responses API event type
            task_id: Task ID
            subtask_id: Subtask ID
            data: Event data
            message_id: Optional message ID
            executor_name: Optional executor name
            executor_namespace: Optional executor namespace

        Returns:
            Status dict indicating success
        """
        msg_id = message_id or self.message_id

        # Parse event using shared parser
        parsed_event = self.event_parser.parse(
            task_id=self.task_id,
            subtask_id=self.subtask_id,
            message_id=msg_id,
            event_type=event_type,
            data=data,
        )

        if parsed_event:
            await self.emitter.emit(parsed_event)

        return {"status": "success"}


# Global instance
execution_dispatcher = ExecutionDispatcher()
