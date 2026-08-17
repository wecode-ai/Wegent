# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared tool-call/tool-result pairing sanitizer.

A single source of truth for dropping orphan ``ToolMessage``s and stripping
unresolved assistant ``tool_calls``. Used by summary compaction, graph recovery,
and the history finalizer so every path applies identical pairing rules.
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from langchain_core.messages import AIMessage, BaseMessage, ToolMessage


def _strip_unmatched_tool_use_blocks(content: Any, matched_call_ids: set[str]) -> Any:
    """Drop id-based ``tool_use`` content blocks whose id is not matched.

    For block-list assistant content (Anthropic format), stripping an entry from
    ``tool_calls`` is not enough: the parallel ``{"type": "tool_use", "id": ...}``
    block stays in ``content`` and would be sent without a matching
    ``tool_result``, which the provider rejects. Only list content is filtered;
    string content is returned unchanged.
    """
    if not isinstance(content, list):
        return content
    kept_blocks: list[Any] = []
    for block in content:
        if (
            isinstance(block, dict)
            and block.get("type") == "tool_use"
            and block.get("id") not in matched_call_ids
        ):
            continue
        kept_blocks.append(block)
    return kept_blocks


def sanitize_tool_pairs(messages: list[BaseMessage]) -> list[BaseMessage]:
    """Drop orphan tool messages and strip unresolved assistant tool calls.

    Preserves message order. An assistant ``tool_call`` is kept only if a
    matching ``ToolMessage`` (same ``tool_call_id``) exists; a ``ToolMessage`` is
    kept only if it resolves a known assistant ``tool_call``.
    """
    pending_call_ids: dict[str, None] = {}
    matched_call_ids: set[str] = set()
    tool_message_indices_to_keep: set[int] = set()

    for index, message in enumerate(messages):
        if isinstance(message, AIMessage):
            for tool_call in message.tool_calls or []:
                tool_id = tool_call.get("id")
                if isinstance(tool_id, str) and tool_id:
                    pending_call_ids[tool_id] = None
            continue

        if isinstance(message, ToolMessage):
            tool_call_id = getattr(message, "tool_call_id", "")
            if tool_call_id in pending_call_ids:
                matched_call_ids.add(tool_call_id)
                tool_message_indices_to_keep.add(index)

    sanitized: list[BaseMessage] = []
    for index, message in enumerate(messages):
        if isinstance(message, AIMessage) and message.tool_calls:
            kept_tool_calls = [
                deepcopy(tool_call)
                for tool_call in message.tool_calls
                if tool_call.get("id") in matched_call_ids
            ]
            if len(kept_tool_calls) == len(message.tool_calls):
                sanitized.append(message)
                continue

            cloned = message.model_copy(deep=True)
            cloned.tool_calls = kept_tool_calls
            # Also drop the parallel unmatched tool_use blocks from block-list
            # content, else they ship without a matching tool_result.
            cloned.content = _strip_unmatched_tool_use_blocks(
                cloned.content, matched_call_ids
            )
            if cloned.content or cloned.tool_calls:
                sanitized.append(cloned)
            continue

        if isinstance(message, ToolMessage):
            if index in tool_message_indices_to_keep:
                sanitized.append(message)
            continue

        sanitized.append(message)

    return sanitized
