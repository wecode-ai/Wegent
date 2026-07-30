# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""AI history-backtracking tools: ``list_history`` and ``read_subtask``.

Compaction is lossy: older turns get summarized out of the live window. These
tools let the model page back into the *un-compacted* original detail — each
earlier subtask's own record is never rewritten by compaction, so reading it by
id recovers full fidelity.

Thin transport over the shared backend service: listing, rendering and
pagination live there. ``list_history`` marks each summary ``in_context`` /
``compacted``; ``read_subtask`` returns one transcript page plus an opaque
``next_cursor`` to continue.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field, PrivateAttr

from chat_shell.core.config import settings
from chat_shell.history.subtask_records import (
    SubtaskRecordNotAvailable,
    fetch_history_subtasks,
    fetch_subtask_record,
)

logger = logging.getLogger(__name__)

DEFAULT_LIST_PAGE_SIZE = 50
# Per-page char budget derived from the tool-output guard limit (single source of
# truth; conservative 1 char ≈ 1 token). The buffer leaves headroom for the JSON
# envelope and escaping (quotes/backslashes) added around ``content`` below. Even
# if an escaping-heavy page still exceeds the guard, the guard truncates the
# middle (head+tail), and the paging metadata is emitted BEFORE ``content`` so
# next_cursor/has_more always survive in the head.
_PAGE_CHAR_SELF_BUFFER = 2048


def _read_max_chars() -> int:
    return max(1, settings.TOOL_OUTPUT_TOKEN_LIMIT - _PAGE_CHAR_SELF_BUFFER)


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
        page = max(1, page)
        offset = (page - 1) * self.page_size
        try:
            result = await fetch_history_subtasks(
                task_id=self.task_id, limit=self.page_size, offset=offset
            )
        except Exception as exc:  # network / HTTP errors
            logger.warning("[list_history] fetch failed: %s", exc)
            return json.dumps(
                {"status": "error", "message": "History could not be listed"}
            )

        subtasks = result.get("subtasks", [])
        for item in subtasks:
            item["location"] = (
                "in_context" if item.get("id") in self.in_context_ids else "compacted"
            )
        return json.dumps(
            {
                "status": "success",
                "page": page,
                "page_size": self.page_size,
                "total": result.get("total", len(subtasks)),
                "has_more": result.get("has_more", False),
                "subtasks": subtasks,
            },
            ensure_ascii=False,
        )


class ReadSubtaskInput(BaseModel):
    """Input schema for the read_subtask tool."""

    subtask_id: int = Field(description="Subtask id from list_history")
    cursor: str = Field(
        default="0:0",
        description="Page cursor; start at '0:0' and pass back the returned "
        "next_cursor to continue.",
    )


class ReadSubtaskTool(BaseTool):
    """Read one subtask's original detail, one transcript page at a time."""

    name: str = "read_subtask"
    description: str = (
        "Read the full original detail of one turn (subtask) by id, one page at a "
        "time. Recovers content that compaction summarized away. Start at cursor "
        "'0:0'; if has_more is true, call again with the returned next_cursor."
    )
    args_schema: type[BaseModel] = ReadSubtaskInput

    task_id: int
    max_calls: int = 30
    _call_count: int = PrivateAttr(default=0)

    class Config:
        arbitrary_types_allowed = True

    def _run(self, *args: Any, **kwargs: Any) -> str:
        raise NotImplementedError("read_subtask is async-only; use _arun")

    async def _arun(self, subtask_id: int, cursor: str = "0:0", **_: Any) -> str:
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
                task_id=self.task_id,
                subtask_id=subtask_id,
                cursor=cursor,
                max_chars=_read_max_chars(),
            )
        except SubtaskRecordNotAvailable as exc:
            return json.dumps({"status": "error", "message": str(exc)})
        except Exception as exc:  # network / HTTP errors
            logger.warning("[read_subtask] fetch failed: %s", exc)
            return json.dumps(
                {"status": "error", "message": "Subtask could not be read"}
            )

        return json.dumps(
            {
                "status": "success",
                "subtask_id": subtask_id,
                "role": record.get("role"),
                "cursor": record.get("cursor"),
                "next_cursor": record.get("next_cursor"),
                "has_more": record.get("has_more", False),
                "total_units": record.get("total_units"),
                "content": record.get("content", ""),
            },
            ensure_ascii=False,
        )
