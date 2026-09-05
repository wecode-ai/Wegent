# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import io
import time
from types import SimpleNamespace
from typing import Optional
from unittest.mock import Mock
from urllib.parse import parse_qs, urlparse

import pytest

from app.services.auth.docx_export_download_token import (
    create_docx_export_download_token,
    verify_docx_export_download_token,
)


def _fake_task() -> SimpleNamespace:
    """Build a minimal active task with an ASCII display title."""
    return SimpleNamespace(
        id=42,
        json={"metadata": {"name": "Task-42"}, "spec": {}},
    )


def _patch_task_access(
    monkeypatch: pytest.MonkeyPatch, task: Optional[SimpleNamespace] = None
) -> Mock:
    from app.api.endpoints.adapter import tasks

    is_member = Mock(return_value=True)
    monkeypatch.setattr(
        "app.services.task_member_service.task_member_service.is_member",
        is_member,
    )
    get_task = Mock(return_value=task if task is not None else _fake_task())
    monkeypatch.setattr(tasks.task_store, "get_task_by_states", get_task)
    return is_member


def _chain_query_user(user_id: int = 1) -> Mock:
    """Build a db whose query chain resolves to the token user."""

    class _FakeQuery:
        def filter(self, *args, **kwargs):
            return self

        def first(self):
            return SimpleNamespace(id=user_id, user_name="tester")

    db = Mock()
    db.query.return_value = _FakeQuery()
    return db


@pytest.mark.asyncio
async def test_create_download_url_rejects_non_member(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.api.endpoints.adapter import tasks

    _patch_task_access(monkeypatch)
    from app.services.task_member_service import task_member_service

    task_member_service.is_member = Mock(return_value=False)

    with pytest.raises(Exception) as exc_info:
        await tasks.create_task_docx_export_download_url(
            task_id=42,
            message_ids=None,
            db=Mock(),
            current_user=SimpleNamespace(id=1, user_name="tester"),
        )
    assert exc_info.value.status_code == 404


@pytest.mark.asyncio
async def test_create_download_url_returns_tokenized_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.api.endpoints.adapter import tasks

    _patch_task_access(monkeypatch)

    result = await tasks.create_task_docx_export_download_url(
        task_id=42,
        message_ids="3,5,8",
        db=Mock(),
        current_user=SimpleNamespace(id=7, user_name="tester"),
    )

    assert result["expires_in"] == 300
    url = result["download_url"]
    parsed = urlparse(url)
    assert parsed.path == "/api/tasks/42/export/docx"
    query = parse_qs(parsed.query)
    token = query["download_token"][0]
    assert query["message_ids"] == ["3,5,8"]
    token_info = verify_docx_export_download_token(
        token, task_id=42, message_ids="3,5,8"
    )
    assert token_info is not None
    assert token_info.task_id == 42
    assert token_info.user_id == 7
    assert token_info.expire_at is not None
    # Token must expire within the advertised window, allowing clock drift.
    assert 240 < token_info.expire_at - int(time.time()) <= 300


@pytest.mark.asyncio
async def test_export_docx_with_download_token_streams_file(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.api.endpoints.adapter import tasks

    _patch_task_access(monkeypatch)
    monkeypatch.setattr(
        "app.services.export.docx_generator.generate_task_docx",
        Mock(return_value=io.BytesIO(b"fake-docx")),
    )
    token = create_docx_export_download_token(
        task_id=42,
        user_id=1,
        user_name="tester",
        expires_delta_minutes=5,
    )

    response = await tasks.export_task_docx(
        task_id=42,
        message_ids=None,
        download_token=token,
        db=_chain_query_user(),
        current_user=None,
    )

    assert response.status_code == 200
    disposition = response.headers["content-disposition"]
    disposition.encode("latin-1")
    assert disposition.endswith('.docx"')


@pytest.mark.asyncio
async def test_export_docx_rejects_token_for_other_task(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.api.endpoints.adapter import tasks

    _patch_task_access(monkeypatch)
    token = create_docx_export_download_token(
        task_id=99,
        user_id=1,
        user_name="tester",
        expires_delta_minutes=5,
    )

    with pytest.raises(Exception) as exc_info:
        await tasks.export_task_docx(
            task_id=42,
            message_ids=None,
            download_token=token,
            db=Mock(),
            current_user=None,
        )
    assert exc_info.value.status_code == 401


@pytest.mark.asyncio
async def test_export_docx_rejects_token_for_other_message_filter(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.api.endpoints.adapter import tasks

    _patch_task_access(monkeypatch)
    token = create_docx_export_download_token(
        task_id=42,
        user_id=1,
        user_name="tester",
        message_ids="1,2",
        expires_delta_minutes=5,
    )

    with pytest.raises(Exception) as exc_info:
        await tasks.export_task_docx(
            task_id=42,
            message_ids="3,4",
            download_token=token,
            db=Mock(),
            current_user=None,
        )
    assert exc_info.value.status_code == 401


@pytest.mark.asyncio
async def test_export_docx_requires_auth_without_download_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.api.endpoints.adapter import tasks

    _patch_task_access(monkeypatch)

    with pytest.raises(Exception) as exc_info:
        await tasks.export_task_docx(
            task_id=42,
            message_ids=None,
            download_token=None,
            db=Mock(),
            current_user=None,
        )
    assert exc_info.value.status_code == 401
