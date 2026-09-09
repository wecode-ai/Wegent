# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import datetime as dt
import io
from types import SimpleNamespace
from unittest.mock import Mock
from urllib.parse import quote

import pytest
from fastapi.responses import StreamingResponse

FIXED_EXPORT_DATE = dt.datetime(2026, 9, 4, 12, 0, 0)
EXPECTED_DATE_SUFFIX = FIXED_EXPORT_DATE.strftime("%Y-%m-%d")


class _FixedNowDatetime(dt.datetime):
    """datetime stand-in that always reports the fixed export date."""

    @classmethod
    def now(cls, tz=None) -> dt.datetime:
        return FIXED_EXPORT_DATE


def _mock_task(title: str) -> SimpleNamespace:
    """Build a minimal task object whose JSON carries the given display title."""
    return SimpleNamespace(
        id=42,
        json={"metadata": {"name": title}, "spec": {}},
    )


async def _call_export_docx(monkeypatch, title: str) -> StreamingResponse:
    from app.api.endpoints.adapter import tasks

    fake_task = _mock_task(title)

    # Freeze the clock observed by export_task_docx so filename assertions
    # cannot drift when a run crosses midnight.
    monkeypatch.setattr(tasks, "datetime", _FixedNowDatetime)
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
        download_token=None,
        db=Mock(),
        current_user=SimpleNamespace(id=1),
    )


@pytest.mark.asyncio
async def test_export_docx_chinese_title_uses_rfc5987_filename(monkeypatch) -> None:
    """A non-latin-1 task title must not crash header building."""
    response = await _call_export_docx(monkeypatch, "田野的协作任务")

    assert response.status_code == 200
    disposition = response.headers["content-disposition"]
    # Header value must remain latin-1 encodable on the wire.
    disposition.encode("latin-1")
    encoded_name = quote(f"田野的协作任务_{EXPECTED_DATE_SUFFIX}.docx")
    assert disposition == f"attachment; filename*=UTF-8''{encoded_name}"


@pytest.mark.asyncio
async def test_export_docx_ascii_title_keeps_plain_filename(monkeypatch) -> None:
    """An ASCII task title keeps the simple quoted filename form."""
    response = await _call_export_docx(monkeypatch, "Chat_Export")

    assert response.status_code == 200
    disposition = response.headers["content-disposition"]
    disposition.encode("latin-1")
    assert disposition.startswith(
        f'attachment; filename="Chat_Export_{EXPECTED_DATE_SUFFIX}'
    )
    assert disposition.endswith('.docx"')
