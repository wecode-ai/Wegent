# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest

from wecode.video.services.media_platform import _parse_playback_info, upload_media


def test_parse_playback_uses_original_video_and_basic_cover() -> None:
    info = _parse_playback_info(
        {
            "video_basic_info": {
                "duration": 5,
                "covers": [{"url": "https://example.com/cover.jpg"}],
            },
            "playback": {
                "videos": [
                    {
                        "label": "mp4_hd",
                        "url": "https://example.com/hd.mp4?Expires=1",
                        "size": 20,
                    },
                    {
                        "label": "mp4_720p_ai_preview",
                        "url": "https://example.com/preview.mp4?Expires=1",
                        "size": 10,
                    },
                ]
            },
            "origin": {
                "videos": [
                    {
                        "url": "https://example.com/original.mp4?Expires=1",
                        "size": 30,
                    }
                ]
            },
        }
    )

    assert info is not None
    assert info.url == "https://example.com/original.mp4"
    assert info.cover_url == "https://example.com/cover.jpg"
    assert info.duration == 5
    assert info.size == 30


def test_parse_playback_does_not_fall_back_to_transcoded_video() -> None:
    info = _parse_playback_info(
        {
            "playback": {
                "videos": [
                    {
                        "label": "mp4_2160p_ai_preview",
                        "url": "https://example.com/transcoded.mp4",
                    }
                ]
            }
        }
    )

    assert info is None


def test_upload_client_bypasses_environment_proxy(monkeypatch) -> None:
    captured = {}

    class DispatchStopped(Exception):
        pass

    class FakeClient:
        def __init__(self, **kwargs):
            captured.update(kwargs)

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def get(self, *_args, **_kwargs):
            raise DispatchStopped

    monkeypatch.setattr(
        "wecode.video.services.media_platform.video_media_settings."
        "WEIBO_IMAGE_HOSTING_ENABLED",
        True,
    )
    monkeypatch.setattr(
        "wecode.video.services.media_platform.video_media_settings."
        "WEIBO_FILEPLATFORM_URL",
        "http://fileplatform.example.com",
    )
    monkeypatch.setattr(
        "wecode.video.services.media_platform.video_media_settings."
        "WEIBO_TAUTH2_APPKEY",
        "app-key",
    )
    monkeypatch.setattr(
        "wecode.video.services.media_platform.video_media_settings."
        "WEIBO_MEDIA_UPLOAD_DEFAULT_UID",
        "1234567890",
    )
    monkeypatch.setattr("wecode.video.services.media_platform.httpx.Client", FakeClient)
    monkeypatch.setattr(
        "wecode.video.services.media_platform.auth_headers", lambda _uid: {}
    )

    with pytest.raises(DispatchStopped):
        upload_media(
            data=b"video",
            filename="reference.mp4",
            uid="1234567890",
            media_type="video",
        )

    assert captured["trust_env"] is False
