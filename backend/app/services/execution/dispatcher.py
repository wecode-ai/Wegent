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
"""

import json
import logging
from typing import List, Optional

import httpx

from shared.models import EventType, ExecutionEvent, ExecutionRequest
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
                await self._dispatch_websocket(request, target)
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
        """Dispatch task via SSE - active request with long connection.

        Backend actively sends request to executor, executor returns SSE stream.

        Args:
            request: Execution request
            target: Execution target configuration
            emitter: Result emitter for event emission
        """
        url = f"{target.url}{target.endpoint}"

        logger.info(f"[ExecutionDispatcher] SSE dispatch: url={url}")

        # Send START event
        await emitter.emit_start(
            task_id=request.task_id,
            subtask_id=request.subtask_id,
            message_id=request.message_id,
        )

        # Send SSE request and process stream
        async with self.http_client.stream(
            "POST",
            url,
            json=request.to_dict(),
        ) as response:
            async for line in response.aiter_lines():
                if line.startswith("data: "):
                    data_str = line[6:]
                    if data_str == "[DONE]":
                        continue
                    try:
                        data = json.loads(data_str)
                        event = self._parse_sse_event(request, data)
                        await emitter.emit(event)
                    except json.JSONDecodeError:
                        logger.warning(
                            f"[ExecutionDispatcher] Invalid SSE data: {data_str}"
                        )

    async def _dispatch_websocket(
        self,
        request: ExecutionRequest,
        target: ExecutionTarget,
    ) -> None:
        """Dispatch task via WebSocket - passive request with long connection.

        Executor has already connected to Backend, Backend pushes task to specified room.

        Args:
            request: Execution request
            target: Execution target configuration
        """
        from app.core.socketio import get_sio
        from app.services.chat.ws_emitter import safe_emit_in_main_loop

        sio = get_sio()

        # Send task to specified room
        await safe_emit_in_main_loop(
            sio.emit,
            target.event,
            request.to_dict(),
            room=target.room,
            namespace=target.namespace,
        )

        logger.info(
            f"[ExecutionDispatcher] WebSocket dispatch: "
            f"namespace={target.namespace}, room={target.room}, event={target.event}"
        )

        # In WebSocket mode, events are handled by DeviceNamespace's
        # on_task_progress/on_task_complete
        # No need to wait for response here

    async def _dispatch_http_callback(
        self,
        request: ExecutionRequest,
        target: ExecutionTarget,
        emitter: ResultEmitter,
    ) -> None:
        """Dispatch task via HTTP+Callback.

        Backend sends HTTP request, executor executes asynchronously
        and returns result via callback.

        Args:
            request: Execution request
            target: Execution target configuration
            emitter: Result emitter for event emission
        """
        url = f"{target.url}{target.endpoint}"
        logger.info(f"[ExecutionDispatcher] HTTP+Callback dispatch: url={url}")

        # Build ExecuteRequest payload expected by executor_manager
        shell_type = request.bot[0].get("shell_type") if request.bot else None
        execute_request = {
            "task_id": request.task_id,
            "subtask_id": request.subtask_id,
            "executor_name": request.executor_name,
            "shell_type": shell_type,
            "payload": request.to_dict(),
        }

        # Send request
        response = await self.http_client.post(
            url,
            json=execute_request,
        )

        if response.status_code != 200:
            detail = response.text[:500] if response.text else "no detail"
            raise Exception(
                f"HTTP dispatch failed: {response.status_code}, detail={detail}"
            )

        logger.info(
            f"[ExecutionDispatcher] HTTP+Callback dispatch: "
            f"url={url}, status={response.status_code}"
        )

        # In HTTP+Callback mode, subsequent events are handled via /callback API
        # Only send START event here
        await emitter.emit_start(
            task_id=request.task_id,
            subtask_id=request.subtask_id,
            message_id=request.message_id,
        )

    def _parse_sse_event(self, request: ExecutionRequest, data: dict) -> ExecutionEvent:
        """Parse SSE event data.

        Args:
            request: Original execution request
            data: SSE event data dictionary

        Returns:
            Parsed ExecutionEvent
        """
        event_type_str = data.get("type", "chunk")
        try:
            event_type = EventType(event_type_str)
        except ValueError:
            event_type = EventType.CHUNK

        return ExecutionEvent(
            type=event_type,
            task_id=request.task_id,
            subtask_id=request.subtask_id,
            content=data.get("content", ""),
            offset=data.get("offset", 0),
            result=data.get("result"),
            error=data.get("error"),
            message_id=request.message_id,
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
        url = f"{target.url}/v1/cancel"
        try:
            response = await self.http_client.post(
                url,
                json={"task_id": request.task_id, "subtask_id": request.subtask_id},
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
        from app.services.chat.ws_emitter import safe_emit_in_main_loop

        sio = get_sio()
        await safe_emit_in_main_loop(
            sio.emit,
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
