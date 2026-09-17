# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Helpers for building final Responses API output items."""

from __future__ import annotations

import base64
import binascii
import json
import re
from datetime import timedelta
from typing import Any, Iterable, Optional

from app.core.config import settings
from app.models.subtask import Subtask, SubtaskRole
from app.schemas.openapi_response import (
    FunctionCallOutputItem,
    ImageGenerationCallOutputItem,
    MCPCallOutputItem,
    OutputMessage,
    OutputTextContent,
    ResponseOutputItem,
    ShellCallAction,
    ShellCallOutputItem,
    VideoGenerationCallOutputItem,
)
from app.services.attachment.public_link import (
    build_public_attachment_download_url,
)
from app.services.execution.agents.image.download_url import build_image_download_url
from app.services.openapi.helpers import subtask_status_to_message_status

SHELL_TOOL_NAMES = {"exec", "command_tool"}
VIDEO_DOWNLOAD_URL_EXPIRES_SECONDS = 3600

# MCP tools that fetch media answer with base64 payloads. Forwarding them to
# API clients bloats responses and breaks parsers, so they are replaced with a
# compact placeholder while keeping the call itself visible.
_MIN_BASE64_PAYLOAD_CHARS = 256
_BASE64_PREVIEW_CHARS = 8192
_PRINTABLE_RATIO = 0.9
_BASE64_ALPHABET = frozenset(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="
)
# Data URLs may carry media-type parameters before the base64 marker, for
# example ``data:image/jpeg;charset=utf-8;base64,...``.
_DATA_URL_PATTERN = re.compile(
    r"^data:(?P<mime>[^;,]*)(?:;[^;,]*)*;base64,",
    re.IGNORECASE,
)
_MIME_KEYS = ("mimeType", "mime_type", "mediaType", "media_type")
_INTERNAL_OUTPUT_KEYS = ("pending_user_input", "pending_user_input_payload")
_BINARY_MIME_PREFIXES = ("image/", "audio/", "video/")
_BINARY_MIME_TYPES = {"application/octet-stream", "application/pdf"}


def build_video_download_url(attachment_id: int) -> str:
    """Create a one-hour public download URL for a generated video."""
    return build_public_attachment_download_url(
        attachment_id,
        timedelta(seconds=VIDEO_DOWNLOAD_URL_EXPIRES_SECONDS),
        settings.WEGENT_BACKEND_PUBLIC_URL,
    )


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


def _base64_payload_size(payload: str) -> int:
    return len(payload.rstrip("=")) * 3 // 4


def _binary_placeholder(*, size_bytes: int, mime_type: str = "") -> str:
    label = mime_type or "binary"
    return f"<{label} payload omitted: {size_bytes} bytes>"


def _is_binary_mime(mime_type: str) -> bool:
    normalized = mime_type.strip().lower()
    return normalized.startswith(_BINARY_MIME_PREFIXES) or (
        normalized in _BINARY_MIME_TYPES
    )


def _decoded_is_binary(compact: str) -> bool:
    preview = compact[:_BASE64_PREVIEW_CHARS]
    preview = preview[: len(preview) - len(preview) % 4]
    if not preview:
        return False
    try:
        decoded = base64.b64decode(preview)
    except (binascii.Error, ValueError):
        return False
    if not decoded:
        return False
    # Decode as text so multi-byte content (for example Chinese) still counts
    # as printable; the trailing partial character of a truncated preview
    # becomes U+FFFD, which is negligible for the ratio below.
    text = decoded.decode("utf-8", errors="replace")
    unprintable = sum(
        1
        for char in text
        if char == "\ufffd" or (not char.isprintable() and char not in "\n\r\t")
    )
    return (len(text) - unprintable) / len(text) < _PRINTABLE_RATIO


def _is_binary_base64(payload: str) -> bool:
    if " " in payload or "\t" in payload:
        return False
    compact = "".join(payload.split())
    if len(compact) < _MIN_BASE64_PAYLOAD_CHARS or len(compact) % 4:
        return False
    if not all(char in _BASE64_ALPHABET for char in compact):
        return False
    return _decoded_is_binary(compact)


def _sanitize_tool_output_text(value: str, mime_type: str = "") -> str:
    data_url = _DATA_URL_PATTERN.match(value)
    if data_url:
        payload = "".join(value[data_url.end() :].split())
        mime = data_url.group("mime") or mime_type
        if _is_binary_mime(mime) or _decoded_is_binary(payload):
            return _binary_placeholder(
                size_bytes=_base64_payload_size(payload),
                mime_type=mime,
            )
        return value
    if _is_binary_base64(value):
        return _binary_placeholder(
            size_bytes=_base64_payload_size("".join(value.split())),
            mime_type=mime_type,
        )
    return value


def _sanitize_tool_output_value(value: Any, mime_type: str = "") -> Any:
    if isinstance(value, str):
        return _sanitize_tool_output_text(value, mime_type)
    if isinstance(value, list):
        return [_sanitize_tool_output_value(item, mime_type) for item in value]
    if isinstance(value, dict):
        hint = mime_type
        for key in _MIME_KEYS:
            candidate = value.get(key)
            if isinstance(candidate, str) and candidate:
                hint = candidate
                break
        return {
            key: _sanitize_tool_output_value(item, hint) for key, item in value.items()
        }
    return value


def normalize_tool_output(value: Any) -> Any:
    """Parse MCP tool output and drop internal state."""
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (TypeError, ValueError):
            return value

    if isinstance(value, dict):
        return {
            key: item for key, item in value.items() if key not in _INTERNAL_OUTPUT_KEYS
        }
    return value


def sanitize_mcp_tool_output(value: Any) -> Any:
    """Replace binary payloads in MCP tool output with a compact placeholder.

    Image-fetching MCP tools answer with base64 blobs. Callers that opt in get
    a placeholder instead of the raw bytes; text output is passed through.
    """
    return _sanitize_tool_output_value(normalize_tool_output(value))


def build_mcp_tool_output(value: Any, *, omit_binary: bool = False) -> Any:
    """Build the MCP tool output returned to API clients."""
    if omit_binary:
        return sanitize_mcp_tool_output(value)
    return normalize_tool_output(value)


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


def _generation_status(block: dict[str, Any], default_status: str) -> str:
    block_status = str(block.get("status") or "").strip().lower()
    if block_status in {"error", "failed"}:
        return "failed"
    if block.get("is_placeholder") or block_status in {
        "pending",
        "queued",
        "creating",
        "streaming",
        "in_progress",
    }:
        return "in_progress"
    if block_status in {"done", "completed"}:
        return "completed"
    return default_status


def build_generation_output_item_from_block(
    block: dict[str, Any],
    *,
    default_status: str = "completed",
) -> Optional[ResponseOutputItem]:
    """Convert an image or video result block into a Responses output item."""
    block_type = block.get("type")
    block_id = str(block.get("id") or "")
    if not block_id:
        return None

    status = _generation_status(block, default_status)
    if block_type == "image":
        attachment_ids = [
            attachment_id
            for attachment_id in block.get("image_attachment_ids") or []
            if isinstance(attachment_id, int)
        ]
        download_urls = (
            [
                build_image_download_url(attachment_id)
                for attachment_id in attachment_ids
            ]
            if attachment_ids
            else [
                url
                for url in block.get("image_download_urls") or []
                if isinstance(url, str)
            ]
        )
        image_urls = [
            url for url in block.get("image_urls") or [] if isinstance(url, str)
        ]
        return ImageGenerationCallOutputItem(
            id=block_id,
            status=status,
            image_urls=image_urls,
            image_download_urls=download_urls,
            image_attachment_ids=attachment_ids,
            metadata={
                key: value
                for key, value in {
                    "count": block.get("image_count") or len(image_urls),
                    "size": block.get("image_size"),
                    "download_url_expires_in_seconds": block.get(
                        "image_download_url_expires_in_seconds"
                    ),
                }.items()
                if value is not None
            },
        )
    if block_type == "video":
        attachment_id = block.get("video_attachment_id")
        valid_attachment_id = attachment_id if isinstance(attachment_id, int) else None
        video_url = (
            build_video_download_url(valid_attachment_id)
            if valid_attachment_id is not None
            else block.get("video_url") or None
        )
        return VideoGenerationCallOutputItem(
            id=block_id,
            status=status,
            video_url=video_url,
            video_attachment_id=valid_attachment_id,
            metadata={
                key: value
                for key, value in {
                    "thumbnail": block.get("video_thumbnail"),
                    "duration": block.get("video_duration"),
                    "progress": block.get("video_progress"),
                    "download_url_expires_in_seconds": (
                        VIDEO_DOWNLOAD_URL_EXPIRES_SECONDS
                        if valid_attachment_id is not None
                        else None
                    ),
                }.items()
                if value is not None
            },
        )
    return None


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
    omit_mcp_binary_output: bool = False,
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
            output=build_mcp_tool_output(
                (block or {}).get("tool_output"),
                omit_binary=omit_mcp_binary_output,
            ),
        )

    return FunctionCallOutputItem(
        type="function_call",
        id=call_id or f"fc_{tool_name}",
        call_id=call_id or f"fc_{tool_name}",
        name=tool_name,
        arguments=arguments,
    )


def _build_tool_item_from_block(
    block: dict[str, Any],
    *,
    omit_mcp_binary_output: bool = False,
) -> ResponseOutputItem:
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
        tool_output = build_mcp_tool_output(
            block.get("tool_output"),
            omit_binary=omit_mcp_binary_output,
        )
        return MCPCallOutputItem(
            type="mcp_call",
            id=tool_use_id or f"mcp_{tool_name}",
            name=tool_name,
            server_label=str(block.get("server_label") or ""),
            arguments=_dump_arguments(tool_input),
            status=_shell_call_status(block),
            output=tool_output,
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
    omit_mcp_binary_output: bool = False,
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
                _build_tool_item_from_tool_call(
                    tool_call=tool_call,
                    block=tool_block,
                    omit_mcp_binary_output=omit_mcp_binary_output,
                )
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
    omit_mcp_binary_output: bool = False,
) -> list[ResponseOutputItem]:
    blocks = result.get("blocks")
    if not isinstance(blocks, list) or not blocks:
        return []

    output: list[ResponseOutputItem] = []
    emitted_text = False
    emitted_reasoning = False
    emitted_media = False
    message_status = _message_status(subtask, status_override)
    generation_default_status = (
        message_status if message_status in {"in_progress", "completed"} else "failed"
    )

    def append_message(content: list[OutputTextContent]) -> None:
        output.append(
            OutputMessage(
                type="message",
                id=f"msg_{subtask.id}_{len(output)}",
                status=_message_status(subtask, status_override),
                role="assistant",
                content=content,
            )
        )

    for block in blocks:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "tool":
            output.append(
                _build_tool_item_from_block(
                    block,
                    omit_mcp_binary_output=omit_mcp_binary_output,
                )
            )
        elif generation_item := build_generation_output_item_from_block(
            block,
            default_status=generation_default_status,
        ):
            emitted_media = True
            output.append(generation_item)
        elif block.get("type") == "text":
            content = block.get("content")
            if isinstance(content, str) and content:
                emitted_text = True
                append_message(
                    [
                        OutputTextContent(
                            type="output_text", text=content, annotations=[]
                        )
                    ]
                )
        elif block.get("type") == "thinking":
            content = block.get("content")
            if isinstance(content, str) and content:
                emitted_reasoning = True
                append_message(
                    [OutputTextContent(type="reasoning", text=content, annotations=[])]
                )

    final_text = (
        ""
        if emitted_text or emitted_media
        else content_override or str(result.get("value") or "")
    )
    final_reasoning = str(result.get("reasoning_content") or "")
    if final_text or (final_reasoning and not emitted_reasoning):
        append_message(
            _build_message_content(
                text=final_text,
                reasoning="" if emitted_reasoning else final_reasoning,
            )
        )

    return output


def build_output_items_for_subtask(
    subtask: Subtask,
    *,
    content_override: str = "",
    status_override: Optional[str] = None,
    omit_mcp_binary_output: bool = False,
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
        omit_mcp_binary_output=omit_mcp_binary_output,
    )
    if items:
        return items

    items = _build_items_from_blocks(
        subtask=subtask,
        result=result,
        content_override=content_override,
        status_override=status_override,
        omit_mcp_binary_output=omit_mcp_binary_output,
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
    omit_mcp_binary_output: bool = False,
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
                omit_mcp_binary_output=omit_mcp_binary_output,
            )
        )
    return output


def extract_pending_user_input_state(
    subtasks: Iterable[Subtask],
) -> tuple[bool, Optional[dict[str, Any]]]:
    """Do not expose legacy pending-user-input state through Responses API."""
    return False, None
