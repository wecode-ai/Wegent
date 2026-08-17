# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the (thin) AI history-backtracking tools.

Rendering + pagination live in the shared backend service; these tools only mark
location, forward pagination params, and relay the page. See the backend
``test_subtask_history`` for the windowing/rendering logic.
"""

import json
from types import SimpleNamespace

import pytest

from chat_shell.core.config import settings
from chat_shell.history.subtask_records import SubtaskRecordNotAvailable
from chat_shell.services.chat_service import ChatService
from chat_shell.tools.builtin import history_backtrack
from chat_shell.tools.builtin.history_backtrack import ListHistoryTool, ReadSubtaskTool


@pytest.mark.asyncio
async def test_list_history_marks_location_and_relays(monkeypatch):
    async def fake_fetch(*, task_id, limit, offset):
        assert task_id == 2
        return {
            "subtasks": [
                {
                    "id": 1,
                    "role": "user",
                    "status": "COMPLETED",
                    "char_count": 2,
                    "preview": "hi",
                },
                {
                    "id": 2,
                    "role": "assistant",
                    "status": "COMPLETED",
                    "char_count": 5,
                    "preview": "hey",
                },
            ],
            "total": 5,
            "has_more": True,
        }

    monkeypatch.setattr(history_backtrack, "fetch_history_subtasks", fake_fetch)

    tool = ListHistoryTool(task_id=2, in_context_ids=frozenset({2}), page_size=2)
    result = json.loads(await tool._arun(page=1))

    assert result["total"] == 5
    assert result["has_more"] is True
    assert result["subtasks"][0]["location"] == "compacted"
    assert result["subtasks"][1]["location"] == "in_context"


@pytest.mark.asyncio
async def test_list_history_forwards_pagination(monkeypatch):
    seen = {}

    async def fake_fetch(*, task_id, limit, offset):
        seen["limit"] = limit
        seen["offset"] = offset
        return {"subtasks": [], "total": 0, "has_more": False}

    monkeypatch.setattr(history_backtrack, "fetch_history_subtasks", fake_fetch)

    tool = ListHistoryTool(task_id=2, page_size=50)
    await tool._arun(page=3)

    assert seen == {"limit": 50, "offset": 100}


@pytest.mark.asyncio
async def test_read_subtask_relays_page(monkeypatch):
    async def fake_fetch(*, task_id, subtask_id, cursor, max_chars):
        assert max_chars > 0  # derived from the guard limit
        return {
            "role": "assistant",
            "content": "rendered page",
            "cursor": "0:0",
            "next_cursor": "2:0",
            "has_more": True,
            "total_units": 5,
        }

    monkeypatch.setattr(history_backtrack, "fetch_subtask_record", fake_fetch)

    tool = ReadSubtaskTool(task_id=2)
    result = json.loads(await tool._arun(subtask_id=7))

    assert result["content"] == "rendered page"
    assert result["next_cursor"] == "2:0"
    assert result["has_more"] is True


@pytest.mark.asyncio
async def test_read_subtask_forwards_cursor_and_budget(monkeypatch):
    seen = {}

    async def fake_fetch(*, task_id, subtask_id, cursor, max_chars):
        seen.update(cursor=cursor, max_chars=max_chars)
        return {
            "role": "assistant",
            "content": "",
            "cursor": cursor,
            "next_cursor": None,
            "has_more": False,
            "total_units": 0,
        }

    monkeypatch.setattr(history_backtrack, "fetch_subtask_record", fake_fetch)
    monkeypatch.setattr(settings, "TOOL_OUTPUT_TOKEN_LIMIT", 5000)

    tool = ReadSubtaskTool(task_id=2)
    await tool._arun(subtask_id=7, cursor="3:100")

    assert seen["cursor"] == "3:100"
    assert seen["max_chars"] == 5000 - history_backtrack._PAGE_CHAR_SELF_BUFFER


@pytest.mark.asyncio
async def test_read_subtask_not_available(monkeypatch):
    async def fake_fetch(*, task_id, subtask_id, cursor, max_chars):
        raise SubtaskRecordNotAvailable("Subtask not found in this session")

    monkeypatch.setattr(history_backtrack, "fetch_subtask_record", fake_fetch)

    tool = ReadSubtaskTool(task_id=2)
    result = json.loads(await tool._arun(subtask_id=9))

    assert result["status"] == "error"


def test_dynamic_context_includes_backtrack_hint():
    request = SimpleNamespace(kb_meta_prompt="")
    ctx = SimpleNamespace(kb_meta_prompt="", backtrack_hint="RECOVER-VIA-TOOLS")
    out = ChatService._build_dynamic_context(None, request, ctx)
    assert "RECOVER-VIA-TOOLS" in out


def test_dynamic_context_omits_empty_backtrack_hint():
    request = SimpleNamespace(kb_meta_prompt="")
    ctx = SimpleNamespace(kb_meta_prompt="", backtrack_hint="")
    out = ChatService._build_dynamic_context(None, request, ctx)
    assert out == ""


def test_dynamic_context_includes_selected_knowledge_before_kb_metadata():
    request = SimpleNamespace(
        selected_knowledge_prompt="<selected_knowledge_sources />",
        kb_meta_prompt="KB metadata",
    )
    ctx = SimpleNamespace(kb_meta_prompt="", backtrack_hint="")

    out = ChatService._build_dynamic_context(None, request, ctx)

    assert out == "<selected_knowledge_sources />\n\nKB metadata"
