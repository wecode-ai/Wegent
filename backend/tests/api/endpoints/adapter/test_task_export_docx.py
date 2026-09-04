# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import io
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import Mock
from urllib.parse import quote

import pytest

DATE_SUFFIX = datetime.now().strftime("%Y-%m-%d")


def _mock_task(title: str) -> SimpleNamespace:
    """Build a minimal task object whose JSON carries the given display title."""
    return SimpleNamespace(
        id=42,
        json={"metadata": {"name": title}, "spec": {}},
    )


async def _call_export_docx(monkeypatch, title: str):
    from app.api.endpoints.adapter import tasks

    fake_task = _mock_task(title)

    monkeypatch.setattr(
        "app.services.task_member_service.task_member_service.is_member",
        Mock(return_value=True),
    )
    monkeypatch.setattr(
        tasks.task_store,
        "get_task_by_states",
        Mock(return_value=fake_task),
    )
    monkeypatch.setattr(
        "app.services.export.docx_generator.generate_task_docx",
        Mock(return_value=io.BytesIO(b"fake-docx")),
    )

    return await tasks.export_task_docx(
        task_id=42,
        message_ids=None,
        db=Mock(),
        current_user=SimpleNamespace(id=1),
    )


@pytest.mark.asyncio
async def test_export_docx_chinese_title_uses_rfc5987_filename(monkeypatch):
    """A non-latin-1 task title must not crash header building."""
    response = await _call_export_docx(monkeypatch, "田野的协作任务")

    assert response.status_code == 200
    disposition = response.headers["content-disposition"]
    # Header value must remain latin-1 encodable on the wire.
    disposition.encode("latin-1")
    encoded_name = quote(f"田野的协作任务_{DATE_SUFFIX}.docx")
    assert disposition == f"attachment; filename*=UTF-8''{encoded_name}"


@pytest.mark.asyncio
async def test_export_docx_ascii_title_keeps_plain_filename(monkeypatch):
    """An ASCII task title keeps the simple quoted filename form."""
    response = await _call_export_docx(monkeypatch, "Chat_Export")

    assert response.status_code == 200
    disposition = response.headers["content-disposition"]
    disposition.encode("latin-1")
    assert disposition.startswith('attachment; filename="Chat_Export_')
    assert disposition.endswith('.docx"')
