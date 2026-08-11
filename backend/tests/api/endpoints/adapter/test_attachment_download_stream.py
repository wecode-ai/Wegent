# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import httpx
import pytest

from app.api.endpoints.adapter import attachments


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
