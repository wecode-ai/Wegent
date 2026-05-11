# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Helpers for building final Responses API output items."""

from __future__ import annotations

import json
from typing import Any, Iterable, Optional

from app.models.subtask import Subtask, SubtaskRole
from app.schemas.openapi_response import (
    FunctionCallOutputItem,
    MCPCallOutputItem,
    OutputMessage,
    OutputTextContent,
    ResponseOutputItem,
    ShellCallAction,
    ShellCallOutputItem,
)
from app.services.openapi.helpers import subtask_status_to_message_status

SHELL_TOOL_NAMES = {"exec", "command_tool"}


def _dump_arguments(value: Any) -> str:
    if isinstance(value, str):
        return value
    if value is None:
        return ""
    return json.dumps(value, ensure_ascii=False)


def _parse_arguments(value: str) -> dict[str, Any]:
    if not value:
        return {}
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _extract_text_content(value: Any) -> str:
    if isinstance(value, str):
        return value
    if not isinstance(value, list):
        return ""

    parts: list[str] = []
    for block in value:
        if not isinstance(block, dict):
            continue
        block_type = block.get("type")
        if block_type in {"text", "output_text", "reasoning"}:
            text = block.get("text")
            if isinstance(text, str) and text:
                parts.append(text)
    return "\n".join(parts)


def _build_message_content(
    *,
    text: str,
    reasoning: str = "",
) -> list[OutputTextContent]:
    content: list[OutputTextContent] = []
    if reasoning:
        content.append(
            OutputTextContent(type="reasoning", text=reasoning, annotations=[])
        )
    if text:
        content.append(OutputTextContent(type="output_text", text=text, annotations=[]))
    return content


def _normalize_tool_protocol(
    tool_name: str,
    block: Optional[dict[str, Any]],
) -> str:
    if isinstance(block, dict):
        block_protocol = str(block.get("tool_protocol") or "").strip().lower()
        if block_protocol in {"mcp", "mcp_call"}:
            return "mcp_call"
        if block_protocol == "shell_call":
            return "shell_call"

    block_name = ""
    if isinstance(block, dict):
        block_name = str(block.get("tool_name") or "")

    candidate = (tool_name or block_name).strip().lower()
    if candidate in SHELL_TOOL_NAMES:
        return "shell_call"
    return "function_call"


def _message_status(
    subtask: Subtask,
    status_override: Optional[str],
) -> str:
    if status_override is not None:
        return status_override
    raw_status = subtask.status
    normalized_status = getattr(raw_status, "value", raw_status) or ""
    return subtask_status_to_message_status(str(normalized_status))


def _shell_call_status(block: Optional[dict[str, Any]]) -> str:
    block_status = str(block.get("status") or "") if isinstance(block, dict) else ""
    if block_status == "error":
        return "failed"
    if block_status == "pending":
        return "in_progress"
    return "completed"


def _index_tool_blocks(
    blocks: list[dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    indexed: dict[str, dict[str, Any]] = {}
    for block in blocks:
        if not isinstance(block, dict) or block.get("type") != "tool":
            continue
        block_id = str(block.get("tool_use_id") or block.get("id") or "")
        if block_id and block_id not in indexed:
            indexed[block_id] = block
    return indexed


def _find_tool_block_for_tool_call(
    *,
    tool_call: dict[str, Any],
    tool_blocks_by_id: dict[str, dict[str, Any]],
    blocks: list[dict[str, Any]],
) -> Optional[dict[str, Any]]:
    tool_call_id = str(tool_call.get("id") or "")
    if tool_call_id:
        matched = tool_blocks_by_id.get(tool_call_id)
        if matched is not None:
            return matched

    function = tool_call.get("function") or {}
    tool_name = str(function.get("name") or "")
    if not tool_name:
        return None

    candidates = [
        block
        for block in blocks
        if isinstance(block, dict)
        and block.get("type") == "tool"
        and str(block.get("tool_name") or "") == tool_name
        and str(block.get("tool_protocol") or "") in {"mcp", "mcp_call"}
    ]
    if len(candidates) == 1:
        return candidates[0]
    return None


def _build_tool_item_from_tool_call(
    *,
    tool_call: dict[str, Any],
    block: Optional[dict[str, Any]],
) -> ResponseOutputItem:
    call_id = str(tool_call.get("id") or "")
    function = tool_call.get("function") or {}
    tool_name = str(function.get("name") or "")
    arguments = _dump_arguments(function.get("arguments") or "")
    protocol = _normalize_tool_protocol(tool_name, block)

    if protocol == "shell_call":
        parsed_args = _parse_arguments(arguments)
        commands: list[str] = []
        if isinstance(parsed_args.get("commands"), list):
            commands = [str(item) for item in parsed_args["commands"] if item]
        elif parsed_args.get("command"):
            commands = [str(parsed_args["command"])]

        timeout_seconds = parsed_args.get("timeout_seconds")
        timeout_ms = None
        if isinstance(timeout_seconds, (int, float)):
            timeout_ms = int(timeout_seconds * 1000)

        max_output_length = parsed_args.get("max_output_length")
        action = ShellCallAction(
            commands=commands,
            timeout_ms=timeout_ms,
            max_output_length=max_output_length,
        )
        return ShellCallOutputItem(
            type="shell_call",
            id=call_id or f"shell_{tool_name}",
            call_id=call_id or f"shell_{tool_name}",
            status=_shell_call_status(block),
            action=action,
            name=tool_name or "exec",
            input=parsed_args,
        )

    if protocol == "mcp_call":
        return MCPCallOutputItem(
            type="mcp_call",
            id=call_id or f"mcp_{tool_name}",
            name=tool_name,
            server_label=str((block or {}).get("server_label") or ""),
            arguments=arguments,
            status=_shell_call_status(block),
        )

    return FunctionCallOutputItem(
        type="function_call",
        id=call_id or f"fc_{tool_name}",
        call_id=call_id or f"fc_{tool_name}",
        name=tool_name,
        arguments=arguments,
    )


def _build_tool_item_from_block(block: dict[str, Any]) -> ResponseOutputItem:
    tool_use_id = str(block.get("tool_use_id") or block.get("id") or "")
    tool_name = str(block.get("tool_name") or "")
    tool_input = block.get("tool_input") or {}
    protocol = _normalize_tool_protocol(tool_name, block)

    if protocol == "shell_call":
        commands: list[str] = []
        if isinstance(tool_input.get("commands"), list):
            commands = [str(item) for item in tool_input["commands"] if item]
        elif tool_input.get("command"):
            commands = [str(tool_input["command"])]
        timeout_seconds = tool_input.get("timeout_seconds")
        timeout_ms = None
        if isinstance(timeout_seconds, (int, float)):
            timeout_ms = int(timeout_seconds * 1000)

        return ShellCallOutputItem(
            type="shell_call",
            id=tool_use_id or f"shell_{tool_name}",
            call_id=tool_use_id or f"shell_{tool_name}",
            status=_shell_call_status(block),
            action=ShellCallAction(
                commands=commands,
                timeout_ms=timeout_ms,
                max_output_length=tool_input.get("max_output_length"),
            ),
            name=tool_name or "exec",
            input=tool_input if isinstance(tool_input, dict) else {},
        )

    if protocol == "mcp_call":
        return MCPCallOutputItem(
            type="mcp_call",
            id=tool_use_id or f"mcp_{tool_name}",
            name=tool_name,
            server_label=str(block.get("server_label") or ""),
            arguments=_dump_arguments(tool_input),
            status=_shell_call_status(block),
        )

    return FunctionCallOutputItem(
        type="function_call",
        id=tool_use_id or f"fc_{tool_name}",
        call_id=tool_use_id or f"fc_{tool_name}",
        name=tool_name,
        arguments=_dump_arguments(tool_input),
    )


def _build_items_from_messages_chain(
    *,
    subtask: Subtask,
    result: dict[str, Any],
    content_override: str = "",
    status_override: Optional[str] = None,
) -> list[ResponseOutputItem]:
    messages_chain = result.get("messages_chain")
    if not isinstance(messages_chain, list) or not messages_chain:
        return []

    blocks = result.get("blocks") if isinstance(result.get("blocks"), list) else []
    tool_blocks_by_id = _index_tool_blocks(blocks)
    output: list[ResponseOutputItem] = []
    built_message = False

    for msg in messages_chain:
        if not isinstance(msg, dict):
            continue
        if msg.get("role") != "assistant":
            continue

        for tool_call in msg.get("tool_calls") or []:
            if not isinstance(tool_call, dict):
                continue
            tool_block = _find_tool_block_for_tool_call(
                tool_call=tool_call,
                tool_blocks_by_id=tool_blocks_by_id,
                blocks=blocks,
            )
            output.append(
                _build_tool_item_from_tool_call(tool_call=tool_call, block=tool_block)
            )

        text = _extract_text_content(msg.get("content"))
        reasoning = _extract_text_content(msg.get("reasoning_content"))
        if not text and not reasoning:
            continue

        built_message = True
        output.append(
            OutputMessage(
                type="message",
                id=f"msg_{subtask.id}_{len(output)}",
                status=_message_status(subtask, status_override),
                role="assistant",
                content=_build_message_content(text=text, reasoning=reasoning),
            )
        )

    if not built_message:
        final_text = content_override or str(result.get("value") or "")
        final_reasoning = str(result.get("reasoning_content") or "")
        if final_text or final_reasoning:
            output.append(
                OutputMessage(
                    type="message",
                    id=f"msg_{subtask.id}",
                    status=_message_status(subtask, status_override),
                    role="assistant",
                    content=_build_message_content(
                        text=final_text,
                        reasoning=final_reasoning,
                    ),
                )
            )

    return output


def _build_items_from_blocks(
    *,
    subtask: Subtask,
    result: dict[str, Any],
    content_override: str = "",
    status_override: Optional[str] = None,
) -> list[ResponseOutputItem]:
    blocks = result.get("blocks")
    if not isinstance(blocks, list) or not blocks:
        return []

    output: list[ResponseOutputItem] = []
    text_parts: list[str] = []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "tool":
            output.append(_build_tool_item_from_block(block))
        elif block.get("type") == "text":
            content = block.get("content")
            if isinstance(content, str) and content:
                text_parts.append(content)

    final_text = (
        content_override or "\n".join(text_parts) or str(result.get("value") or "")
    )
    final_reasoning = str(result.get("reasoning_content") or "")
    if final_text or final_reasoning:
        output.append(
            OutputMessage(
                type="message",
                id=f"msg_{subtask.id}",
                status=_message_status(subtask, status_override),
                role="assistant",
                content=_build_message_content(
                    text=final_text,
                    reasoning=final_reasoning,
                ),
            )
        )

    return output


def build_output_items_for_subtask(
    subtask: Subtask,
    *,
    content_override: str = "",
    status_override: Optional[str] = None,
) -> list[ResponseOutputItem]:
    if subtask.role != SubtaskRole.ASSISTANT:
        return []

    result = subtask.result if isinstance(subtask.result, dict) else {}
    if isinstance(result.get("output_items"), list):
        return list(result["output_items"])

    items = _build_items_from_messages_chain(
        subtask=subtask,
        result=result,
        content_override=content_override,
        status_override=status_override,
    )
    if items:
        return items

    items = _build_items_from_blocks(
        subtask=subtask,
        result=result,
        content_override=content_override,
        status_override=status_override,
    )
    if items:
        return items

    text = content_override or str(result.get("value") or "")
    reasoning = str(result.get("reasoning_content") or "")
    if not text and not reasoning:
        return []

    return [
        OutputMessage(
            type="message",
            id=f"msg_{subtask.id}",
            status=_message_status(subtask, status_override),
            role="assistant",
            content=_build_message_content(text=text, reasoning=reasoning),
        )
    ]


def build_response_output(
    subtasks: Iterable[Subtask],
    *,
    active_assistant_subtask_id: Optional[int] = None,
    active_assistant_status: Optional[str] = None,
    active_assistant_content: str = "",
) -> list[ResponseOutputItem]:
    output: list[ResponseOutputItem] = []
    for subtask in subtasks:
        status_override = None
        content_override = ""
        if (
            active_assistant_subtask_id is not None
            and subtask.id == active_assistant_subtask_id
        ):
            status_override = active_assistant_status
            content_override = active_assistant_content

        output.extend(
            build_output_items_for_subtask(
                subtask,
                content_override=content_override,
                status_override=status_override,
            )
        )
    return output
