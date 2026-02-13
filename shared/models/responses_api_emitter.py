# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unified event emitter for OpenAI Responses API format.

This module provides a unified interface for emitting streaming events
across different transport mechanisms (SSE, HTTP callback, WebSocket).

Design:
- ResponsesAPIEventBuilder: Generates event data (stateful, maintains context)
- ResponsesAPIEmitter: Abstract base class for emitting events
- Concrete implementations for different transports

Usage:
    # Create emitter with specific transport
    emitter = ResponsesAPIEmitter.create(subtask_id, transport="callback", client=callback_client)

    # Emit events using simple API
    await emitter.start(shell_type="Chat")
    await emitter.text_delta("Hello")
    await emitter.tool_start("tool_123", "read_file", {"path": "test.py"})
    await emitter.tool_done("tool_123", "read_file", {"path": "test.py"})
    await emitter.done(content="Hello world", usage={"input_tokens": 10})
"""

import json
import logging
import time
import uuid
from abc import ABC, abstractmethod
from typing import Any, Callable, Optional, Union

from .responses_api import ResponsesAPIEventBuilder, ResponsesAPIStreamEvents

logger = logging.getLogger(__name__)

__all__ = [
    "ResponsesAPIEmitter",
    "CallbackTransport",
    "WebSocketTransport",
    "GeneratorTransport",
]


class ResponsesAPIEmitter:
    """Unified event emitter for OpenAI Responses API format.

    This class combines event building and transport into a simple API.
    Events are generated using ResponsesAPIEventBuilder and sent via
    the configured transport.

    Supports three transport modes:
    - callback: HTTP callback (executor -> executor_manager -> backend)
    - websocket: WebSocket (executor local mode -> backend)
    - generator: Yield events (chat_shell SSE mode)
    """

    def __init__(
        self,
        task_id: int,
        subtask_id: int,
        transport: "EventTransport",
        model: str = "",
        message_id: Optional[int] = None,
        executor_name: Optional[str] = None,
        executor_namespace: Optional[str] = None,
    ):
        """Initialize the emitter.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            transport: Transport implementation for sending events
            model: Model identifier
            message_id: Optional message ID
            executor_name: Optional executor name
            executor_namespace: Optional executor namespace
        """
        self.task_id = task_id
        self.subtask_id = subtask_id
        self.transport = transport
        self.message_id = message_id
        self.executor_name = executor_name
        self.executor_namespace = executor_namespace
        self.builder = ResponsesAPIEventBuilder(subtask_id, model)

    # ============================================================
    # Response Lifecycle Events
    # ============================================================

    async def start(self, shell_type: Optional[str] = None) -> Any:
        """Emit response.created event.

        Args:
            shell_type: Optional shell type (Wegent extension)

        Returns:
            Transport-specific result
        """
        data = self.builder.response_created(shell_type)
        return await self._emit(ResponsesAPIStreamEvents.RESPONSE_CREATED.value, data)

    async def in_progress(self) -> Any:
        """Emit response.in_progress event.

        Returns:
            Transport-specific result
        """
        data = self.builder.response_in_progress()
        return await self._emit(
            ResponsesAPIStreamEvents.RESPONSE_IN_PROGRESS.value, data
        )

    async def done(
        self,
        content: str = "",
        usage: Optional[dict] = None,
        stop_reason: str = "end_turn",
        sources: Optional[list] = None,
        silent_exit: Optional[bool] = None,
        silent_exit_reason: Optional[str] = None,
        **extra_fields,
    ) -> Any:
        """Emit response.completed event.

        Automatically flushes any buffered events before sending the done event.

        Args:
            content: Full response content
            usage: Token usage info
            stop_reason: Stop reason
            sources: Source references
            silent_exit: Silent exit flag
            silent_exit_reason: Silent exit reason
            **extra_fields: Additional fields

        Returns:
            Transport-specific result
        """
        # Flush any buffered events before sending done
        await self.flush()

        data = self.builder.response_completed(
            content=content,
            usage=usage,
            stop_reason=stop_reason,
            sources=sources,
            silent_exit=silent_exit,
            silent_exit_reason=silent_exit_reason,
            **extra_fields,
        )
        return await self._emit(ResponsesAPIStreamEvents.RESPONSE_COMPLETED.value, data)

    async def incomplete(self, reason: str = "cancelled", content: str = "") -> Any:
        """Emit response.incomplete event.

        Automatically flushes any buffered events before sending the incomplete event.

        Args:
            reason: Reason for incompletion
            content: Partial content

        Returns:
            Transport-specific result
        """
        # Flush any buffered events before sending incomplete
        await self.flush()

        data = self.builder.response_incomplete(reason, content)
        return await self._emit(
            ResponsesAPIStreamEvents.RESPONSE_INCOMPLETE.value, data
        )

    async def error(self, message: str, code: str = "internal_error") -> Any:
        """Emit error event.

        Automatically flushes any buffered events before sending the error event.

        Args:
            message: Error message
            code: Error code

        Returns:
            Transport-specific result
        """
        # Flush any buffered events before sending error
        await self.flush()

        data = self.builder.error(message, code)
        return await self._emit(ResponsesAPIStreamEvents.ERROR.value, data)

    # ============================================================
    # Text Streaming Events
    # ============================================================

    async def text_delta(self, delta: str) -> Any:
        """Emit response.output_text.delta event.

        Args:
            delta: Text delta

        Returns:
            Transport-specific result
        """
        data = self.builder.text_delta(delta)
        return await self._emit(ResponsesAPIStreamEvents.OUTPUT_TEXT_DELTA.value, data)

    async def text_done(self, text: str) -> Any:
        """Emit response.output_text.done event.

        Args:
            text: Full text content

        Returns:
            Transport-specific result
        """
        data = self.builder.text_done(text)
        return await self._emit(ResponsesAPIStreamEvents.OUTPUT_TEXT_DONE.value, data)

    # ============================================================
    # Function Call Events
    # ============================================================

    async def tool_start(
        self,
        call_id: str,
        name: str,
        arguments: Optional[dict] = None,
        display_name: Optional[str] = None,
    ) -> Any:
        """Emit function call start events.

        Sends: output_item.added + function_call_arguments.delta

        For GeneratorTransport, this method enables collecting mode so that
        both events can be retrieved via get_events() after this call.

        Args:
            call_id: Function call ID
            name: Function name
            arguments: Function arguments
            display_name: Optional display name for the tool (Wegent extension)

        Returns:
            Transport-specific result
        """
        # Enable collecting mode for GeneratorTransport
        if hasattr(self.transport, "start_collecting"):
            self.transport.start_collecting()

        # Send function call added
        added_data = self.builder.function_call_added(call_id, name, display_name)
        await self._emit(ResponsesAPIStreamEvents.OUTPUT_ITEM_ADDED.value, added_data)

        # Send arguments delta
        delta_data = self.builder.function_call_arguments_delta(call_id, arguments)
        return await self._emit(
            ResponsesAPIStreamEvents.FUNCTION_CALL_ARGUMENTS_DELTA.value, delta_data
        )

    async def tool_done(
        self,
        call_id: str,
        name: str,
        arguments: Optional[dict] = None,
        output: Optional[str] = None,
    ) -> Any:
        """Emit function call done events.

        Sends: function_call_arguments.done + output_item.done

        For GeneratorTransport, this method enables collecting mode so that
        both events can be retrieved via get_events() after this call.

        Args:
            call_id: Function call ID
            name: Function name
            arguments: Function arguments
            output: Tool execution output (Wegent extension)

        Returns:
            Transport-specific result
        """
        # Enable collecting mode for GeneratorTransport
        if hasattr(self.transport, "start_collecting"):
            self.transport.start_collecting()

        # Send arguments done (with output for tool result)
        done_data = self.builder.function_call_arguments_done(call_id, arguments, output)
        await self._emit(
            ResponsesAPIStreamEvents.FUNCTION_CALL_ARGUMENTS_DONE.value, done_data
        )

        # Send function call done
        item_done_data = self.builder.function_call_done(call_id, name, arguments)
        return await self._emit(
            ResponsesAPIStreamEvents.OUTPUT_ITEM_DONE.value, item_done_data
        )

    # ============================================================
    # Reasoning Events
    # ============================================================

    async def reasoning(self, content: str) -> Any:
        """Emit reasoning/thinking event.

        Args:
            content: Reasoning content

        Returns:
            Transport-specific result
        """
        data = self.builder.reasoning(content)
        return await self._emit(
            ResponsesAPIStreamEvents.RESPONSE_PART_ADDED.value, data
        )

    # ============================================================
    # Buffer Management
    # ============================================================

    async def flush(self) -> None:
        """Flush any buffered events in the transport.

        This method should be called before sending terminal events (done, error, incomplete)
        to ensure all buffered text_delta events are sent first.

        For ThrottledTransport, this flushes all pending buffers.
        For other transports, this is a no-op.
        """
        if hasattr(self.transport, "flush_all"):
            await self.transport.flush_all()

    # ============================================================
    # Internal Methods
    # ============================================================

    async def _emit(self, event_type: str, data: dict) -> Any:
        """Emit event via transport.

        Args:
            event_type: Event type string
            data: Event data

        Returns:
            Transport-specific result
        """
        return await self.transport.send(
            event_type=event_type,
            task_id=self.task_id,
            subtask_id=self.subtask_id,
            data=data,
            message_id=self.message_id,
            executor_name=self.executor_name,
            executor_namespace=self.executor_namespace,
        )


class EventTransport(ABC):
    """Abstract base class for event transport."""

    @abstractmethod
    async def send(
        self,
        event_type: str,
        task_id: int,
        subtask_id: int,
        data: dict,
        message_id: Optional[int] = None,
        executor_name: Optional[str] = None,
        executor_namespace: Optional[str] = None,
    ) -> Any:
        """Send event via transport.

        Args:
            event_type: Event type string
            task_id: Task ID
            subtask_id: Subtask ID
            data: Event data
            message_id: Optional message ID
            executor_name: Optional executor name
            executor_namespace: Optional executor namespace

        Returns:
            Transport-specific result
        """
        pass


class CallbackTransport(EventTransport):
    """HTTP callback transport for executor -> executor_manager -> backend."""

    def __init__(self, client: Any):
        """Initialize callback transport.

        Args:
            client: Callback client with send_event_dict method
        """
        self.client = client

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
        """Send event via HTTP callback.

        Returns:
            Callback response dict
        """
        event = {
            "event_type": event_type,
            "task_id": task_id,
            "subtask_id": subtask_id,
            "data": data,
        }
        if message_id is not None:
            event["message_id"] = message_id
        if executor_name is not None:
            event["executor_name"] = executor_name
        if executor_namespace is not None:
            event["executor_namespace"] = executor_namespace

        return self.client.send_event_dict(event)


class WebSocketTransport(EventTransport):
    """WebSocket transport for executor local mode."""

    def __init__(self, client: Any, event_mapping: Optional[dict] = None):
        """Initialize WebSocket transport.

        Args:
            client: WebSocket client with emit method
            event_mapping: Optional mapping from event_type to socket event name
        """
        self.client = client
        self.event_mapping = event_mapping or {}

    async def send(
        self,
        event_type: str,
        task_id: int,
        subtask_id: int,
        data: dict,
        message_id: Optional[int] = None,
        executor_name: Optional[str] = None,
        executor_namespace: Optional[str] = None,
    ) -> None:
        """Send event via WebSocket.

        Returns:
            None
        """
        payload = {
            "event_type": event_type,
            "task_id": task_id,
            "subtask_id": subtask_id,
            "data": data,
        }
        if message_id is not None:
            payload["message_id"] = message_id

        # Map event_type to socket event name
        socket_event = self.event_mapping.get(event_type, "chat:chunk")
        await self.client.emit(socket_event, payload)


class GeneratorTransport(EventTransport):
    """Generator transport for SSE mode (chat_shell).

    This transport collects events for retrieval via get_events().
    Events are always collected by default for SSE streaming scenarios.
    For scenarios that need to disable collecting, use stop_collecting().
    """

    def __init__(
        self,
        callback: Optional[Callable[[str, dict], Any]] = None,
        auto_collect: bool = True,
    ):
        """Initialize generator transport.

        Args:
            callback: Optional callback function(event_type, data) to process events
            auto_collect: Whether to automatically collect events (default: True)
        """
        self.callback = callback
        self.events: list[tuple[str, dict]] = []
        self._collecting = auto_collect

    async def send(
        self,
        event_type: str,
        task_id: int,
        subtask_id: int,
        data: dict,
        message_id: Optional[int] = None,
        executor_name: Optional[str] = None,
        executor_namespace: Optional[str] = None,
    ) -> tuple[str, dict]:
        """Send event and optionally collect it.

        When collecting mode is enabled (via start_collecting() or emitter methods
        that emit multiple events), events are added to the internal list.
        Otherwise, events are just returned for immediate yielding.

        Returns:
            Tuple of (event_type, data) for yielding
        """
        if self.callback:
            return self.callback(event_type, data)
        if self._collecting:
            self.events.append((event_type, data))
        return (event_type, data)

    def start_collecting(self) -> None:
        """Start collecting events into the internal list."""
        self._collecting = True

    def stop_collecting(self) -> None:
        """Stop collecting events."""
        self._collecting = False

    def get_events(self) -> list[tuple[str, dict]]:
        """Get and clear collected events.

        Note: This method does NOT stop collecting mode.
        Events will continue to be collected after this call.

        Returns:
            List of (event_type, data) tuples
        """
        events = self.events.copy()
        self.events.clear()
        return events
