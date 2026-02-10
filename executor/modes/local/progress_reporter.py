# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
WebSocket-based progress reporter for local executor mode.

Uses ResponsesAPIEmitter with WebSocketTransport for sending events
via WebSocket to backend.

All events follow OpenAI's official Responses API specification.
"""

from typing import TYPE_CHECKING, Any, Dict, Optional

from executor.modes.local.events import ChatEvents, TaskEvents
from shared.logger import setup_logger
from shared.models import ResponsesAPIEmitter, WebSocketTransport

if TYPE_CHECKING:
    from executor.modes.local.websocket_client import WebSocketClient

logger = setup_logger("websocket_progress_reporter")

# Event type to socket event mapping
EVENT_MAPPING = {
    "response.created": ChatEvents.START,
    "response.in_progress": TaskEvents.PROGRESS,
    "response.output_text.delta": ChatEvents.CHUNK,
    "response.output_text.done": ChatEvents.CHUNK,
    "response.output_item.added": ChatEvents.CHUNK,
    "response.output_item.done": ChatEvents.CHUNK,
    "response.function_call_arguments.delta": ChatEvents.CHUNK,
    "response.function_call_arguments.done": ChatEvents.CHUNK,
    "response.reasoning_summary_part.added": ChatEvents.CHUNK,
    "response.completed": ChatEvents.DONE,
    "response.incomplete": TaskEvents.CANCEL,
    "error": ChatEvents.ERROR,
}


class WebSocketProgressReporter:
    """Progress reporter that sends updates via WebSocket.

    This class wraps ResponsesAPIEmitter with WebSocketTransport
    for local executor mode.
    """

    def __init__(
        self,
        websocket_client: "WebSocketClient",
        task_id: int,
        subtask_id: int,
    ):
        """Initialize the progress reporter.

        Args:
            websocket_client: WebSocket client for sending events.
            task_id: Task ID.
            subtask_id: Subtask ID.
        """
        self.client = websocket_client
        self.task_id = task_id
        self.subtask_id = subtask_id

        # Create emitter with WebSocket transport
        transport = WebSocketTransport(websocket_client, EVENT_MAPPING)
        self.emitter = ResponsesAPIEmitter(
            task_id=task_id,
            subtask_id=subtask_id,
            transport=transport,
        )

    # ============================================================
    # Response Lifecycle Events
    # ============================================================

    async def send_start_event(
        self,
        model: str = "",
        message_id: Optional[int] = None,
        shell_type: Optional[str] = None,
    ) -> None:
        """Send start event (response.created)."""
        self.emitter.message_id = message_id
        await self.emitter.start(shell_type)

    async def send_chunk_event(
        self,
        content: str,
        offset: int = 0,
        message_id: Optional[int] = None,
        result: Optional[Dict[str, Any]] = None,
        block_id: Optional[str] = None,
        block_offset: Optional[int] = None,
    ) -> None:
        """Send chunk event (response.output_text.delta)."""
        self.emitter.message_id = message_id
        await self.emitter.text_delta(content)

    async def send_thinking_event(
        self,
        content: str,
        message_id: Optional[int] = None,
    ) -> None:
        """Send thinking event (response.reasoning_summary_part.added)."""
        self.emitter.message_id = message_id
        await self.emitter.reasoning(content)

    async def send_tool_start_event(
        self,
        tool_use_id: str,
        tool_name: str,
        tool_input: Optional[dict] = None,
        message_id: Optional[int] = None,
        output_index: int = 1,
    ) -> None:
        """Send tool start event."""
        self.emitter.message_id = message_id
        await self.emitter.tool_start(tool_use_id, tool_name, tool_input)

    async def send_tool_result_event(
        self,
        tool_use_id: str,
        tool_name: str = "",
        tool_input: Optional[dict] = None,
        tool_output: Any = None,
        message_id: Optional[int] = None,
        error: Optional[str] = None,
        output_index: int = 1,
    ) -> None:
        """Send tool result event."""
        self.emitter.message_id = message_id
        await self.emitter.tool_done(tool_use_id, tool_name, tool_input)

    async def send_done_event(
        self,
        content: str = "",
        result: Optional[Dict[str, Any]] = None,
        message_id: Optional[int] = None,
        usage: Optional[Dict[str, Any]] = None,
        sources: Optional[list] = None,
        blocks: Optional[list] = None,
        stop_reason: str = "end_turn",
        silent_exit: Optional[bool] = None,
        silent_exit_reason: Optional[str] = None,
        **extra_fields,
    ) -> None:
        """Send done event (response.completed)."""
        self.emitter.message_id = message_id
        if not content and result:
            content = result.get("value", "") or ""
        await self.emitter.done(
            content=content,
            usage=usage,
            stop_reason=stop_reason,
            sources=sources,
            silent_exit=silent_exit,
            silent_exit_reason=silent_exit_reason,
            **extra_fields,
        )

    async def send_error_event(
        self,
        error: str,
        error_code: Optional[str] = None,
        message_id: Optional[int] = None,
    ) -> None:
        """Send error event."""
        self.emitter.message_id = message_id
        await self.emitter.error(error, error_code or "internal_error")

    async def send_progress_event(
        self,
        progress: int,
        status: str,
        content: str = "",
        result: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Send progress event (response.in_progress)."""
        await self.emitter.in_progress()

    async def send_cancelled_event(
        self,
        message_id: Optional[int] = None,
        content: str = "",
    ) -> None:
        """Send cancelled event (response.incomplete)."""
        self.emitter.message_id = message_id
        await self.emitter.incomplete(reason="cancelled", content=content)

    # ============================================================
    # Legacy Methods (for backward compatibility)
    # ============================================================

    async def report_progress(
        self,
        progress: int,
        status: str,
        message: str,
        result: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Report task progress."""
        await self.send_progress_event(progress, status, message, result)

    async def report_result(
        self,
        status: str,
        result: Dict[str, Any],
        message: str = "",
    ) -> None:
        """Report final task result."""
        is_success = status.upper() in ("COMPLETED", "SUCCESS")
        if is_success:
            await self.send_done_event(
                content=message or result.get("value", ""),
                usage=result.get("usage"),
                sources=result.get("sources"),
            )
        else:
            await self.send_error_event(
                error=message or result.get("error", "Unknown error"),
                error_code="execution_error",
            )
