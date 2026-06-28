# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Response event bridge helpers for package-mode chat execution."""

import json
import logging
from typing import Optional

from shared.models import (
    EventType,
    ExecutionEvent,
)
from shared.models.responses_api import ResponsesAPIStreamEvents
from shared.models.responses_api_emitter import EventTransport

from .dispatcher import (
    _build_shell_call_context,
    _extract_reasoning_event_content,
    _extract_shell_call_input,
    _require_non_empty_tool_use_id,
    extract_completed_result,
)
from .emitters import ResultEmitter

logger = logging.getLogger(__name__)


class EmitterBridgeTransport(EventTransport):
    """Transport that bridges executor events to Backend's ResultEmitter.

    This transport converts OpenAI Responses API format events from the executor
    to ExecutionEvent format and emits them via the Backend's ResultEmitter.
    """

    def __init__(
        self,
        emitter: ResultEmitter,
        task_id: int,
        subtask_id: int,
        message_id: Optional[int] = None,
    ):
        """Initialize the bridge transport.

        Args:
            emitter: Backend's ResultEmitter to forward events to
            task_id: Task ID
            subtask_id: Subtask ID
            message_id: Optional message ID
        """
        self.emitter = emitter
        self.task_id = task_id
        self.subtask_id = subtask_id
        self.message_id = message_id
        self._offset = 0  # Track cumulative text offset
        self._tool_contexts: dict[str, dict] = {}

    def _pop_tool_context(self, tool_use_id: str) -> dict:
        """Return tracked tool context or fail fast for invalid tool lifecycles."""
        tool_context = self._tool_contexts.pop(tool_use_id, None)
        if tool_context is None:
            raise ValueError(
                f"Received tool completion event for unknown tool: {tool_use_id}"
            )
        return tool_context

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

        # Convert OpenAI Responses API events to ExecutionEvent
        event = self._convert_event(event_type, data, msg_id)

        if event:
            await self.emitter.emit(event)

        return {"status": "success"}

    def _convert_event(
        self,
        event_type: str,
        data: dict,
        message_id: Optional[int],
    ) -> Optional[ExecutionEvent]:
        """Convert OpenAI Responses API event to ExecutionEvent.

        Args:
            event_type: OpenAI Responses API event type
            data: Event data
            message_id: Optional message ID

        Returns:
            ExecutionEvent or None if event should be skipped
        """
        # response.output_text.delta -> CHUNK
        if event_type == ResponsesAPIStreamEvents.OUTPUT_TEXT_DELTA.value:
            delta = data.get("delta", "")
            event = ExecutionEvent(
                type=EventType.CHUNK.value,
                task_id=self.task_id,
                subtask_id=self.subtask_id,
                content=delta,
                offset=self._offset,
                message_id=message_id,
            )
            self._offset += len(delta)
            return event

        elif event_type == ResponsesAPIStreamEvents.STATUS_UPDATED.value:
            return ExecutionEvent(
                type=EventType.STATUS_UPDATED.value,
                task_id=self.task_id,
                subtask_id=self.subtask_id,
                data={
                    "phase": data.get("phase"),
                    "context_metrics": data.get("context_metrics") or {},
                    "context_compaction": data.get("context_compaction"),
                },
                message_id=message_id,
            )

        # response.completed -> DONE
        elif event_type == ResponsesAPIStreamEvents.RESPONSE_COMPLETED.value:
            response_data = data.get("response", {})
            return ExecutionEvent(
                type=EventType.DONE.value,
                task_id=self.task_id,
                subtask_id=self.subtask_id,
                content="",
                result=extract_completed_result(response_data),
                message_id=message_id,
            )

        elif event_type == ResponsesAPIStreamEvents.BLOCK_CREATED.value:
            block = data.get("block")
            if not isinstance(block, dict):
                return None
            return ExecutionEvent(
                type=EventType.BLOCK_CREATED.value,
                task_id=self.task_id,
                subtask_id=self.subtask_id,
                data={"block": block},
                message_id=message_id,
            )

        elif event_type == ResponsesAPIStreamEvents.BLOCK_UPDATED.value:
            block_id = data.get("block_id")
            updates = data.get("updates")
            if not block_id or not isinstance(updates, dict):
                return None
            return ExecutionEvent(
                type=EventType.BLOCK_UPDATED.value,
                task_id=self.task_id,
                subtask_id=self.subtask_id,
                data={"block_id": str(block_id), "updates": updates},
                message_id=message_id,
            )

        # error -> ERROR
        elif event_type == ResponsesAPIStreamEvents.ERROR.value:
            return ExecutionEvent(
                type=EventType.ERROR.value,
                task_id=self.task_id,
                subtask_id=self.subtask_id,
                error=data.get("message", "Unknown error"),
                message_id=message_id,
            )

        # response.incomplete -> CANCELLED
        elif event_type == ResponsesAPIStreamEvents.RESPONSE_INCOMPLETE.value:
            return ExecutionEvent(
                type=EventType.CANCELLED.value,
                task_id=self.task_id,
                subtask_id=self.subtask_id,
                message_id=message_id,
            )

        # response.output_item.added with function_call -> TOOL_START
        elif event_type == ResponsesAPIStreamEvents.OUTPUT_ITEM_ADDED.value:
            item = data.get("item", {})
            if item.get("type") == "function_call":
                call_id = _require_non_empty_tool_use_id(
                    item.get("call_id") or item.get("id"),
                    context="response.output_item.added(function_call)",
                )
                name = item.get("name", "")
                arguments_str = item.get("arguments", "")
                arguments = {}
                if arguments_str:
                    try:
                        arguments = json.loads(arguments_str)
                    except (json.JSONDecodeError, TypeError):
                        pass
                self._tool_contexts[call_id] = {
                    "protocol": "function_call",
                    "name": name,
                    "arguments": arguments,
                }

                return ExecutionEvent(
                    type=EventType.TOOL_START.value,
                    task_id=self.task_id,
                    subtask_id=self.subtask_id,
                    tool_use_id=call_id,
                    tool_name=name,
                    tool_input=arguments,
                    data={
                        "blocks": data.get("blocks", []),
                        "display_name": data.get("display_name"),
                        "tool_protocol": "function_call",
                    },
                    message_id=message_id,
                )
            if item.get("type") == "mcp_call":
                item_id = _require_non_empty_tool_use_id(
                    item.get("id"),
                    context="response.output_item.added(mcp_call)",
                )
                server_label = item.get("server_label", "")
                name = item.get("name", "")
                self._tool_contexts[item_id] = {
                    "protocol": "mcp_call",
                    "name": name,
                    "server_label": server_label,
                }
                return ExecutionEvent(
                    type=EventType.TOOL_START.value,
                    task_id=self.task_id,
                    subtask_id=self.subtask_id,
                    tool_use_id=item_id,
                    tool_name=name,
                    data={
                        "tool_protocol": "mcp_call",
                        "server_label": server_label,
                    },
                    message_id=message_id,
                )
            if item.get("type") == "shell_call":
                call_id = _require_non_empty_tool_use_id(
                    item.get("call_id") or item.get("id"),
                    context="response.output_item.added(shell_call)",
                )
                tool_context = _build_shell_call_context(item)
                self._tool_contexts[call_id] = tool_context
                return ExecutionEvent(
                    type=EventType.TOOL_START.value,
                    task_id=self.task_id,
                    subtask_id=self.subtask_id,
                    tool_use_id=call_id,
                    tool_name=tool_context["name"],
                    tool_input=tool_context["arguments"],
                    data={
                        "blocks": data.get("blocks", []),
                        "display_name": data.get("display_name"),
                        "tool_protocol": "shell_call",
                    },
                    message_id=message_id,
                )
            return None

        # function_call_arguments.done -> TOOL_RESULT
        elif event_type == ResponsesAPIStreamEvents.FUNCTION_CALL_ARGUMENTS_DONE.value:
            tool_use_id = _require_non_empty_tool_use_id(
                data.get("call_id") or data.get("item_id"),
                context="function_call_arguments.done",
            )
            tool_context = self._pop_tool_context(tool_use_id)
            arguments = tool_context.get("arguments")
            arguments_str = data.get("arguments", "")
            if arguments_str:
                try:
                    arguments = json.loads(arguments_str)
                except (json.JSONDecodeError, TypeError):
                    pass
            return ExecutionEvent(
                type=EventType.TOOL_RESULT.value,
                task_id=self.task_id,
                subtask_id=self.subtask_id,
                tool_name=tool_context.get("name"),
                tool_use_id=tool_use_id,
                tool_input=arguments,
                tool_output=data.get("output"),
                data={
                    "blocks": data.get("blocks", []),
                    "tool_protocol": "function_call",
                },
                message_id=message_id,
            )

        elif event_type == ResponsesAPIStreamEvents.MCP_CALL_ARGUMENTS_DONE.value:
            item_id = _require_non_empty_tool_use_id(
                data.get("item_id"),
                context="response.mcp_call_arguments.done",
            )
            tool_context = self._tool_contexts.get(item_id)
            if tool_context is None:
                raise ValueError(
                    f"Received tool arguments event for unknown tool: {item_id}"
                )
            arguments_str = data.get("arguments", "")
            arguments = None
            if arguments_str:
                try:
                    arguments = json.loads(arguments_str)
                except (json.JSONDecodeError, TypeError):
                    pass
            tool_context["arguments"] = arguments
            return ExecutionEvent(
                type=EventType.TOOL.value,
                task_id=self.task_id,
                subtask_id=self.subtask_id,
                tool_use_id=item_id,
                tool_input=arguments,
                data={"tool_protocol": "mcp_call", "phase": "arguments_done"},
                message_id=message_id,
            )

        elif event_type == ResponsesAPIStreamEvents.MCP_CALL_IN_PROGRESS.value:
            return None

        elif event_type in (
            ResponsesAPIStreamEvents.MCP_CALL_COMPLETED.value,
            ResponsesAPIStreamEvents.MCP_CALL_FAILED.value,
        ):
            item_id = _require_non_empty_tool_use_id(
                data.get("item_id"),
                context=event_type,
            )
            tool_context = self._pop_tool_context(item_id)
            failure_reason = data.get("failure_reason")
            tool_output = (
                failure_reason
                if event_type == ResponsesAPIStreamEvents.MCP_CALL_FAILED.value
                else data.get("output")
            )
            return ExecutionEvent(
                type=EventType.TOOL_RESULT.value,
                task_id=self.task_id,
                subtask_id=self.subtask_id,
                tool_name=tool_context.get("name"),
                tool_use_id=item_id,
                tool_input=tool_context.get("arguments"),
                tool_output=tool_output,
                data={
                    "tool_protocol": "mcp_call",
                    "server_label": tool_context.get("server_label", ""),
                    "status": (
                        "failed"
                        if event_type == ResponsesAPIStreamEvents.MCP_CALL_FAILED.value
                        else "completed"
                    ),
                    "error": failure_reason,
                },
                message_id=message_id,
            )

        elif event_type == ResponsesAPIStreamEvents.OUTPUT_ITEM_DONE.value:
            item = data.get("item", {})
            if item.get("type") != "shell_call":
                return None
            call_id = _require_non_empty_tool_use_id(
                item.get("call_id") or item.get("id"),
                context="response.output_item.done(shell_call)",
            )
            tool_context = self._pop_tool_context(call_id)
            return ExecutionEvent(
                type=EventType.TOOL_RESULT.value,
                task_id=self.task_id,
                subtask_id=self.subtask_id,
                tool_name=tool_context.get("name"),
                tool_use_id=call_id,
                tool_input=_extract_shell_call_input(item)
                or tool_context.get("arguments"),
                data={
                    "tool_protocol": "shell_call",
                    "status": item.get("status", "completed"),
                },
                message_id=message_id,
            )

        elif event_type in (
            ResponsesAPIStreamEvents.RESPONSE_PART_ADDED.value,
            ResponsesAPIStreamEvents.REASONING_SUMMARY_TEXT_DELTA.value,
        ):
            reasoning_content = _extract_reasoning_event_content(event_type, data)
            if reasoning_content is not None:
                return ExecutionEvent(
                    type=EventType.THINKING.value,
                    task_id=self.task_id,
                    subtask_id=self.subtask_id,
                    content=reasoning_content,
                    message_id=message_id,
                )
            return None

        # Skip lifecycle events
        elif event_type in (
            ResponsesAPIStreamEvents.RESPONSE_CREATED.value,
            ResponsesAPIStreamEvents.RESPONSE_IN_PROGRESS.value,
            ResponsesAPIStreamEvents.CONTENT_PART_ADDED.value,
            ResponsesAPIStreamEvents.CONTENT_PART_DONE.value,
            ResponsesAPIStreamEvents.OUTPUT_TEXT_DONE.value,
            ResponsesAPIStreamEvents.FUNCTION_CALL_ARGUMENTS_DELTA.value,
            ResponsesAPIStreamEvents.MCP_CALL_ARGUMENTS_DELTA.value,
        ):
            return None

        # Unknown event type, skip
        logger.debug(
            f"[EmitterBridgeTransport] Unknown event type: {event_type}, skipping"
        )
        return None
