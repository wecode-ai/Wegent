# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0


"""Convert Responses API events to execution events for every transport."""

import json
import logging
from typing import Any, Optional

from shared.models import EventType, ExecutionEvent
from shared.models.responses_api import ResponsesAPIStreamEvents

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


def _extract_shell_call_input(item: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    shell_input = item.get("input")
    if isinstance(shell_input, dict):
        result.update(shell_input)

    action = item.get("action", {})
    if not isinstance(action, dict):
        return result

    commands = action.get("commands") or []
    if "command" not in result and isinstance(commands, list):
        command = next(
            (value for value in commands if isinstance(value, str) and value.strip()),
            None,
        )
        if command:
            result["command"] = command
    if "timeout_seconds" not in result:
        timeout_ms = action.get("timeout_ms")
        if isinstance(timeout_ms, int) and timeout_ms > 0:
            result["timeout_seconds"] = max(1, (timeout_ms + 999) // 1000)
    return result


def _extract_reasoning_event_content(
    event_type: str, data: dict[str, Any]
) -> Optional[str]:
    if event_type == ResponsesAPIStreamEvents.REASONING_SUMMARY_TEXT_DELTA.value:
        delta = data.get("delta")
        if delta is None:
            return ""
        return delta if isinstance(delta, str) else str(delta)

    if event_type == ResponsesAPIStreamEvents.RESPONSE_PART_ADDED.value:
        part = data.get("part", {})
        if isinstance(part, dict) and part.get("type") == "reasoning":
            text = part.get("text")
            if text is None:
                return ""
            return text if isinstance(text, str) else str(text)

    return None


def _build_shell_call_context(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "protocol": "shell_call",
        "name": item.get("name", ""),
        "arguments": _extract_shell_call_input(item),
    }


def extract_completed_result(response_data: dict) -> dict:
    """Build a result dict from a ``response.completed`` payload.

    Shared by :class:`ResponsesAPIEventParser` and response bridge transport so
    the field list is maintained in one place.
    """
    # Extract text content from response output
    value = ""
    reasoning_parts: list[str] = []
    for item in response_data.get("output") or []:
        if isinstance(item, dict):
            for content_block in item.get("content", []):
                if not isinstance(content_block, dict):
                    continue
                text = content_block.get("text")
                if not text:
                    continue
                block_type = content_block.get("type")
                if block_type == "reasoning":
                    reasoning_parts.append(text)
                elif block_type in (None, "output_text", "text"):
                    value += text

    reasoning_content = response_data.get("reasoning_content")
    if reasoning_content is None and reasoning_parts:
        reasoning_content = "".join(reasoning_parts)

    return {
        "value": value,
        "usage": response_data.get("usage"),
        "sources": response_data.get("sources"),
        "retrieval_summary": response_data.get("retrieval_summary"),
        "blocks": response_data.get("blocks"),
        "silent_exit": response_data.get("silent_exit"),
        "silent_exit_reason": response_data.get("silent_exit_reason"),
        "deferred_user_input": response_data.get("deferred_user_input"),
        "deferred_user_input_tool_use_id": response_data.get(
            "deferred_user_input_tool_use_id"
        ),
        "loaded_skills": response_data.get("loaded_skills"),
        "stop_reason": response_data.get("stop_reason"),
        "termination_reason": response_data.get("termination_reason"),
        "messages_chain": response_data.get("messages_chain"),
        "context_metrics": response_data.get("context_metrics"),
        "context_compactions": response_data.get("context_compactions"),
        "standalone_chat_workspace_path": response_data.get(
            "standalone_chat_workspace_path"
        ),
        "file_changes": response_data.get("file_changes"),
        "executor_session": response_data.get("executor_session"),
        "reasoning_content": reasoning_content,
    }


class ResponsesAPIEventParser:
    """Parser for OpenAI Responses API format events.

    This parser is shared between SSE and HTTP callback modes.
    It converts OpenAI Responses API events to internal ExecutionEvent format.
    """

    def __init__(self) -> None:
        self._tool_contexts: dict[str, dict[str, Any]] = {}
        self._reasoning_buffers: dict[str, str] = {}

    @staticmethod
    def _tool_key(task_id: int, subtask_id: int, tool_use_id: str) -> str:
        """Build a stable context key scoped to the request lifecycle."""
        return f"{task_id}:{subtask_id}:{tool_use_id}"

    @staticmethod
    def _request_key(task_id: int, subtask_id: int) -> str:
        """Build a stable request key for stream-scoped state."""
        return f"{task_id}:{subtask_id}"

    def _clear_task_contexts(self, task_id: int, subtask_id: int) -> None:
        prefix = f"{task_id}:{subtask_id}:"
        stale_keys = [key for key in self._tool_contexts if key.startswith(prefix)]
        for key in stale_keys:
            self._tool_contexts.pop(key, None)
        self._reasoning_buffers.pop(self._request_key(task_id, subtask_id), None)

    def parse(
        self,
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
        if event_type == ResponsesAPIStreamEvents.RESPONSE_CREATED.value:
            start_data = {}
            for key in ("shell_type", "bot_name"):
                if data.get(key) is not None:
                    start_data[key] = data.get(key)
            return ExecutionEvent(
                type=EventType.START,
                task_id=task_id,
                subtask_id=subtask_id,
                data=start_data,
                message_id=message_id,
            )

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

        elif event_type == ResponsesAPIStreamEvents.STATUS_UPDATED.value:
            return ExecutionEvent(
                type=EventType.STATUS_UPDATED,
                task_id=task_id,
                subtask_id=subtask_id,
                data={
                    "phase": data.get("phase"),
                    "context_metrics": data.get("context_metrics") or {},
                    "context_compaction": data.get("context_compaction"),
                },
                message_id=message_id,
            )

        elif event_type == ResponsesAPIStreamEvents.RESPONSE_COMPLETED.value:
            # response.completed -> DONE
            response_data = data.get("response", {})
            result = extract_completed_result(response_data)
            request_key = self._request_key(task_id, subtask_id)
            buffered_reasoning = self._reasoning_buffers.get(request_key)
            if not result.get("reasoning_content") and buffered_reasoning:
                result["reasoning_content"] = buffered_reasoning
            self._clear_task_contexts(task_id, subtask_id)
            return ExecutionEvent(
                type=EventType.DONE,
                task_id=task_id,
                subtask_id=subtask_id,
                content="",
                result=result,
                message_id=message_id,
            )

        elif event_type == ResponsesAPIStreamEvents.BLOCK_CREATED.value:
            block = data.get("block")
            if not isinstance(block, dict):
                return None
            return ExecutionEvent(
                type=EventType.BLOCK_CREATED,
                task_id=task_id,
                subtask_id=subtask_id,
                data={"block": block},
                message_id=message_id,
            )

        elif event_type == ResponsesAPIStreamEvents.BLOCK_UPDATED.value:
            block_id = data.get("block_id")
            updates = data.get("updates")
            if not block_id or not isinstance(updates, dict):
                return None
            return ExecutionEvent(
                type=EventType.BLOCK_UPDATED,
                task_id=task_id,
                subtask_id=subtask_id,
                data={"block_id": str(block_id), "updates": updates},
                message_id=message_id,
            )

        elif event_type == ResponsesAPIStreamEvents.ERROR.value:
            # error -> ERROR
            self._clear_task_contexts(task_id, subtask_id)
            return ExecutionEvent(
                type=EventType.ERROR,
                task_id=task_id,
                subtask_id=subtask_id,
                error=data.get("message", "Unknown error"),
                error_code=data.get("code"),
                message_id=message_id,
            )

        elif event_type == ResponsesAPIStreamEvents.RESPONSE_INCOMPLETE.value:
            # response.incomplete -> CANCELLED
            self._clear_task_contexts(task_id, subtask_id)
            return ExecutionEvent(
                type=EventType.CANCELLED,
                task_id=task_id,
                subtask_id=subtask_id,
                message_id=message_id,
            )

        elif event_type == ResponsesAPIStreamEvents.FUNCTION_CALL_ARGUMENTS_DELTA.value:
            tool_use_id = _require_non_empty_tool_use_id(
                data.get("call_id") or data.get("item_id"),
                context="function_call_arguments.delta",
            )
            tool_key = self._tool_key(task_id, subtask_id, tool_use_id)
            tool_context = self._tool_contexts.get(tool_key)
            if tool_context is None:
                logger.warning(
                    "[ResponsesAPIEventParser] Missing function_call context for %s during arguments.delta",
                    tool_key,
                )
                tool_context = {}
            arguments_summary = data.get("arguments_summary")
            if isinstance(arguments_summary, dict):
                tool_context["arguments"] = arguments_summary
            return ExecutionEvent(
                type=EventType.TOOL_ARGUMENT_DELTA,
                task_id=task_id,
                subtask_id=subtask_id,
                tool_name=tool_context.get("name"),
                tool_use_id=tool_use_id,
                tool_input=(
                    arguments_summary if isinstance(arguments_summary, dict) else None
                ),
                data={
                    "tool_protocol": "function_call",
                    "argument_status": "streaming",
                    "delta": data.get("delta", ""),
                },
                message_id=message_id,
            )

        elif event_type == ResponsesAPIStreamEvents.FUNCTION_CALL_ARGUMENTS_DONE.value:
            # function_call_arguments.done marks argument generation complete.
            # The execution result is emitted by response.output_item.done.
            tool_use_id = _require_non_empty_tool_use_id(
                data.get("call_id") or data.get("item_id"),
                context="function_call_arguments.done",
            )
            tool_key = self._tool_key(task_id, subtask_id, tool_use_id)
            tool_context = self._tool_contexts.get(tool_key)
            if tool_context is None:
                logger.warning(
                    "[ResponsesAPIEventParser] Missing function_call context for %s; "
                    "continuing with self-contained completion payload",
                    tool_key,
                )
                tool_context = {}
            # Parse arguments from the event data to get tool_input
            arguments_str = data.get("arguments", "")
            tool_input = data.get("arguments_summary")
            if not isinstance(tool_input, dict) and arguments_str:
                try:
                    tool_input = json.loads(arguments_str)
                except (json.JSONDecodeError, TypeError):
                    pass
            if isinstance(tool_input, dict):
                tool_context["arguments"] = tool_input
            return ExecutionEvent(
                type=EventType.TOOL_ARGUMENT_DONE,
                task_id=task_id,
                subtask_id=subtask_id,
                tool_name=tool_context.get("name"),
                tool_use_id=tool_use_id,
                tool_input=(
                    tool_input
                    if tool_input is not None
                    else tool_context.get("arguments")
                ),
                data={
                    "blocks": data.get("blocks", []),
                    "tool_protocol": "function_call",
                    "argument_status": "done",
                },
                message_id=message_id,
            )

        elif event_type in (
            ResponsesAPIStreamEvents.RESPONSE_PART_ADDED.value,
            ResponsesAPIStreamEvents.REASONING_SUMMARY_TEXT_DELTA.value,
        ):
            reasoning_content = _extract_reasoning_event_content(event_type, data)
            if reasoning_content is not None:
                request_key = self._request_key(task_id, subtask_id)
                self._reasoning_buffers[request_key] = (
                    self._reasoning_buffers.get(request_key, "") + reasoning_content
                )
                return ExecutionEvent(
                    type=EventType.THINKING,
                    task_id=task_id,
                    subtask_id=subtask_id,
                    content=reasoning_content,
                    data={"thinking_kind": "reasoning_summary"},
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
                tool_key = self._tool_key(task_id, subtask_id, call_id)
                arguments_summary = data.get("arguments_summary")
                self._tool_contexts[tool_key] = {
                    "protocol": "function_call",
                    "name": name,
                    "arguments": (
                        arguments_summary
                        if isinstance(arguments_summary, dict)
                        else arguments
                    ),
                }

                return ExecutionEvent(
                    type=EventType.TOOL_START,
                    task_id=task_id,
                    subtask_id=subtask_id,
                    tool_use_id=call_id,
                    tool_name=name,
                    tool_input=(
                        arguments_summary
                        if isinstance(arguments_summary, dict)
                        else arguments
                    ),
                    data={
                        "blocks": data.get("blocks", []),
                        "display_name": data.get("display_name"),
                        "tool_protocol": "function_call",
                        "argument_status": data.get("argument_status"),
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
                tool_key = self._tool_key(task_id, subtask_id, item_id)
                self._tool_contexts[tool_key] = {
                    "protocol": "mcp_call",
                    "name": name,
                    "server_label": server_label,
                }
                return ExecutionEvent(
                    type=EventType.TOOL_START,
                    task_id=task_id,
                    subtask_id=subtask_id,
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
                tool_key = self._tool_key(task_id, subtask_id, call_id)
                self._tool_contexts[tool_key] = tool_context
                return ExecutionEvent(
                    type=EventType.TOOL_START,
                    task_id=task_id,
                    subtask_id=subtask_id,
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
            # Other item types (message) are lifecycle events, skip
            return None

        elif event_type == ResponsesAPIStreamEvents.MCP_CALL_ARGUMENTS_DONE.value:
            item_id = _require_non_empty_tool_use_id(
                data.get("item_id"),
                context="response.mcp_call_arguments.done",
            )
            tool_key = self._tool_key(task_id, subtask_id, item_id)
            tool_context = self._tool_contexts.get(tool_key)
            if tool_context is None:
                logger.warning(
                    "[ResponsesAPIEventParser] Missing mcp_call context for %s during arguments.done",
                    tool_key,
                )
                return None
            arguments_str = data.get("arguments", "")
            tool_input = None
            if arguments_str:
                try:
                    tool_input = json.loads(arguments_str)
                except (json.JSONDecodeError, TypeError):
                    pass
            tool_context["arguments"] = tool_input
            return ExecutionEvent(
                type=EventType.TOOL,
                task_id=task_id,
                subtask_id=subtask_id,
                tool_use_id=item_id,
                tool_input=tool_input,
                data={
                    "tool_protocol": "mcp_call",
                    "phase": "arguments_done",
                },
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
            tool_key = self._tool_key(task_id, subtask_id, item_id)
            tool_context = self._tool_contexts.pop(tool_key, None)
            if tool_context is None:
                logger.warning(
                    "[ResponsesAPIEventParser] Missing mcp_call completion context for %s; "
                    "continuing with self-contained completion payload",
                    tool_key,
                )
                tool_context = {}
            failure_reason = data.get("failure_reason")
            tool_output = (
                failure_reason
                if event_type == ResponsesAPIStreamEvents.MCP_CALL_FAILED.value
                else data.get("output")
            )
            return ExecutionEvent(
                type=EventType.TOOL_RESULT,
                task_id=task_id,
                subtask_id=subtask_id,
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
            if item.get("type") == "function_call":
                call_id = _require_non_empty_tool_use_id(
                    item.get("call_id") or item.get("id"),
                    context="response.output_item.done(function_call)",
                )
                tool_key = self._tool_key(task_id, subtask_id, call_id)
                tool_context = self._tool_contexts.pop(tool_key, None)
                if tool_context is None:
                    logger.warning(
                        "[ResponsesAPIEventParser] Missing function_call completion context for %s; "
                        "continuing with self-contained completion payload",
                        tool_key,
                    )
                    tool_context = {}
                arguments_str = item.get("arguments", "")
                tool_input = tool_context.get("arguments")
                if not isinstance(tool_input, dict) and arguments_str:
                    try:
                        tool_input = json.loads(arguments_str)
                    except (json.JSONDecodeError, TypeError):
                        pass
                status = item.get("status", "completed")
                return ExecutionEvent(
                    type=EventType.TOOL_RESULT,
                    task_id=task_id,
                    subtask_id=subtask_id,
                    tool_name=tool_context.get("name") or item.get("name"),
                    tool_use_id=call_id,
                    tool_input=tool_input,
                    tool_output=item.get("output"),
                    data={
                        "tool_protocol": "function_call",
                        "status": status,
                        "error": item.get("error"),
                    },
                    message_id=message_id,
                )
            if item.get("type") != "shell_call":
                return None
            call_id = _require_non_empty_tool_use_id(
                item.get("call_id") or item.get("id"),
                context="response.output_item.done(shell_call)",
            )
            tool_key = self._tool_key(task_id, subtask_id, call_id)
            tool_context = self._tool_contexts.pop(tool_key, None)
            if tool_context is None:
                logger.warning(
                    "[ResponsesAPIEventParser] Missing shell_call completion context for %s; "
                    "continuing with self-contained completion payload",
                    tool_key,
                )
                tool_context = {}
            extracted = _extract_shell_call_input(item)
            tool_input = (
                extracted if extracted is not None else tool_context.get("arguments")
            )
            return ExecutionEvent(
                type=EventType.TOOL_RESULT,
                task_id=task_id,
                subtask_id=subtask_id,
                tool_name=tool_context.get("name") or item.get("name"),
                tool_use_id=call_id,
                tool_input=tool_input,
                data={
                    "tool_protocol": "shell_call",
                    "status": item.get("status", "completed"),
                },
                message_id=message_id,
            )

        elif event_type in (
            ResponsesAPIStreamEvents.RESPONSE_IN_PROGRESS.value,
            ResponsesAPIStreamEvents.CONTENT_PART_ADDED.value,
            ResponsesAPIStreamEvents.CONTENT_PART_DONE.value,
            ResponsesAPIStreamEvents.OUTPUT_TEXT_DONE.value,
            ResponsesAPIStreamEvents.MCP_CALL_ARGUMENTS_DELTA.value,
        ):
            # These are lifecycle events, skip them
            return None

        # Unknown event type, skip
        logger.debug(
            f"[ResponsesAPIEventParser] Unknown event type: {event_type}, skipping"
        )
        return None
