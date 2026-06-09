# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Claude Code deferred MCP proxy helpers.

Claude Code's PreToolUse ``defer`` stops before the MCP tool executes. For
interactive user-input tools this module uses defer only as a control point:
the executor receives the deferred MCP call, invokes the configured MCP server,
and then ends the current run based on the real MCP tool result.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, AsyncGenerator, Callable

from claude_agent_sdk import HookMatcher
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

INTERACTIVE_FORM_TOOL_MARKER = "interactive_form_question"
WAITING_FOR_USER_INPUT_REASON = "waiting_for_user_input"
INTERACTIVE_FORM_FORMAT_ERROR = "模型给出的表单格式不对"
INTERACTIVE_FORM_FORMAT_RETRYING = "模型给出的表单格式不对, 正在重新生成表单"
INTERACTIVE_FORM_RENDER_ERROR = "交互式表单生成失败"
INTERACTIVE_FORM_ANSWER_FIELDS = (
    "type",
    "tool_use_id",
    "task_id",
    "subtask_id",
    "answers",
    "success",
    "status",
    "message",
)


@dataclass(frozen=True)
class ParsedMcpToolName:
    """Parsed Claude Code MCP tool name."""

    server_name: str
    tool_name: str


@dataclass(frozen=True)
class DeferredMcpProxyResult:
    """Result returned after proxying a deferred MCP tool call."""

    tool_use_id: str
    tool_name: str
    server_name: str
    tool_result: dict[str, Any]
    output_text: str
    is_error: bool = False
    is_deferred_user_input: bool = False


def is_interactive_form_tool(tool_name: str | None) -> bool:
    """Return whether a tool name belongs to interactive_form_question."""
    return bool(tool_name and INTERACTIVE_FORM_TOOL_MARKER in tool_name)


def build_interactive_form_answer_payload(
    answer: dict[str, Any] | None,
) -> dict[str, Any] | None:
    """Return the safe answer payload to send back to a deferred form tool."""
    if not isinstance(answer, dict):
        return None

    answer_type = answer.get("type")
    if answer_type != INTERACTIVE_FORM_TOOL_MARKER:
        return None

    tool_use_id = answer.get("tool_use_id")
    if not isinstance(tool_use_id, str) or not tool_use_id.strip():
        return None

    payload = {
        field: answer[field]
        for field in INTERACTIVE_FORM_ANSWER_FIELDS
        if field in answer and answer[field] is not None
    }
    payload["tool_use_id"] = tool_use_id.strip()
    return payload


async def create_interactive_form_answer_query(
    answer: dict[str, Any],
) -> AsyncGenerator[dict[str, Any], None]:
    """Create a Claude SDK user message that resolves a deferred form tool."""
    payload = build_interactive_form_answer_payload(answer)
    if not payload:
        return

    tool_use_id = payload["tool_use_id"]
    payload_text = json.dumps(payload, ensure_ascii=False, indent=2)
    yield {
        "type": "user",
        "message": {
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": tool_use_id,
                    "content": [{"type": "text", "text": payload_text}],
                    "is_error": False,
                }
            ],
        },
        "parent_tool_use_id": None,
    }


def build_deferred_mcp_retry_payload(
    *,
    tool_name: str,
    tool_output: str,
    retry_count: int,
    max_retries: int,
) -> dict[str, Any]:
    """Build model-only instructions for retrying a malformed deferred form."""
    return {
        "error": "interactive_form_question arguments were invalid; the form was not rendered.",
        "retry_instruction": (
            "Call interactive_form_question again with valid arguments. "
            "Do not answer the user directly."
        ),
        "attempt": retry_count + 1,
        "max_attempts": max_retries,
        "tool_name": tool_name,
        "last_tool_output": tool_output,
        "required_schema": {
            "questions": [
                {
                    "id": "stable_snake_case_id",
                    "question": "Question text shown to the user",
                    "input_type": "choice or text",
                    "options": [{"label": "Option label", "value": "option_value"}],
                    "multi_select": False,
                }
            ]
        },
        "validation_notes": [
            "Each question must include a non-empty question field.",
            "input_type must be choice or text.",
            "Do not embed question text in input_type.",
            "Use multi_select for multiple-choice questions.",
            "options must be objects with label and value fields.",
        ],
    }


async def create_deferred_mcp_retry_query(
    *,
    tool_use_id: str,
    tool_name: str,
    tool_output: str,
    retry_count: int,
    max_retries: int,
) -> AsyncGenerator[dict[str, Any], None]:
    """Create an error tool_result that asks the model to retry the form call."""
    payload = build_deferred_mcp_retry_payload(
        tool_name=tool_name,
        tool_output=tool_output,
        retry_count=retry_count,
        max_retries=max_retries,
    )
    yield {
        "type": "user",
        "message": {
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": tool_use_id,
                    "content": [
                        {
                            "type": "text",
                            "text": json.dumps(payload, ensure_ascii=False, indent=2),
                        }
                    ],
                    "is_error": True,
                }
            ],
        },
        "parent_tool_use_id": None,
    }


def parse_mcp_tool_name(tool_name: str | None) -> ParsedMcpToolName | None:
    """Parse Claude Code's ``mcp__<server>__<tool>`` tool name."""
    if not tool_name or not tool_name.startswith("mcp__"):
        return None

    parts = tool_name.split("__", 2)
    if len(parts) != 3 or not parts[1] or not parts[2]:
        return None

    return ParsedMcpToolName(server_name=parts[1], tool_name=parts[2])


def build_pre_tool_use_defer_response() -> dict[str, Any]:
    """Build the official Claude Code PreToolUse defer response."""
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "defer",
        }
    }


async def defer_interactive_form_mcp_hook(
    hook_input: dict[str, Any],
    tool_use_id: str | None,
    context: dict[str, Any],
) -> dict[str, Any]:
    """Defer interactive form MCP calls so the executor can proxy them."""
    tool_name = hook_input.get("tool_name") if isinstance(hook_input, dict) else None
    if is_interactive_form_tool(tool_name):
        return build_pre_tool_use_defer_response()
    return {}


def _is_deferred_mcp_proxy_hook(hook: Any) -> bool:
    return bool(getattr(hook, "_wegent_deferred_mcp_proxy_hook", False)) or (
        hook is defer_interactive_form_mcp_hook
    )


def create_deferred_mcp_proxy_hook() -> (
    Callable[[dict[str, Any], str | None, dict[str, Any]], Any]
):
    """Create a PreToolUse hook that defers supported MCP calls."""

    async def hook(
        hook_input: dict[str, Any],
        tool_use_id: str | None,
        context: dict[str, Any],
    ) -> dict[str, Any]:
        return await defer_interactive_form_mcp_hook(hook_input, tool_use_id, context)

    setattr(hook, "_wegent_deferred_mcp_proxy_hook", True)
    return hook


def install_deferred_mcp_proxy_hook(options: dict[str, Any]) -> dict[str, Any]:
    """Install the SDK PreToolUse hook that enables MCP proxy execution."""
    hooks = dict(options.get("hooks") or {})
    pre_tool_hooks = list(hooks.get("PreToolUse") or [])
    filtered_pre_tool_hooks = []

    for matcher in pre_tool_hooks:
        matcher_hooks = [
            hook
            for hook in getattr(matcher, "hooks", [])
            if not _is_deferred_mcp_proxy_hook(hook)
        ]
        if matcher_hooks:
            matcher.hooks = matcher_hooks
            filtered_pre_tool_hooks.append(matcher)

    filtered_pre_tool_hooks.append(
        HookMatcher(matcher=None, hooks=[create_deferred_mcp_proxy_hook()])
    )
    hooks["PreToolUse"] = filtered_pre_tool_hooks
    options["hooks"] = hooks
    return options


def _load_mcp_servers(mcp_servers: Any) -> dict[str, dict[str, Any]]:
    """Load MCP server config from dict/list/file forms used by Claude options."""
    if not mcp_servers:
        return {}

    if isinstance(mcp_servers, str):
        data = json.loads(Path(mcp_servers).read_text(encoding="utf-8"))
        return _load_mcp_servers(data)

    if isinstance(mcp_servers, dict):
        nested = mcp_servers.get("mcpServers") or mcp_servers.get("mcp_servers")
        if isinstance(nested, dict):
            return _load_mcp_servers(nested)

        return {
            name: config
            for name, config in mcp_servers.items()
            if isinstance(name, str) and isinstance(config, dict)
        }

    if isinstance(mcp_servers, list):
        result: dict[str, dict[str, Any]] = {}
        for server in mcp_servers:
            if not isinstance(server, dict):
                continue
            name = server.get("name")
            if not isinstance(name, str) or not name:
                continue
            result[name] = {k: v for k, v in server.items() if k != "name"}
        return result

    return {}


def _resolve_server_config(mcp_servers: Any, server_name: str) -> dict[str, Any] | None:
    servers = _load_mcp_servers(mcp_servers)
    if server_name in servers:
        return servers[server_name]

    normalized_target = server_name.replace("_", "-")
    for name, config in servers.items():
        if name.replace("_", "-") == normalized_target:
            return config
    return None


def _headers_from_config(config: dict[str, Any]) -> dict[str, str]:
    headers: dict[str, str] = {}
    for key in ("headers", "auth"):
        raw_headers = config.get(key)
        if isinstance(raw_headers, dict):
            headers.update(
                {
                    str(header_key): str(header_value)
                    for header_key, header_value in raw_headers.items()
                    if header_value is not None
                }
            )
    return headers


def _serialize_content_item(item: Any) -> dict[str, Any]:
    if isinstance(item, dict):
        return item

    if hasattr(item, "model_dump"):
        return item.model_dump(by_alias=True, exclude_none=True)

    item_type = getattr(item, "type", None)
    if item_type == "text":
        return {"type": "text", "text": getattr(item, "text", "")}
    if item_type == "image":
        return {
            "type": "image",
            "data": getattr(item, "data", ""),
            "mimeType": getattr(item, "mimeType", ""),
        }

    return {"type": str(item_type or "text"), "text": str(item)}


def serialize_mcp_tool_result(result: Any) -> dict[str, Any]:
    """Convert an MCP CallToolResult into JSON-serializable output."""
    if isinstance(result, dict):
        return result

    if hasattr(result, "model_dump"):
        return result.model_dump(by_alias=True, exclude_none=True)

    content = getattr(result, "content", None)
    payload: dict[str, Any] = {
        "content": (
            [_serialize_content_item(item) for item in content if item is not None]
            if isinstance(content, list)
            else []
        )
    }
    if getattr(result, "isError", False):
        payload["isError"] = True
    return payload


def _parse_json_record(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str):
        return None
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _iter_text_payloads(value: Any):
    if isinstance(value, str):
        yield value
        return

    if isinstance(value, dict):
        direct_text = value.get("text")
        if isinstance(direct_text, str):
            yield direct_text

        content = value.get("content")
        if isinstance(content, list):
            for item in content:
                yield from _iter_text_payloads(item)

        result = value.get("result")
        if result is not None:
            yield from _iter_text_payloads(result)
        return

    if isinstance(value, list):
        for item in value:
            yield from _iter_text_payloads(item)


def is_deferred_user_input_result(value: Any) -> bool:
    """Return whether an MCP result asks the run to wait for user input."""
    candidates: list[dict[str, Any]] = []
    parsed_direct = _parse_json_record(value)
    if parsed_direct:
        candidates.append(parsed_direct)

    for text in _iter_text_payloads(value):
        parsed = _parse_json_record(text)
        if parsed:
            candidates.append(parsed)

    return any(
        candidate.get("__deferred_user_input__") is True
        and candidate.get("success") is True
        and candidate.get("status") == "waiting_for_user_response"
        for candidate in candidates
    )


def _to_output_text(tool_result: dict[str, Any]) -> str:
    if isinstance(tool_result.get("content"), list):
        text_parts = [
            item.get("text")
            for item in tool_result["content"]
            if isinstance(item, dict) and isinstance(item.get("text"), str)
        ]
        if text_parts:
            return "\n".join(text_parts)
    return json.dumps(tool_result, ensure_ascii=False)


async def proxy_deferred_mcp_tool(
    *,
    deferred_tool_use: Any,
    mcp_servers: Any,
) -> DeferredMcpProxyResult:
    """Execute a deferred MCP tool call through the configured MCP server."""
    parsed = parse_mcp_tool_name(getattr(deferred_tool_use, "name", None))
    if not parsed:
        raise ValueError(
            f"Unsupported deferred tool name: {getattr(deferred_tool_use, 'name', None)}"
        )

    server_config = _resolve_server_config(mcp_servers, parsed.server_name)
    if not server_config:
        raise ValueError(f"MCP server config not found: {parsed.server_name}")

    url = server_config.get("url")
    if not isinstance(url, str) or not url:
        raise ValueError(f"MCP server url missing: {parsed.server_name}")

    tool_input = getattr(deferred_tool_use, "input", None)
    arguments = tool_input if isinstance(tool_input, dict) else {}
    timeout = float(server_config.get("timeout") or 300)
    headers = _headers_from_config(server_config)

    async with streamablehttp_client(
        url=url,
        headers=headers or None,
        timeout=timeout,
        sse_read_timeout=timeout,
    ) as (read_stream, write_stream, _get_session_id):
        async with ClientSession(read_stream, write_stream) as session:
            await session.initialize()
            raw_result = await session.call_tool(parsed.tool_name, arguments)

    tool_result = serialize_mcp_tool_result(raw_result)
    return DeferredMcpProxyResult(
        tool_use_id=getattr(deferred_tool_use, "id", ""),
        tool_name=getattr(deferred_tool_use, "name", ""),
        server_name=parsed.server_name,
        tool_result=tool_result,
        output_text=_to_output_text(tool_result),
        is_error=tool_result.get("isError") is True,
        is_deferred_user_input=is_deferred_user_input_result(tool_result),
    )
