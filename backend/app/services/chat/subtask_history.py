# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared subtask-history retrieval for AI backtracking.

Single source of truth for "list the session's subtasks" and "read one subtask's
raw record", used by BOTH the internal HTTP endpoints and chat_shell package mode
(direct import) — so query, scoping, DELETE filtering, rendering and pagination
are never implemented twice. Pagination lives here (the API layer), not in
chat_shell.

- ``list`` pages by ``limit`` / ``offset``.
- ``read`` renders the subtask to a transcript and pages it with a **compound
  cursor** ``"<unit_idx>:<char_off>"``: whole units in the common case (clean
  boundaries), and — only when a single unit alone exceeds the page budget — a
  character split *within that one unit*, so even a giant tool output is fully
  reachable (there is no grep tool). Budget is measured in characters
  (tokenizer-free); the request-level tool-output guard is the head+tail backstop.

Reads the raw record (``result.blocks`` / ``prompt``), deliberately
un-compaction-scoped: backtracking recovers detail compaction summarized away.
"""

import json
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.stores.tasks import subtask_store

PREVIEW_CHARS = 200
# Fallback page size (characters) when the caller does not pass max_chars.
# chat_shell derives its value from the tool-output guard limit; this default just
# keeps a direct API call bounded.
DEFAULT_READ_MAX_CHARS = 14_000


# ---- rendering (shared by read paging and list previews) -------------------


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


def _rendered_units(subtask: Subtask) -> list[str]:
    """Ordered, non-empty rendered unit strings for the subtask.

    ``blocks`` is the as-streamed ground truth (never compaction-lossy);
    ``messages`` / ``text`` are fallbacks for legacy/simple turns.
    """
    if subtask.role == SubtaskRole.USER:
        return [subtask.prompt] if subtask.prompt else []
    result = subtask.result if isinstance(subtask.result, dict) else {}
    blocks = result.get("blocks")
    if isinstance(blocks, list) and blocks:
        rendered = [_render_block(b) for b in blocks if isinstance(b, dict)]
    else:
        chain = result.get("messages_chain")
        if isinstance(chain, list) and chain:
            rendered = [_render_message(m) for m in chain if isinstance(m, dict)]
        else:
            value = result.get("value")
            rendered = [value] if isinstance(value, str) and value else []
    return [r for r in rendered if r]


def _preview_text(subtask: Subtask) -> str:
    """A short preview source for the summary list.

    Prefers ``result.value`` (the final text, a clean one-line preview) and falls
    back to the first rendered unit so block-only turns still get a non-empty
    preview — consistent with ``_rendered_units``' block-first source.
    """
    if subtask.role == SubtaskRole.USER:
        return subtask.prompt or ""
    result = subtask.result if isinstance(subtask.result, dict) else {}
    value = result.get("value")
    if isinstance(value, str) and value:
        return value
    units = _rendered_units(subtask)
    return units[0] if units else ""


# ---- list ------------------------------------------------------------------


def list_subtask_summaries(
    db: Session,
    *,
    task_id: int,
    user_id: int,
    limit: Optional[int] = None,
    offset: int = 0,
) -> dict[str, Any]:
    """Paged summaries for the task's non-deleted subtasks.

    Returns ``{"subtasks": [...], "total": int, "has_more": bool}``. ``limit=None``
    means no limit; ``limit=0`` returns an empty page (``total`` still reflects
    all visible subtasks).
    """
    subtasks = subtask_store.list_new_messages_since(
        db, task_id=task_id, owner_user_id=user_id
    )
    visible = [st for st in subtasks if st.status != SubtaskStatus.DELETE]
    total = len(visible)

    offset = max(0, offset)
    if limit is None:
        window = visible[offset:]
    else:
        window = visible[offset : offset + max(0, limit)]
    summaries = [
        {
            "id": st.id,
            "role": st.role.value.lower(),
            "status": st.status.value,
            "char_count": len(text),
            "preview": text[:PREVIEW_CHARS],
        }
        for st in window
        for text in [_preview_text(st)]
    ]
    return {
        "subtasks": summaries,
        "total": total,
        "has_more": offset + len(window) < total,
    }


# ---- read: compound-cursor pagination --------------------------------------


def _parse_cursor(cursor: str, total: int) -> tuple[int, int]:
    """Parse ``"<unit_idx>:<char_off>"`` defensively into clamped ints."""
    unit_idx, char_off = 0, 0
    if isinstance(cursor, str) and ":" in cursor:
        head, _, tail = cursor.partition(":")
        if head.isdigit():
            unit_idx = int(head)
        if tail.isdigit():
            char_off = int(tail)
    return max(0, min(unit_idx, total)), max(0, char_off)


def read_subtask_record(
    db: Session,
    *,
    task_id: int,
    subtask_id: int,
    user_id: int,
    cursor: str = "0:0",
    max_chars: int = DEFAULT_READ_MAX_CHARS,
) -> Optional[dict[str, Any]]:
    """One subtask's rendered record, scoped to the session and paged.

    Returns ``None`` when the subtask is missing, belongs to another task, or has
    been deleted. Otherwise a dict with the ``content`` page and
    ``cursor`` / ``next_cursor`` / ``has_more`` / ``total_units``.
    """
    subtask = subtask_store.get_by_id(db, subtask_id=subtask_id, owner_user_id=user_id)
    # Owner filter alone is not enough: a same-user subtask in a different task
    # must not be readable through this session. Deleted subtasks are excluded to
    # match the listing.
    if (
        subtask is None
        or subtask.task_id != task_id
        or subtask.status == SubtaskStatus.DELETE
    ):
        return None

    units = _rendered_units(subtask)
    total = len(units)
    if max_chars <= 0:
        max_chars = DEFAULT_READ_MAX_CHARS
    unit_idx, char_off = _parse_cursor(cursor, total)

    parts: list[str] = []
    budget = max_chars
    i, off = unit_idx, char_off
    next_cursor: Optional[str] = None
    while i < total:
        piece = units[i][off:]
        if len(piece) > budget:
            if not parts:
                # A single unit alone overflows the page — split within it so a
                # giant tool output stays fully reachable (never lost).
                parts.append(piece[:budget])
                new_off = off + budget
                next_cursor = (
                    f"{i + 1}:0" if new_off >= len(units[i]) else f"{i}:{new_off}"
                )
            else:
                # Page already has content: stop on this whole-unit boundary.
                next_cursor = f"{i}:{off}"
            break
        parts.append(piece)
        budget -= len(piece)
        i += 1
        off = 0

    return {
        "id": subtask.id,
        "role": subtask.role.value.lower(),
        "status": subtask.status.value,
        "content": "\n\n".join(parts),
        "cursor": f"{unit_idx}:{char_off}",
        "next_cursor": next_cursor,
        "has_more": next_cursor is not None,
        "total_units": total,
    }
