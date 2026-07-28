# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""AI history-backtracking tools: ``list_history`` and ``read_subtask``.

Compaction is lossy: older turns get summarized out of the live window. These
tools let the model page back into the *un-compacted* original detail — each
earlier subtask's own record is never rewritten by compaction, so reading it by
id recovers full fidelity.

- ``list_history``: whole-session subtask summaries, each marked ``in_context``
  or ``compacted`` so the model knows what it can no longer see verbatim.
- ``read_subtask``: one subtask's raw record, **paginated by whole blocks** (never
  splitting a block mid-structure) under the per-page token budget.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field, PrivateAttr

from chat_shell.compression.token_counter import TokenCounter
from chat_shell.history.subtask_records import (
    SubtaskRecordNotAvailable,
    fetch_history_subtasks,
    fetch_subtask_record,
)

logger = logging.getLogger(__name__)

# Aligned with the tool-output budget so a page stays within what the
# request-level guard allows (no re-truncation that would break paging).
DEFAULT_PAGE_TOKEN_LIMIT = 15000
DEFAULT_LIST_PAGE_SIZE = 50


def _render_block(block: dict[str, Any]) -> str:
    """Render one stored block into a readable transcript fragment."""
    btype = block.get("type")
    if btype == "text":
        return str(block.get("content") or "")
    if btype == "tool":
        name = block.get("display_name") or block.get("tool_name") or "tool"
        tool_input = block.get("tool_input") or {}
        lines = [f"[tool: {name}] input={json.dumps(tool_input, ensure_ascii=False)}"]
        output = block.get("tool_output")
        if output:
            lines.append(f"output: {output}")
        return "\n".join(lines)
    if btype in ("guidance", "subagent"):
        return str(block.get("content") or "")
    return json.dumps(block, ensure_ascii=False)


def _render_message(message: dict[str, Any]) -> str:
    """Render one messages_chain entry (fallback for legacy turns)."""
    role = message.get("role", "assistant")
    content = message.get("content")
    text = (
        content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)
    )
    tool_calls = message.get("tool_calls")
    if tool_calls:
        text = f"{text}\n[tool_calls: {json.dumps(tool_calls, ensure_ascii=False)}]"
    return f"{role}: {text}"


def _record_to_blocks(record: dict[str, Any]) -> list[str]:
    """Normalize a subtask record into an ordered list of renderable blocks."""
    if record.get("role") == "user":
        return [str(record.get("prompt") or "")]
    blocks = record.get("blocks")
    if isinstance(blocks, list) and blocks:
        return [_render_block(b) for b in blocks if isinstance(b, dict)]
    chain = record.get("messages_chain")
    if isinstance(chain, list) and chain:
        return [_render_message(m) for m in chain if isinstance(m, dict)]
    value = record.get("value")
    return [str(value)] if value else []


class ListHistoryInput(BaseModel):
    """Input schema for the list_history tool."""

    page: int = Field(default=1, description="1-indexed page of the summary list")


class ListHistoryTool(BaseTool):
    """List the whole conversation's subtasks as summaries."""

    name: str = "list_history"
    description: str = (
        "List every turn (subtask) of this conversation as a summary: id, role, "
        "a short preview, and whether it is still 'in_context' or was 'compacted' "
        "(summarized out of your current context). Use it to find turns whose full "
        "detail you no longer see, then read them with read_subtask."
    )
    args_schema: type[BaseModel] = ListHistoryInput

    task_id: int
    in_context_ids: frozenset[int] = frozenset()
    page_size: int = DEFAULT_LIST_PAGE_SIZE

    class Config:
        arbitrary_types_allowed = True

    def _run(self, *args: Any, **kwargs: Any) -> str:
        raise NotImplementedError("list_history is async-only; use _arun")

    async def _arun(self, page: int = 1, **_: Any) -> str:
        try:
            summaries = await fetch_history_subtasks(task_id=self.task_id)
        except Exception as exc:  # network / HTTP errors
            logger.warning("[list_history] fetch failed: %s", exc)
            return json.dumps(
                {"status": "error", "message": "History could not be listed"}
            )

        for item in summaries:
            item["location"] = (
                "in_context" if item.get("id") in self.in_context_ids else "compacted"
            )

        page = max(1, page)
        start = (page - 1) * self.page_size
        window = summaries[start : start + self.page_size]
        return json.dumps(
            {
                "status": "success",
                "page": page,
                "page_size": self.page_size,
                "total": len(summaries),
                "has_more": start + self.page_size < len(summaries),
                "subtasks": window,
            },
            ensure_ascii=False,
        )


class ReadSubtaskInput(BaseModel):
    """Input schema for the read_subtask tool."""

    subtask_id: int = Field(description="Subtask id from list_history")
    cursor: int = Field(
        default=0, description="Block index to start from (0 = first block)"
    )
    max_tokens: int = Field(
        default=0, description="Per-page token budget override (0 = default)"
    )


class ReadSubtaskTool(BaseTool):
    """Read one subtask's raw detail, paginated by whole blocks."""

    name: str = "read_subtask"
    description: str = (
        "Read the full original detail of one turn (subtask) by id, with "
        "pagination. Recovers content that compaction summarized away. Returns a "
        "page of whole blocks plus next_cursor / has_more for paging."
    )
    args_schema: type[BaseModel] = ReadSubtaskInput

    task_id: int
    token_counter: TokenCounter
    page_token_limit: int = DEFAULT_PAGE_TOKEN_LIMIT
    max_calls: int = 30
    _call_count: int = PrivateAttr(default=0)

    class Config:
        arbitrary_types_allowed = True

    def _run(self, *args: Any, **kwargs: Any) -> str:
        raise NotImplementedError("read_subtask is async-only; use _arun")

    async def _arun(
        self, subtask_id: int, cursor: int = 0, max_tokens: int = 0, **_: Any
    ) -> str:
        if self._call_count >= self.max_calls:
            return json.dumps(
                {
                    "status": "rejected",
                    "message": f"read_subtask call limit ({self.max_calls}) reached",
                }
            )
        self._call_count += 1

        try:
            record = await fetch_subtask_record(
                task_id=self.task_id, subtask_id=subtask_id
            )
        except SubtaskRecordNotAvailable as exc:
            return json.dumps({"status": "error", "message": str(exc)})
        except Exception as exc:  # network / HTTP errors
            logger.warning("[read_subtask] fetch failed: %s", exc)
            return json.dumps(
                {"status": "error", "message": "Subtask could not be read"}
            )

        blocks = _record_to_blocks(record)
        budget = max_tokens if max_tokens > 0 else self.page_token_limit
        cursor = max(0, cursor)

        page_parts: list[str] = []
        used = 0
        index = cursor
        total = len(blocks)
        while index < total:
            rendered = blocks[index]
            tokens = self.token_counter.count_text(rendered)
            if not page_parts and tokens > budget:
                # A single oversized block must be split *within* the block, never
                # across neighbours — token-clamp it and mark the truncation.
                clamped = self._clamp_to_tokens(rendered, budget)
                page_parts.append(
                    f"{clamped}\n[block {index} truncated: {tokens} tokens total]"
                )
                index += 1
                break
            if page_parts and used + tokens > budget:
                break  # stop before this block; never split a whole block
            page_parts.append(rendered)
            used += tokens
            index += 1

        next_cursor = index if index < total else None
        return json.dumps(
            {
                "status": "success",
                "subtask_id": subtask_id,
                "role": record.get("role"),
                "cursor": cursor,
                "next_cursor": next_cursor,
                "has_more": next_cursor is not None,
                "total_blocks": total,
                "content": "\n\n".join(page_parts),
            },
            ensure_ascii=False,
        )

    def _clamp_to_tokens(self, text: str, token_limit: int) -> str:
        """Return the longest prefix of *text* within *token_limit* tokens."""
        encoding = self.token_counter.encoding
        ids = encoding.encode(text, disallowed_special=())
        if len(ids) <= token_limit:
            return text
        return encoding.decode(ids[:token_limit])
