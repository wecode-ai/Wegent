# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the AI history-backtracking tools (list_history / read_subtask)."""

import json
from types import SimpleNamespace

import pytest

from chat_shell.compression.token_counter import TokenCounter
from chat_shell.core.config import settings
from chat_shell.services.chat_service import ChatService
from chat_shell.tools.builtin import history_backtrack
from chat_shell.tools.builtin.history_backtrack import (
    ListHistoryTool,
    ReadSubtaskTool,
)


@pytest.mark.asyncio
async def test_list_history_marks_location_and_paginates(monkeypatch):
    summaries = [
        {
            "id": 1,
            "role": "user",
            "status": "COMPLETED",
            "char_count": 5,
            "preview": "hi",
        },
        {
            "id": 2,
            "role": "assistant",
            "status": "COMPLETED",
            "char_count": 9,
            "preview": "hello",
        },
        {
            "id": 3,
            "role": "user",
            "status": "COMPLETED",
            "char_count": 3,
            "preview": "yo",
        },
    ]

    async def fake_fetch(*, task_id):
        assert task_id == 2
        return summaries

    monkeypatch.setattr(history_backtrack, "fetch_history_subtasks", fake_fetch)

    tool = ListHistoryTool(task_id=2, in_context_ids=frozenset({3}), page_size=2)
    result = json.loads(await tool._arun(page=1))

    assert result["total"] == 3
    assert result["has_more"] is True
    assert [s["id"] for s in result["subtasks"]] == [1, 2]
    assert result["subtasks"][0]["location"] == "compacted"
    # id 3 is in context but on page 2
    page2 = json.loads(await tool._arun(page=2))
    assert page2["subtasks"][0]["location"] == "in_context"
    assert page2["has_more"] is False


@pytest.mark.asyncio
async def test_read_subtask_renders_assistant_blocks(monkeypatch):
    record = {
        "id": 2,
        "role": "assistant",
        "status": "COMPLETED",
        "blocks": [
            {"type": "text", "content": "let me check"},
            {
                "type": "tool",
                "tool_name": "Bash",
                "tool_input": {"cmd": "ls"},
                "tool_output": "a.txt",
            },
        ],
    }

    async def fake_fetch(*, task_id, subtask_id):
        return record

    monkeypatch.setattr(history_backtrack, "fetch_subtask_record", fake_fetch)

    tool = ReadSubtaskTool(task_id=2, token_counter=TokenCounter())
    result = json.loads(await tool._arun(subtask_id=2))

    assert result["status"] == "success"
    assert result["has_more"] is False
    assert "let me check" in result["content"]
    assert "Bash" in result["content"] and "a.txt" in result["content"]


@pytest.mark.asyncio
async def test_read_subtask_never_splits_a_block(monkeypatch):
    tc = TokenCounter()
    block_a = "alpha " * 20
    block_b = "beta " * 20
    record = {
        "id": 5,
        "role": "assistant",
        "blocks": [
            {"type": "text", "content": block_a},
            {"type": "text", "content": block_b},
        ],
    }

    async def fake_fetch(*, task_id, subtask_id):
        return record

    monkeypatch.setattr(history_backtrack, "fetch_subtask_record", fake_fetch)

    # Budget fits one block but not two -> page must contain exactly block A whole.
    budget = tc.count_text(block_a) + 1
    tool = ReadSubtaskTool(task_id=2, token_counter=tc)
    result = json.loads(await tool._arun(subtask_id=5, max_tokens=budget))

    assert result["content"] == block_a
    assert result["next_cursor"] == 1
    assert result["has_more"] is True

    # Next page returns block B.
    page2 = json.loads(await tool._arun(subtask_id=5, cursor=1, max_tokens=budget))
    assert page2["content"] == block_b
    assert page2["has_more"] is False


@pytest.mark.asyncio
async def test_read_subtask_truncates_oversized_single_block(monkeypatch):
    tc = TokenCounter()
    big = "word " * 200
    record = {
        "id": 7,
        "role": "assistant",
        "blocks": [{"type": "text", "content": big}],
    }

    async def fake_fetch(*, task_id, subtask_id):
        return record

    monkeypatch.setattr(history_backtrack, "fetch_subtask_record", fake_fetch)

    tool = ReadSubtaskTool(task_id=2, token_counter=tc)
    result = json.loads(await tool._arun(subtask_id=7, max_tokens=10))

    assert "[block 0 truncated" in result["content"]
    assert result["has_more"] is False  # only one block, fully consumed


@pytest.mark.asyncio
async def test_read_subtask_user_prompt_and_value_fallback(monkeypatch):
    async def fake_user(*, task_id, subtask_id):
        return {
            "id": 1,
            "role": "user",
            "status": "COMPLETED",
            "prompt": "the question",
        }

    monkeypatch.setattr(history_backtrack, "fetch_subtask_record", fake_user)
    tool = ReadSubtaskTool(task_id=2, token_counter=TokenCounter())
    result = json.loads(await tool._arun(subtask_id=1))
    assert result["content"] == "the question"
    assert result["role"] == "user"

    async def fake_value(*, task_id, subtask_id):
        return {
            "id": 3,
            "role": "assistant",
            "status": "FAILED",
            "value": "partial reply",
        }

    monkeypatch.setattr(history_backtrack, "fetch_subtask_record", fake_value)
    result = json.loads(await tool._arun(subtask_id=3))
    assert result["content"] == "partial reply"


@pytest.mark.asyncio
async def test_read_subtask_default_budget_derives_from_guard_limit(monkeypatch):
    tc = TokenCounter()
    block_a = "alpha " * 20
    block_b = "beta " * 20
    record = {
        "id": 5,
        "role": "assistant",
        "blocks": [
            {"type": "text", "content": block_a},
            {"type": "text", "content": block_b},
        ],
    }

    async def fake_fetch(*, task_id, subtask_id):
        return record

    monkeypatch.setattr(history_backtrack, "fetch_subtask_record", fake_fetch)
    # Size the guard limit so the derived budget (limit - buffer) fits exactly one
    # whole block. No max_tokens passed -> the default budget must come from here.
    monkeypatch.setattr(
        settings,
        "TOOL_OUTPUT_TOKEN_LIMIT",
        history_backtrack._PAGE_TOKEN_SELF_BUFFER + tc.count_text(block_a) + 1,
    )

    tool = ReadSubtaskTool(task_id=2, token_counter=tc)
    result = json.loads(await tool._arun(subtask_id=5))

    assert result["content"] == block_a
    assert result["next_cursor"] == 1
    assert result["has_more"] is True


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
