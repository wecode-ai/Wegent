# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import threading
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import httpx
import pytest

from app.api.endpoints.adapter import attachments
from app.models.subtask_context import ContextType


def _local_video() -> SimpleNamespace:
    return SimpleNamespace(
        id=43,
        user_id=7,
        context_type=ContextType.ATTACHMENT.value,
        original_filename="local.mp4",
        file_extension=".mp4",
        mime_type="video/mp4",
        storage_backend="mysql",
        storage_key="attachments/43",
        type_data={"storage_backend": "mysql"},
    )


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
async def test_stream_stored_attachment_reads_in_worker_and_streams_chunks(
    monkeypatch,
):
    main_thread_id = threading.get_ident()
    worker_thread_ids = []
    payload = b"a" * attachments.ATTACHMENT_STREAM_CHUNK_SIZE + b"tail"

    def load_binary_data(attachment_id):
        assert attachment_id == 43
        worker_thread_ids.append(threading.get_ident())
        return payload

    monkeypatch.setattr(
        attachments,
        "_load_stored_attachment_binary_data",
        load_binary_data,
    )

    response = await attachments._stream_stored_attachment(_local_video())
    chunks = [chunk async for chunk in response.body_iterator]

    assert worker_thread_ids
    assert worker_thread_ids[0] != main_thread_id
    assert chunks == [
        b"a" * attachments.ATTACHMENT_STREAM_CHUNK_SIZE,
        b"tail",
    ]
    assert response.headers["content-length"] == str(len(payload))
    assert response.headers["x-accel-buffering"] == "no"
    assert response.headers["content-disposition"] == (
        'attachment; filename="local.mp4"'
    )


@pytest.mark.asyncio
async def test_get_attachment_playback_returns_direct_adapter_url_and_cover(
    monkeypatch,
):
    context = SimpleNamespace(
        id=42,
        user_id=7,
        type_data={"storage_backend": "external_video"},
    )
    monkeypatch.setattr(
        attachments,
        "_get_attachment_context",
        Mock(return_value=context),
    )
    monkeypatch.setattr(
        attachments,
        "_resolve_attachment_playback",
        AsyncMock(
            return_value=attachments.ExternalAttachmentPlayback(
                url="https://cdn.example.com/reference.mp4",
                media_type="video/mp4",
                cover_url="https://cdn.example.com/reference-cover.jpg",
                delivery_mode="direct",
            )
        ),
    )

    response = await attachments.get_attachment_playback(
        attachment_id=42,
        share_token=None,
        db=Mock(),
        current_user=SimpleNamespace(id=7),
    )

    assert response.playback_url == "https://cdn.example.com/reference.mp4"
    assert response.cover_url == "https://cdn.example.com/reference-cover.jpg"


@pytest.mark.asyncio
async def test_get_attachment_playback_uses_proxy_for_adapter_proxy_mode(monkeypatch):
    context = SimpleNamespace(
        id=42,
        user_id=7,
        type_data={"storage_backend": "test_video_hosting"},
    )
    monkeypatch.setattr(
        attachments,
        "_get_attachment_context",
        Mock(return_value=context),
    )
    monkeypatch.setattr(
        attachments,
        "_resolve_attachment_playback",
        AsyncMock(
            return_value=attachments.ExternalAttachmentPlayback(
                url="https://private-media.example/reference.mp4",
                media_type="video/mp4",
                delivery_mode="proxy",
            )
        ),
    )
    monkeypatch.setattr(
        attachments,
        "_create_download_token",
        Mock(return_value="playback-token"),
    )
    monkeypatch.setattr(
        attachments.context_service,
        "build_attachment_url",
        Mock(return_value="/api/attachments/42/download"),
    )

    response = await attachments.get_attachment_playback(
        attachment_id=42,
        share_token=None,
        db=Mock(),
        current_user=SimpleNamespace(id=7),
    )

    assert response.playback_url == (
        "/api/attachments/42/download?download_token=playback-token"
    )
    assert "private-media.example" not in response.playback_url


@pytest.mark.asyncio
async def test_get_attachment_playback_returns_wegent_proxy_for_other_storage(
    monkeypatch,
):
    context = _local_video()
    monkeypatch.setattr(
        attachments,
        "_get_attachment_context",
        Mock(return_value=context),
    )
    monkeypatch.setattr(
        attachments,
        "_resolve_attachment_playback",
        AsyncMock(return_value=None),
    )
    monkeypatch.setattr(
        attachments,
        "_create_download_token",
        Mock(return_value="playback-token"),
    )
    monkeypatch.setattr(
        attachments.context_service,
        "build_attachment_url",
        Mock(return_value="/api/attachments/43/download"),
    )

    response = await attachments.get_attachment_playback(
        attachment_id=43,
        share_token=None,
        db=Mock(),
        current_user=SimpleNamespace(id=7),
    )

    assert response.playback_url == (
        "/api/attachments/43/download?download_token=playback-token"
    )
    assert response.cover_url is None


@pytest.mark.asyncio
async def test_get_attachment_playback_preserves_share_access_on_wegent_proxy(
    monkeypatch,
):
    context = _local_video()
    monkeypatch.setattr(
        attachments,
        "_validate_share_token_access",
        Mock(return_value=True),
    )
    monkeypatch.setattr(
        attachments.context_service,
        "get_context_optional",
        Mock(return_value=context),
    )
    monkeypatch.setattr(
        attachments,
        "_resolve_attachment_playback",
        AsyncMock(return_value=None),
    )
    monkeypatch.setattr(
        attachments.context_service,
        "build_attachment_url",
        Mock(return_value="/api/attachments/43/download"),
    )

    response = await attachments.get_attachment_playback(
        attachment_id=43,
        share_token="share/token",
        db=Mock(),
        current_user=None,
    )

    assert response.playback_url == (
        "/api/attachments/43/download?share_token=share%2Ftoken"
    )
