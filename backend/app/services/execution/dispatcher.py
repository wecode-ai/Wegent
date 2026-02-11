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
from typing import Any, List, Optional

from openai import AsyncOpenAI

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
from .router import CommunicationMode, ExecutionRouter, ExecutionTarget

logger = logging.getLogger(__name__)


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
            return ExecutionEvent(
                type=EventType.CHUNK,
                task_id=task_id,
                subtask_id=subtask_id,
                content=data.get("delta", ""),
                offset=0,
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
            usage = response_data.get("usage")

            # Extract text content from response output
            value = ""
            output_items = response_data.get("output", [])
            for item in output_items:
                if isinstance(item, dict):
                    for content_block in item.get("content", []):
                        if isinstance(content_block, dict) and content_block.get(
                            "text"
                        ):
                            value += content_block["text"]

            return ExecutionEvent(
                type=EventType.DONE,
                task_id=task_id,
                subtask_id=subtask_id,
                content="",
                result={
                    "value": value,
                    "usage": usage,
                    "sources": response_data.get("sources"),
                    "blocks": response_data.get("blocks"),
                    "silent_exit": response_data.get("silent_exit"),
                    "silent_exit_reason": response_data.get("silent_exit_reason"),
                    "loaded_skills": response_data.get("loaded_skills"),
                    "stop_reason": response_data.get("stop_reason"),
                },
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
            return ExecutionEvent(
                type=EventType.TOOL_RESULT,
                task_id=task_id,
                subtask_id=subtask_id,
                tool_use_id=data.get("call_id", data.get("item_id")),
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
                call_id = item.get("call_id") or item.get("id", "")
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
        # Route to execution target
        target = self.router.route(request, device_id)
        logger.info(
            f"[ExecutionDispatcher] Routed: task_id={request.task_id}, "
            f"subtask_id={request.subtask_id}, device_id={device_id} -> {target}"
        )
        # Create default emitter if not provided
        if emitter is None:
            emitter = WebSocketResultEmitter(
                task_id=request.task_id,
                subtask_id=request.subtask_id,
                user_id=request.user.get("id") if request.user else None,
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

        try:
            if target.mode == CommunicationMode.SSE:
                await self._dispatch_sse(request, target, wrapped_emitter)
            elif target.mode == CommunicationMode.WEBSOCKET:
                await self._dispatch_websocket(request, target, wrapped_emitter)
            else:
                await self._dispatch_http_callback(request, target, wrapped_emitter)
        except Exception as e:
            logger.exception("[ExecutionDispatcher] Error")
            await wrapped_emitter.emit_error(
                task_id=request.task_id,
                subtask_id=request.subtask_id,
                error=str(e),
            )
        finally:
            await wrapped_emitter.close()

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
        """Dispatch task via SSE using OpenAI client.

        Uses AsyncOpenAI client to consume OpenAI Responses API compatible endpoint.
        Converts ExecutionRequest to OpenAI format, sends request, and processes
        streaming events.

        Args:
            request: Execution request
            target: Execution target configuration
            emitter: Result emitter for event emission
        """
        # OpenAI client appends /responses to base_url, so we need to include /v1
        # e.g., base_url=http://127.0.0.1:8100/v1 -> POST http://127.0.0.1:8100/v1/responses
        base_url = f"{target.url}/v1"

        logger.info(
            f"[ExecutionDispatcher] SSE dispatch via OpenAI client: base_url={base_url}"
        )

        # Send START event
        await emitter.emit_start(
            task_id=request.task_id,
            subtask_id=request.subtask_id,
            message_id=request.message_id,
            data={"shell_type": self._get_shell_type(request)},
        )

        # Create OpenAI client pointing to chat_shell
        client = AsyncOpenAI(
            base_url=base_url,
            api_key="dummy",  # Not used by chat_shell but required by client
            timeout=300.0,
        )

        # Convert ExecutionRequest to OpenAI format
        openai_request = OpenAIRequestConverter.from_execution_request(request)

        # Get tools from openai_request (includes MCP servers converted to tools)
        tools = openai_request.get("tools", [])

        logger.info(
            f"[ExecutionDispatcher] Sending OpenAI request: model={openai_request.get('model')}, "
            f"task_id={request.task_id}, subtask_id={request.subtask_id}, "
            f"tools_count={len(tools)}"
        )

        # Stream response using OpenAI client
        # Note: tools is a first-class parameter in OpenAI Responses API, not in extra_body
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

        # Process streaming events
        async for event in stream:
            # Get event type from the event object
            event_type = getattr(event, "type", None)
            if not event_type:
                continue

            # Convert event to dict for parsing
            event_data = (
                event.model_dump() if hasattr(event, "model_dump") else vars(event)
            )

            # Log raw event data
            logger.info(
                f"[ExecutionDispatcher] Raw SSE event: type={event_type}, "
                f"data={json.dumps(event_data, ensure_ascii=False, default=str)}"
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
                await emitter.emit(parsed_event)

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
        await sio.emit(
            target.event,
            request.to_dict(),
            room=target.room,
            namespace=target.namespace,
        )

        logger.info(
            f"[ExecutionDispatcher] WebSocket dispatch: "
            f"namespace={target.namespace}, room={target.room}, event={target.event}"
        )

        # In WebSocket mode, subsequent events are handled by DeviceNamespace's
        # on_task_progress/on_task_complete
        # No need to wait for response here

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
        else:
            return await self._cancel_http(request, target)

    async def _cancel_sse(
        self,
        request: ExecutionRequest,
        target: ExecutionTarget,
    ) -> bool:
        """Cancel SSE task.

        Args:
            request: Execution request
            target: Execution target configuration

        Returns:
            True if cancel request was sent successfully
        """
        url = f"{target.url}/v1/responses/cancel"
        try:
            response = await self.http_client.post(
                url,
                json={"request_id": f"req_{request.subtask_id}"},
            )
            return response.status_code == 200
        except Exception:
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


# Global instance
execution_dispatcher = ExecutionDispatcher()
