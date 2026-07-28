# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Response schemas for the AI history-backtracking endpoints."""

from typing import Optional

from pydantic import BaseModel


class SubtaskSummary(BaseModel):
    """One-line summary of a history subtask for AI backtracking."""

    id: int
    role: str
    status: str
    char_count: int
    preview: str


class SubtaskListResponse(BaseModel):
    """A page of subtask summaries."""

    session_id: str
    subtasks: list[SubtaskSummary]
    total: int
    has_more: bool


class SubtaskRecordResponse(BaseModel):
    """One page of a subtask's rendered, un-compaction-scoped transcript.

    Paged by a compound cursor (``"<unit_idx>:<char_off>"``): whole units in the
    common case, a within-unit character split only when a single unit alone
    overflows the page. ``next_cursor`` is ``None`` at the end.
    """

    id: int
    role: str
    status: str
    content: str
    cursor: str
    next_cursor: Optional[str] = None
    has_more: bool
    total_units: int
