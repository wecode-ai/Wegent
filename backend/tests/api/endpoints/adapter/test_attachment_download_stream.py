# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import httpx
import pytest
from fastapi import HTTPException

from app.api.endpoints.adapter import attachments
from app.models.subtask_context import ContextType


def _legacy_chat_video() -> SimpleNamespace:
    return SimpleNamespace(
        id=42,
        user_id=7,
        context_type=ContextType.ATTACHMENT.value,
        original_filename="clip.mp4",
        file_extension=".mp4",
        mime_type="video/mp4",
        type_data={"storage_backend": "weibo", "fid": 12345},
    )


def _assert_legacy_video_download_rejected(
    exc_info: pytest.ExceptionInfo[HTTPException],
) -> None:
    assert exc_info.value.status_code == 400
    assert "stored externally" in exc_info.value.detail


@pytest.mark.asyncio
async def test_stream_remote_media_forwards_range_and_streams_chunks(monkeypatch):
    requested_headers = []
    monkeypatch.setattr(
        attachments.WebScraperUrlGuard,
        "validate_initial_url",
        lambda self, url: None,
    )

    class MockResponse:
        status_code = 206
        headers = {
            "content-type": "video/mp4",
            "content-length": "12",
            "content-range": "bytes 10-21/100",
            "accept-ranges": "bytes",
        }

        def raise_for_status(self):
            return None

        async def aiter_bytes(self, chunk_size=None):
            assert chunk_size == 1024 * 1024
            yield b"video-"
            yield b"stream"

    class MockStreamContext:
        async def __aenter__(self):
            return MockResponse()

        async def __aexit__(self, exc_type, exc, traceback):
            return False

    class MockClient:
        def __init__(self, *args, **kwargs):
            return None

        def stream(self, method, url, headers):
            assert method == "GET"
            assert url == "https://cdn.example.com/video.mp4"
            requested_headers.append(headers)
            return MockStreamContext()

        async def aclose(self):
            return None

    monkeypatch.setattr(httpx, "AsyncClient", MockClient)

    response = await attachments._stream_remote_media(
        "https://cdn.example.com/video.mp4",
        "generated.mp4",
        "video/mp4",
        range_header="bytes=10-21",
    )
    chunks = [chunk async for chunk in response.body_iterator]

    assert chunks == [b"video-", b"stream"]
    assert requested_headers == [{"Range": "bytes=10-21"}]
    assert response.status_code == 206
    assert response.headers["content-range"] == "bytes 10-21/100"
    assert response.headers["x-accel-buffering"] == "no"
    assert response.headers["content-disposition"] == (
        'attachment; filename="generated.mp4"'
    )


@pytest.mark.asyncio
async def test_download_rejects_unresolved_legacy_chat_video(monkeypatch):
    context = _legacy_chat_video()
    get_binary_data = Mock()
    monkeypatch.setattr(attachments, "_get_attachment_context", lambda *args: context)
    monkeypatch.setattr(
        attachments,
        "_stream_external_attachment",
        AsyncMock(return_value=None),
    )
    monkeypatch.setattr(
        attachments.context_service,
        "get_attachment_binary_data",
        get_binary_data,
    )
    request = SimpleNamespace(headers={}, url="http://test/attachments/42/download")

    with pytest.raises(HTTPException) as exc_info:
        await attachments.download_attachment(
            attachment_id=42,
            request=request,
            share_token=None,
            download_token=None,
            range_header=None,
            db=Mock(),
            current_user=SimpleNamespace(id=7),
        )

    _assert_legacy_video_download_rejected(exc_info)
    get_binary_data.assert_not_called()


@pytest.mark.asyncio
async def test_executor_download_rejects_unresolved_legacy_chat_video(monkeypatch):
    context = _legacy_chat_video()
    get_binary_data = Mock()
    monkeypatch.setattr(
        attachments.context_service,
        "get_context_optional",
        Mock(return_value=context),
    )
    monkeypatch.setattr(
        attachments,
        "_stream_external_attachment",
        AsyncMock(return_value=None),
    )
    monkeypatch.setattr(
        attachments.context_service,
        "get_attachment_binary_data",
        get_binary_data,
    )

    with pytest.raises(HTTPException) as exc_info:
        await attachments.executor_download_attachment(
            attachment_id=42,
            db=Mock(),
            current_user=SimpleNamespace(id=7),
        )

    _assert_legacy_video_download_rejected(exc_info)
    get_binary_data.assert_not_called()


@pytest.mark.asyncio
async def test_public_download_rejects_unresolved_legacy_chat_video(monkeypatch):
    context = _legacy_chat_video()
    get_binary_data = Mock()
    monkeypatch.setattr(
        attachments,
        "_verify_public_share_token",
        Mock(return_value={"attachment_id": 42}),
    )
    monkeypatch.setattr(
        attachments.context_service,
        "get_context_optional",
        Mock(return_value=context),
    )
    monkeypatch.setattr(
        attachments,
        "_stream_external_attachment",
        AsyncMock(return_value=None),
    )
    monkeypatch.setattr(
        attachments.context_service,
        "get_attachment_binary_data",
        get_binary_data,
    )

    with pytest.raises(HTTPException) as exc_info:
        await attachments.public_download_attachment(
            token="share-token",
            range_header=None,
            db=Mock(),
        )

    _assert_legacy_video_download_rejected(exc_info)
    get_binary_data.assert_not_called()
