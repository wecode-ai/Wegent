# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""SSE to WebSocket event converter.

This module handles the conversion of SSE events from Chat Shell
to WebSocket events for broadcasting to connected clients.
"""

import logging
from typing import Any

from shared.models import EventType, ExecutionEvent

logger = logging.getLogger(__name__)


class SSEToWebSocketConverter:
    """Converts SSE events from Chat Shell to WebSocket events.

    This class bridges the gap between Chat Shell's SSE output
    and Backend's WebSocket-based client communication.
    """

    def __init__(self, task_id: int, task_room: str):
        """Initialize converter.

        Args:
            task_id: Task ID for event routing
            task_room: WebSocket room name
        """
        self.task_id = task_id
        self.task_room = task_room

    async def convert_and_emit(self, event: ExecutionEvent) -> None:
        """Convert SSE event to WebSocket event and emit.

        Args:
            event: ExecutionEvent from Chat Shell
        """
        # Import here to avoid circular import
        from app.services.chat.ws_emitter import get_ws_emitter

        ws_emitter = get_ws_emitter()
        if not ws_emitter:
            logger.warning("[SSE_WS_CONVERTER] WebSocket emitter not available")
            return

        subtask_id = event.subtask_id

        try:
            if event.type == EventType.START.value:
                await ws_emitter.emit_chat_start(
                    task_id=self.task_id,
                    subtask_id=subtask_id,
                    shell_type=event.data.get("shell_type", "Chat"),
                )

            elif event.type == EventType.CHUNK.value:
                await ws_emitter.emit_chat_chunk(
                    task_id=self.task_id,
                    subtask_id=subtask_id,
                    content=event.content or "",
                    offset=event.offset,
                    result=event.result,
                    block_id=event.data.get("block_id"),
                    block_offset=event.data.get("block_offset"),
                )

            elif event.type == EventType.THINKING.value:
                # Emit thinking step as part of result in chunk
                result = {
                    "shell_type": "Chat",
                    "thinking": [{"content": event.content}],
                    "blocks": event.data.get("blocks", []),
                }
                await ws_emitter.emit_chat_chunk(
                    task_id=self.task_id,
                    subtask_id=subtask_id,
                    content="",
                    offset=event.offset,
                    result=result,
                )

            elif event.type == EventType.TOOL_START.value:
                # Tool start is part of thinking
                await self._emit_tool_event(ws_emitter, subtask_id, event, "start")

            elif event.type == EventType.TOOL_RESULT.value:
                # Tool result is part of thinking
                await self._emit_tool_event(ws_emitter, subtask_id, event, "result")

            elif event.type == EventType.DONE.value:
                await ws_emitter.emit_chat_done(
                    task_id=self.task_id,
                    subtask_id=subtask_id,
                    offset=event.offset,
                    result=event.result or {},
                    message_id=event.message_id,
                )

            elif event.type == EventType.CANCELLED.value:
                await ws_emitter.emit_chat_cancelled(
                    task_id=self.task_id,
                    subtask_id=subtask_id,
                )

            elif event.type == EventType.ERROR.value:
                await ws_emitter.emit_chat_error(
                    task_id=self.task_id,
                    subtask_id=subtask_id,
                    error=event.error or "Unknown error",
                )

            else:
                logger.warning(
                    "[SSE_WS_CONVERTER] Unknown event type: %s",
                    event.type,
                )

        except Exception:
            logger.exception("[SSE_WS_CONVERTER] Error converting event")

    async def _emit_tool_event(
        self,
        ws_emitter: Any,
        subtask_id: int,
        event: ExecutionEvent,
        status: str,
    ) -> None:
        """Emit tool event as thinking step.

        Args:
            ws_emitter: WebSocket emitter instance
            subtask_id: Subtask ID
            event: ExecutionEvent with tool data
            status: "start" or "result"
        """
        thinking_step = {
            "title": event.tool_name or "Tool",
            "next_action": "continue" if status == "start" else "complete",
            "details": {
                "type": "tool_use" if status == "start" else "tool_result",
                "status": status,
                "tool_name": event.tool_name,
                "input": event.tool_input if status == "start" else None,
                "output": event.tool_output if status == "result" else None,
            },
        }

        result = {
            "shell_type": "Chat",
            "thinking": [thinking_step],
        }

        # Include blocks if present in data
        if event.data.get("blocks"):
            result["blocks"] = event.data["blocks"]

        await ws_emitter.emit_chat_chunk(
            task_id=self.task_id,
            subtask_id=subtask_id,
            content="",
            offset=event.offset,
            result=result,
        )


async def stream_sse_to_websocket(
    task_id: int,
    task_room: str,
    sse_stream,
) -> None:
    """Stream SSE events to WebSocket.

    This function consumes an async iterator of ExecutionEvents from Chat Shell
    and converts them to WebSocket events.

    Args:
        task_id: Task ID for event routing
        task_room: WebSocket room name
        sse_stream: Async iterator of ExecutionEvents
    """
    converter = SSEToWebSocketConverter(task_id, task_room)

    async for event in sse_stream:
        await converter.convert_and_emit(event)

        # Stop if we receive a terminal event
        if event.type in (
            EventType.DONE.value,
            EventType.ERROR.value,
            EventType.CANCELLED.value,
        ):
            break
