# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import HTTPException

from app.api.endpoints import attachments_open
from app.core.security import AuthContext
from app.models.subtask_context import ContextType


def test_get_api_key_auth_context_rejects_missing_api_key():
    with pytest.raises(HTTPException) as exc_info:
        attachments_open.get_api_key_auth_context(
            api_key="",
            auth_context=AuthContext(user=SimpleNamespace(id=7)),
        )

    assert exc_info.value.status_code == 401
    assert exc_info.value.detail == "API key is required"
    assert exc_info.value.headers is None


def test_generated_video_url_extracts_valid_video_url():
    context = SimpleNamespace(
        type_data={"video_metadata": {"video_url": "https://video.example/file.mp4"}}
    )

    assert (
        attachments_open._generated_video_url(context)
        == "https://video.example/file.mp4"
    )


def test_generated_video_url_ignores_missing_metadata():
    assert attachments_open._generated_video_url(SimpleNamespace(type_data={})) is None
    assert (
        attachments_open._generated_video_url(
            SimpleNamespace(type_data={"video_metadata": "invalid"})
        )
        is None
    )


@pytest.mark.asyncio
async def test_download_attachment_open_checks_access_and_streams_stored_attachment(
    monkeypatch,
):
    db = Mock()
    user = SimpleNamespace(id=7)
    context = SimpleNamespace(
        id=42,
        user_id=7,
        context_type=ContextType.ATTACHMENT.value,
        type_data={},
    )
    response = object()

    get_context = Mock(return_value=context)
    ensure_access = Mock()
    require_download_allowed = Mock()
    stream_external = AsyncMock(return_value=None)
    stream_stored = AsyncMock(return_value=response)

    monkeypatch.setattr(
        attachments_open.context_service,
        "get_context_optional",
        get_context,
    )
    monkeypatch.setattr(attachments_open, "_ensure_attachment_access", ensure_access)
    monkeypatch.setattr(
        attachments_open,
        "_require_attachment_download_allowed",
        require_download_allowed,
    )
    monkeypatch.setattr(
        attachments_open, "_stream_external_attachment", stream_external
    )
    monkeypatch.setattr(attachments_open, "_stream_stored_attachment", stream_stored)

    result = await attachments_open.download_attachment_open(
        attachment_id=42,
        auth_context=AuthContext(user=user, api_key_name="api-key"),
        db=db,
        range_header=None,
    )

    assert result is response
    get_context.assert_called_once_with(db=db, context_id=42)
    ensure_access.assert_called_once_with(db, context, user)
    require_download_allowed.assert_called_once_with(db, context, "download")
    stream_external.assert_awaited_once_with(context, range_header=None)
    stream_stored.assert_awaited_once_with(context)


def test_get_attachment_context_for_api_key_returns_404_when_missing(monkeypatch):
    monkeypatch.setattr(
        attachments_open.context_service,
        "get_context_optional",
        Mock(return_value=None),
    )

    with pytest.raises(HTTPException) as exc_info:
        attachments_open._get_attachment_context_for_api_key(
            Mock(),
            42,
            AuthContext(user=SimpleNamespace(id=7), api_key_name="api-key"),
        )

    assert exc_info.value.status_code == 404
    assert exc_info.value.detail == "Attachment not found"


def test_get_attachment_context_for_api_key_returns_403_when_access_denied(
    monkeypatch,
):
    context = SimpleNamespace(
        id=42,
        context_type=ContextType.ATTACHMENT.value,
    )
    monkeypatch.setattr(
        attachments_open.context_service,
        "get_context_optional",
        Mock(return_value=context),
    )
    monkeypatch.setattr(
        attachments_open,
        "_ensure_attachment_access",
        Mock(
            side_effect=HTTPException(
                status_code=404,
                detail="Attachment not found",
            )
        ),
    )

    with pytest.raises(HTTPException) as exc_info:
        attachments_open._get_attachment_context_for_api_key(
            Mock(),
            42,
            AuthContext(user=SimpleNamespace(id=7), api_key_name="api-key"),
        )

    assert exc_info.value.status_code == 403
    assert exc_info.value.detail == "Access denied"
