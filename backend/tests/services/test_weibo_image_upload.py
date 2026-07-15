# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from pytest_httpx import IteratorStream

import app.services.media.weibo_image_upload as upload_module
from app.api.endpoints.adapter import attachments as attachment_endpoints
from app.services.media.weibo_image_upload import (
    WeiboImageUploadError,
    WeiboImageUploadService,
)


@pytest.mark.asyncio
async def test_upload_bytes_uses_tauth_and_returns_pid(httpx_mock, monkeypatch):
    requested_uids = []

    def fake_auth_headers(uid, headers=None):
        requested_uids.append(uid)
        return {**(headers or {}), "Authorization": f"TAuth2 uid={uid}"}

    monkeypatch.setattr(upload_module, "auth_headers", fake_auth_headers)
    httpx_mock.add_response(json={"pic_id": "image-pid-1"})

    pid = await WeiboImageUploadService().upload_bytes(
        filename="demo.png",
        content=b"image-bytes",
        mime_type="image/png",
        uid=1234567890,
    )

    assert pid == "image-pid-1"
    assert requested_uids == [1234567890]


@pytest.mark.asyncio
async def test_upload_bytes_rejects_unsupported_format():
    with pytest.raises(WeiboImageUploadError, match="JPEG, PNG, and GIF"):
        await WeiboImageUploadService().upload_bytes(
            filename="demo.webp",
            content=b"image-bytes",
            mime_type="image/webp",
            uid=1234567890,
        )


@pytest.mark.asyncio
async def test_upload_bytes_rejects_image_at_ten_megabytes():
    with pytest.raises(WeiboImageUploadError, match="less than 10 MB"):
        await WeiboImageUploadService().upload_bytes(
            filename="large.png",
            content=b"x" * (10 * 1024 * 1024),
            mime_type="image/png",
            uid=1234567890,
        )


@pytest.mark.asyncio
async def test_upload_url_stops_streaming_at_ten_megabytes(httpx_mock):
    httpx_mock.add_response(
        method="GET",
        url="https://cdn.example.com/large.png",
        stream=IteratorStream([b"x" * (6 * 1024 * 1024), b"x" * (4 * 1024 * 1024)]),
        headers={"content-type": "image/png"},
    )

    with pytest.raises(WeiboImageUploadError, match="less than 10 MB"):
        await WeiboImageUploadService().upload_url(
            "https://cdn.example.com/large.png", uid=1234567890
        )


@pytest.mark.asyncio
async def test_upload_url_downloads_then_uploads(httpx_mock, monkeypatch):
    httpx_mock.add_response(
        method="GET",
        url="https://cdn.example.com/photo.png",
        content=b"external-image",
        headers={"content-type": "image/png"},
    )
    httpx_mock.add_response(method="POST", json={"pic_id": "external-pid"})
    monkeypatch.setattr(upload_module, "auth_headers", lambda uid: {})

    pid = await WeiboImageUploadService().upload_url(
        "https://cdn.example.com/photo.png", uid=1234567890
    )

    assert pid == "external-pid"


@pytest.mark.asyncio
async def test_attachment_upload_releases_database_before_image_upload(monkeypatch):
    class FakeDb:
        committed = False

        def commit(self):
            self.committed = True

    db = FakeDb()

    async def fake_upload_bytes(**kwargs):
        assert db.committed
        assert kwargs["filename"] == "demo.png"
        assert kwargs["uid"] == 1234567890
        return "attachment-pid"

    monkeypatch.setattr(
        attachment_endpoints, "resolve_weibo_media_uid", lambda user: 1234567890
    )
    monkeypatch.setattr(
        attachment_endpoints.weibo_image_upload_service,
        "upload_bytes",
        fake_upload_bytes,
    )

    pid = await attachment_endpoints._upload_weibo_image_pid(
        filename="demo.png",
        content=b"image-bytes",
        user=object(),
        db=db,
    )

    assert pid == {
        "image_pid": "attachment-pid",
        "image_pid_source": "weibo_upload",
        "image_pid_status": "ready",
    }


@pytest.mark.asyncio
async def test_attachment_upload_keeps_failure_as_metadata(monkeypatch):
    class FakeDb:
        def commit(self):
            pass

    async def fake_upload_bytes(**kwargs):
        raise WeiboImageUploadError(
            "image_too_large", "Image size must be less than 10 MB"
        )

    monkeypatch.setattr(
        attachment_endpoints, "resolve_weibo_media_uid", lambda user: 1234567890
    )
    monkeypatch.setattr(
        attachment_endpoints.weibo_image_upload_service,
        "upload_bytes",
        fake_upload_bytes,
    )

    metadata = await attachment_endpoints._upload_weibo_image_pid(
        filename="large.png",
        content=b"image-bytes",
        user=object(),
        db=FakeDb(),
    )

    assert metadata == {
        "image_pid_status": "failed",
        "image_pid_error": "image_too_large",
    }
