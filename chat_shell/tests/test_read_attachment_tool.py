# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json

import pytest

from chat_shell.compression.token_counter import TokenCounter
from chat_shell.history.attachment_text import (
    AttachmentNotAvailable,
    fetch_attachment_text,
)
from chat_shell.tools.builtin import ReadAttachmentTool
from chat_shell.tools.builtin.read_attachment import _CHARS_PER_TOKEN

_COUNTER = TokenCounter(model_name="gpt-4o")


def _make_tool(
    monkeypatch,
    payload=None,
    exc=None,
    page_token_limit=15000,
    source_truncated=False,
):
    async def fake_fetch(*, task_id, attachment_id, offset, limit):
        if exc is not None:
            raise exc
        full = payload
        chunk = full[offset : offset + limit]
        return {
            "attachment_id": attachment_id,
            "name": "a.pdf",
            "mime_type": "application/pdf",
            "total_chars": len(full),
            "offset": offset,
            "text": chunk,
            "has_more": offset + len(chunk) < len(full),
            "source_truncated": source_truncated,
        }

    monkeypatch.setattr(
        "chat_shell.tools.builtin.read_attachment.fetch_attachment_text", fake_fetch
    )
    return ReadAttachmentTool(
        task_id=1, token_counter=_COUNTER, page_token_limit=page_token_limit
    )


@pytest.mark.asyncio
async def test_reads_full_small_attachment(monkeypatch):
    tool = _make_tool(monkeypatch, payload="hello world")
    result = json.loads(await tool._arun(attachment_id=5))
    assert result["status"] == "success"
    assert result["content"] == "hello world"
    assert result["has_more"] is False
    assert result["next_offset"] is None
    assert result["total_chars"] == 11


@pytest.mark.asyncio
async def test_token_clamp_bounds_page_and_advances_char_offset(monkeypatch):
    # Large body, tiny page budget -> page clamped, next_offset honest.
    body = "word " * 5000
    tool = _make_tool(monkeypatch, payload=body, page_token_limit=50)
    result = json.loads(await tool._arun(attachment_id=5, offset=0))

    assert result["status"] == "success"
    assert result["has_more"] is True
    # Page token count within budget.
    assert _COUNTER.count_text(result["content"]) <= 50
    # Char cursor advanced by exactly the chars kept.
    assert result["next_offset"] == result["offset"] + result["chars_read"]
    assert result["chars_read"] == len(result["content"])


@pytest.mark.asyncio
async def test_pagination_reaches_end(monkeypatch):
    body = "abcdefghij" * 3  # 30 chars
    tool = _make_tool(monkeypatch, payload=body, page_token_limit=100000)
    # request a small char window to force paging
    page1 = json.loads(await tool._arun(attachment_id=5, offset=0, limit=10))
    assert page1["has_more"] is True
    assert page1["next_offset"] == 10
    page2 = json.loads(
        await tool._arun(attachment_id=5, offset=page1["next_offset"], limit=100)
    )
    assert page2["has_more"] is False


@pytest.mark.asyncio
async def test_source_truncated_warns_at_end_of_extract(monkeypatch):
    # Small extract that is itself a parse-time truncation of a larger file.
    tool = _make_tool(monkeypatch, payload="partial", source_truncated=True)
    result = json.loads(await tool._arun(attachment_id=5))
    assert result["has_more"] is False
    assert result["source_truncated"] is True
    # Reaching the end must NOT read as "whole file complete".
    assert "warning" in result
    assert "NOT the complete file" in result["warning"]


@pytest.mark.asyncio
async def test_no_warning_while_more_pages_remain(monkeypatch):
    body = "abcdefghij" * 3  # 30 chars
    tool = _make_tool(
        monkeypatch, payload=body, page_token_limit=100000, source_truncated=True
    )
    page1 = json.loads(await tool._arun(attachment_id=5, offset=0, limit=10))
    assert page1["has_more"] is True
    assert page1["source_truncated"] is True
    # Warning only at the end of the extract, not mid-paging.
    assert "warning" not in page1


@pytest.mark.asyncio
async def test_large_caller_limit_is_capped_to_page_window(monkeypatch):
    # A huge caller-supplied limit must not pull a huge slice over the wire:
    # the fetch window is capped to page_token_limit * _CHARS_PER_TOKEN.
    captured = {}

    async def fake_fetch(*, task_id, attachment_id, offset, limit):
        captured["limit"] = limit
        return {
            "attachment_id": attachment_id,
            "name": "",
            "mime_type": "",
            "total_chars": 10,
            "offset": offset,
            "text": "x" * min(limit, 10),
            "has_more": False,
            "source_truncated": False,
        }

    monkeypatch.setattr(
        "chat_shell.tools.builtin.read_attachment.fetch_attachment_text", fake_fetch
    )
    tool = ReadAttachmentTool(task_id=1, token_counter=_COUNTER, page_token_limit=100)
    await tool._arun(attachment_id=5, limit=10_000_000)
    assert captured["limit"] == 100 * _CHARS_PER_TOKEN


@pytest.mark.asyncio
async def test_not_available_returns_error(monkeypatch):
    tool = _make_tool(monkeypatch, exc=AttachmentNotAvailable("nope"))
    result = json.loads(await tool._arun(attachment_id=5))
    assert result["status"] == "error"


@pytest.mark.asyncio
async def test_fetch_rejects_invalid_pagination():
    # Validation happens before HTTP/package branching, matching the endpoint
    # contract in both modes.
    with pytest.raises(AttachmentNotAvailable):
        await fetch_attachment_text(task_id=1, attachment_id=1, offset=-1, limit=10)
    with pytest.raises(AttachmentNotAvailable):
        await fetch_attachment_text(task_id=1, attachment_id=1, offset=0, limit=0)


@pytest.mark.asyncio
async def test_call_limit_enforced(monkeypatch):
    tool = _make_tool(monkeypatch, payload="x")
    tool.max_calls = 2
    assert json.loads(await tool._arun(attachment_id=5))["status"] == "success"
    assert json.loads(await tool._arun(attachment_id=5))["status"] == "success"
    assert json.loads(await tool._arun(attachment_id=5))["status"] == "rejected"
