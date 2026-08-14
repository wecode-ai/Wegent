# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from wecode.service.video_media_platform import _parse_playback_info


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
