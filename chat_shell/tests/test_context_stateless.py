# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for stateless history and tool toggles in chat context."""

from unittest.mock import MagicMock

import pytest

from chat_shell.services.context import (
    ChatContext,
    _attachments_have_document,
    _content_has_readable_attachment,
)
from shared.models.execution import ExecutionRequest
from shared.utils.attachment_block import build_attachment_header


def _block(text: str):
    return [{"type": "input_text", "text": text}]


def _doc_block() -> str:
    # Anchor on the real header builder so a format change breaks this test
    # loudly instead of silently disabling read_attachment registration.
    header = build_attachment_header(
        attachment_id=5,
        filename="report.pdf",
        mime_type="application/pdf",
        file_size=2048,
        sandbox_path=None,
    )
    return f"<attachment>[Attachment 1]\n{header}\nbody</attachment>"


def _image_block() -> str:
    header = build_attachment_header(
        attachment_id=7,
        filename="pic.png",
        mime_type="image/png",
        file_size=1024,
        sandbox_path=None,
        is_image=True,
    )
    return f"<attachment>{header}</attachment>"


# --- header-text fallback (history / current-turn safety net) ---


def test_readable_attachment_detects_document():
    doc = _doc_block()
    assert _content_has_readable_attachment(doc) is True
    assert _content_has_readable_attachment(_block(doc)) is True


def test_readable_attachment_ignores_image_only():
    assert _content_has_readable_attachment(_image_block()) is False


def test_readable_attachment_ignores_video_only():
    # build_video_attachment_header is internal-only (not on this branch); assert
    # the regex ignores the video header format directly (forward-compatible).
    video = (
        "<attachment>[Attachment 1]\n"
        "[Video Attachment: clip.mp4 | ID: 9 | Type: video/mp4 | Size: 4.8 MB]\n"
        '{"fid": 123}</attachment>'
    )
    assert _content_has_readable_attachment(video) is False


def test_readable_attachment_true_for_mixed_doc_and_video():
    header = build_attachment_header(
        attachment_id=1,
        filename="a.pdf",
        mime_type="application/pdf",
        file_size=10,
        sandbox_path=None,
    )
    mixed = (
        f"<attachment>{header}\nx\n"
        "[Video Attachment: v.mp4 | ID: 2 | Type: video/mp4]\n{}</attachment>"
    )
    assert _content_has_readable_attachment(mixed) is True


def test_readable_attachment_false_for_plain_text():
    assert _content_has_readable_attachment("just a question") is False


# --- structured request.attachments (preferred current-turn signal) ---


def test_attachments_have_document_true_for_pdf():
    assert _attachments_have_document([{"mime_type": "application/pdf"}]) is True


def test_attachments_have_document_ignores_image_and_video():
    assert _attachments_have_document([{"mime_type": "image/png"}]) is False
    assert _attachments_have_document([{"mime_type": "video/mp4"}]) is False
    assert (
        _attachments_have_document(
            [{"mime_type": "image/png"}, {"mime_type": "video/mp4"}]
        )
        is False
    )


def test_attachments_have_document_true_when_mixed():
    assert (
        _attachments_have_document(
            [{"mime_type": "video/mp4"}, {"mime_type": "application/pdf"}]
        )
        is True
    )


def test_attachments_have_document_empty_or_malformed():
    assert _attachments_have_document([]) is False
    assert _attachments_have_document(None) is False
    assert _attachments_have_document([{"mime_type": ""}]) is False
    assert _attachments_have_document(["not-a-dict"]) is False


@pytest.mark.asyncio
async def test_load_chat_history_uses_request_history_for_stateless_request():
    request = ExecutionRequest(
        stateless=True,
        history=[{"role": "user", "content": "第一条用户消息"}],
        prompt="第二条用户消息",
    )
    context = ChatContext(request)

    history = await context._load_chat_history()

    assert history == [{"role": "user", "content": "第一条用户消息"}]


def test_build_extra_tools_skips_builtin_tools_when_enable_tools_false():
    request = ExecutionRequest(
        enable_tools=False,
        is_subscription=False,
        user_id=1,
        team_id=1,
        timezone="Asia/Shanghai",
        history=[],
    )
    context = ChatContext(request)
    context._load_skill_tool = MagicMock(name="load_skill_tool")
    context._load_skill_tool.name = "load_skill"

    kb_result = MagicMock()
    kb_result.extra_tools = []

    extra_tools = context._build_extra_tools(kb_result, [], ([], []))

    assert extra_tools == []


@pytest.mark.asyncio
async def test_load_chat_history_does_not_restore_request_history_when_limit_zero(
    monkeypatch,
):
    async def _mock_get_chat_history(*args, **kwargs):
        del args, kwargs
        return []

    monkeypatch.setattr("chat_shell.history.get_chat_history", _mock_get_chat_history)

    request = ExecutionRequest(
        stateless=False,
        history_limit=0,
        history=[{"role": "user", "content": "should stay hidden"}],
        prompt="latest prompt",
    )
    context = ChatContext(request)

    history = await context._load_chat_history()

    assert history == []
