# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace

import httpx
import pytest
from fastapi import HTTPException
from fastapi.responses import StreamingResponse

from wecode.video.api import router as aigc_video_router

_response_headers = aigc_video_router._response_headers
_upstream_url = aigc_video_router._upstream_url


def test_media_read_identity_uses_same_origin_cookie(monkeypatch):
    user = SimpleNamespace(user_name="feifei16", id=1, is_active=True)
    monkeypatch.setattr(
        aigc_video_router.security,
        "get_current_user_from_token",
        lambda token, db: user,
    )

    result = aigc_video_router._media_read_identity(
        request=SimpleNamespace(cookies={"auth_token": "cookie-token"}),
        current_user=None,
        share_token=None,
        db=object(),
    )

    assert result == ("feifei16", None)


def test_shared_read_identity_uses_task_share_owner(monkeypatch):
    share_info = SimpleNamespace(user_name="feifei16", task_id=35)
    monkeypatch.setattr(
        aigc_video_router.shared_task_service,
        "decode_share_token",
        lambda token, db: share_info,
    )

    result = aigc_video_router._shared_read_identity(
        current_user=SimpleNamespace(user_name="viewer", id=9),
        share_token="shared-token",
        db=object(),
    )

    assert result == ("feifei16", 35)


def test_shared_read_identity_rejects_invalid_token(monkeypatch):
    monkeypatch.setattr(
        aigc_video_router.shared_task_service,
        "decode_share_token",
        lambda token, db: None,
    )

    with pytest.raises(HTTPException) as exc_info:
        aigc_video_router._shared_read_identity(
            current_user=None,
            share_token="invalid-token",
            db=object(),
        )

    assert exc_info.value.status_code == 403


def test_upstream_url_maps_editor_api_to_aigc_namespace(monkeypatch):
    monkeypatch.setattr(
        "wecode.video.api.router.video_media_settings.AIGC_VIDEO_AGENT_URL",
        "http://10.2.40.157:8200/2",
    )

    result = _upstream_url(
        "api/v2/storyboards/12",
        [("include_video_versions", "1"), ("shot_id", "镜头 1")],
    )

    assert result == (
        "http://10.2.40.157:8200/2/aigc_video/v2/storyboards/12"
        "?include_video_versions=1&shot_id=%E9%95%9C%E5%A4%B4+1"
    )


def test_proxy_response_drops_transport_encoding_headers():
    response = httpx.Response(
        200,
        headers={
            "content-type": "application/json",
            "content-encoding": "gzip",
            "content-length": "42",
            "connection": "keep-alive",
            "x-request-id": "request-1",
        },
    )

    assert _response_headers(response) == {
        "content-type": "application/json",
        "x-request-id": "request-1",
    }


@pytest.mark.asyncio
async def test_playback_streams_the_refreshed_signed_url(monkeypatch):
    video_url = "https://f.video.weibocdn.com/o0/source.mp4"
    signed_url = "https://f.video.weibocdn.com/o0/source.mp4?KID=example"
    expected = StreamingResponse(iter([b"video"]), media_type="video/mp4")

    monkeypatch.setattr(
        aigc_video_router,
        "video_media_settings",
        SimpleNamespace(get_upload_uid=lambda: "123"),
    )
    monkeypatch.setattr(
        aigc_video_router,
        "sign_urls",
        lambda urls, uid: {video_url: signed_url},
    )

    async def stream_video(url, range_header):
        assert url == signed_url
        assert range_header == "bytes=0-99"
        return expected

    monkeypatch.setattr(aigc_video_router, "_stream_signed_video", stream_video)

    result = await aigc_video_router.aigc_video_playback(
        request=SimpleNamespace(cookies={}),
        video_url=video_url,
        range_header="bytes=0-99",
        share_token=None,
        current_user=SimpleNamespace(user_name="feifei16", id=1),
        db=object(),
    )

    assert result is expected
