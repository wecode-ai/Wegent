# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi import HTTPException

from wecode.video.api.opencut import (
    _update_timeline,
    build_storycut_bundle,
    generate_opencut_bgm,
    get_opencut_bgm,
    storycut_payload_to_tracks,
)
from wecode.video.api.opencut_support import (
    allowed_media_url,
    build_refined_timeline,
    merge_tracks_with_original,
    validate_converted_media_tracks,
)
from wecode.video.api.opencut_urls import (
    create_opencut_urls,
    verify_opencut_token,
)


def _timeline() -> dict:
    return {
        "id": 5,
        "task_id": "plan-timeline-1",
        "video_tracks": [
            {
                "clip_id": "image-1",
                "element_id": "visual-1",
                "kind": "image",
                "source_path": "https://wx1.sinaimg.cn/large/image-1.jpg",
                "size": [720, 1280],
                "source_window": {"start": 0, "end": 3000},
                "timeline_window": {"start": 0, "end": 3000},
            }
        ],
        "subtitle_tracks": [
            {
                "unit_id": "subtitle-1",
                "text": "原字幕",
                "timeline_window": {"start": 0, "end": 3000},
                "style": {"font_size": 36, "font_color": "#ffffff"},
            }
        ],
        "bgm_tracks": [
            {
                "clip_id": "music-1",
                "path": "https://video.weibocdn.com/music-1.mp3",
                "source_window": {"start": 0, "end": 3000},
                "timeline_window": {"start": 0, "end": 3000},
            }
        ],
        "sticker_tracks": [
            {
                "sticker_id": "vlog:frame",
                "timeline_window": {"start": 0, "end": 3000},
            },
            {
                "sticker_id": "vlog:flower",
                "timeline_window": {"start": 0, "end": 3000},
            },
        ],
        "transition_tracks": [
            {
                "id": "transition-1",
                "leftElementId": "visual-1",
                "rightElementId": "visual-2",
                "type": "fade",
                "durationMs": 500,
            }
        ],
    }


def test_opencut_urls_use_online_editor_and_signed_callbacks() -> None:
    urls = create_opencut_urls(
        callback_base="http://10.2.3.4:8400",
        session_id="37",
        artifact_id="plan-timeline-1",
        uid="admin",
        user_id=1,
    )

    parsed = urlsplit(urls["open_url"])
    query = parse_qs(parsed.query)
    assert f"{parsed.scheme}://{parsed.netloc}{parsed.path}" == (
        "https://timeline-cut.weibo.com/storycut/import"
    )
    assert query["url"][0].startswith(
        "http://10.2.3.4:8400/api/aigc-video/material-video/opencut/import/37"
    )
    assert query["returnUrl"][0].startswith(
        "http://10.2.3.4:8400/api/aigc-video/material-video/opencut/save/37"
    )
    assert query["bgmUrl"][0].startswith(
        "http://10.2.3.4:8400/api/aigc-video/material-video/opencut/bgm/37"
    )
    assert query["embed"] == ["wegent"]
    assert verify_opencut_token(urls["token"], "37")["artifact_id"] == (
        "plan-timeline-1"
    )

    with pytest.raises(HTTPException) as exc_info:
        verify_opencut_token(urls["token"], "38")
    assert exc_info.value.status_code == 401


@pytest.mark.asyncio
async def test_opencut_bgm_callbacks_use_signed_uid(monkeypatch) -> None:
    urls = create_opencut_urls(
        callback_base="http://10.2.3.4:8400",
        session_id="53",
        artifact_id="plan-timeline-1",
        uid="feifei16",
        user_id=2,
    )
    calls: list[dict] = []

    async def request_aigc_json(**kwargs):
        calls.append(kwargs)
        return {"task_id": "bgm-task-1", "status": "completed"}

    monkeypatch.setattr(
        "wecode.video.api.opencut._request_aigc_json",
        request_aigc_json,
    )

    submitted = await generate_opencut_bgm(
        session_id="53",
        token=urls["token"],
        payload={
            "generateBgmPayload": {
                "task_id": "bgm-task-1",
                "prompt": "轻柔钢琴",
                "duration_ms": 6000,
            }
        },
    )
    status = await get_opencut_bgm(
        session_id="53",
        token=urls["token"],
        task_id="bgm-task-1",
    )

    assert submitted["bgm"]["task_id"] == "bgm-task-1"
    assert status["status"] == "completed"
    assert calls == [
        {
            "method": "POST",
            "path": "v2/material-video/generate-bgm-segment",
            "uid": "feifei16",
            "payload": {
                "task_id": "bgm-task-1",
                "prompt": "轻柔钢琴",
                "duration_ms": 6000,
                "session_id": "53",
            },
        },
        {
            "method": "GET",
            "path": "v2/material-video/generate-bgm-segment/53",
            "uid": "feifei16",
            "params": {"task_id": "bgm-task-1"},
        },
    ]


def test_opencut_media_allows_signed_wegent_attachment_url() -> None:
    source = "http://10.218.17.35:8500/api/attachments/download/shared?token=signed"

    assert allowed_media_url(source, "http://10.218.17.35:8500") == source


@pytest.mark.parametrize(
    "source",
    [
        "http://10.218.17.35:8500/api/attachments/12/download?token=signed",
        "http://10.218.17.35:8500/api/attachments/download/shared",
        "http://10.218.17.36:8500/api/attachments/download/shared?token=signed",
    ],
)
def test_opencut_media_rejects_other_internal_urls(source: str) -> None:
    with pytest.raises(HTTPException) as exc_info:
        allowed_media_url(source, "http://10.218.17.35:8500")

    assert exc_info.value.status_code == 400


def test_storycut_bundle_contains_timeline_media_and_overlay_tracks(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "wecode.video.api.opencut.settings.WEGENT_SOCKET_URL",
        "http://10.2.3.4:8400",
    )

    bundle = build_storycut_bundle(
        timeline=_timeline(),
        session_id="37",
        uid="admin",
        token="signed-token",
    )

    assert bundle["schema"] == "storycut.videosos-import"
    assert bundle["project"]["aspectRatio"] == "9:16"
    assert bundle["project"]["duration"] == 3000
    assert [item["data"]["type"] for item in bundle["keyframes"]] == [
        "image",
        "music",
    ]
    assert all(item["url"].startswith("https://") for item in bundle["media"])
    image_media = bundle["media"][0]
    assert image_media["url"] == "https://wx1.sinaimg.cn/large/image-1.jpg"
    assert image_media["metadata"]["storycut"]["browserSafeSource"] == (
        image_media["url"]
    )
    assert image_media["metadata"]["storycut"]["proxySource"].startswith(
        "http://10.2.3.4:8400/"
    )
    sticker_tracks = [
        item for item in bundle["tracks"] if item.get("type") == "sticker"
    ]
    assert len(sticker_tracks) == 2
    assert bundle["transitions"] == _timeline()["transition_tracks"]


def test_storycut_bundle_uses_opencut_proxy_for_local_wegent_image(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "wecode.video.api.opencut.settings.WEGENT_SOCKET_URL",
        "http://10.218.17.35:8500",
    )
    timeline = _timeline()
    source = "http://10.218.17.35:8500/api/attachments/download/shared?token=signed"
    timeline["video_tracks"][0].update(
        {
            "clip_id": "wegent-attachment-15",
            "element_id": "video-0002-wegent-attachment-16",
            "storycut_element_id": "video-0001-wegent-attachment-15",
            "source_path": source,
        }
    )

    bundle = build_storycut_bundle(
        timeline=timeline,
        session_id="53",
        uid="feifei16",
        token="opencut-token",
    )

    image_media = bundle["media"][0]
    assert bundle["keyframes"][0]["id"] == "video-0001-wegent-attachment-15"
    storycut = image_media["metadata"]["storycut"]
    parsed = urlsplit(storycut["source"])
    assert parsed.path == "/api/storycut/media-proxy"
    assert parse_qs(parsed.query)["url"] == [image_media["url"]]
    assert storycut["sourceUrl"] == storycut["source"]
    assert image_media["metadata"]["originalSourceUrl"] == source


def test_track_merge_prefers_clip_id_over_shared_signed_url() -> None:
    original = {
        "video": [
            {
                "clip_id": "wegent-attachment-15",
                "element_id": "video-1",
                "source_path": "http://wegent/api/attachments/download/shared?token=one",
            },
            {
                "clip_id": "wegent-attachment-16",
                "element_id": "video-2",
                "source_path": "http://wegent/api/attachments/download/shared?token=two",
            },
        ]
    }
    converted = {
        "video": [
            {
                "clip_id": "wegent-attachment-15",
                "source_path": "http://wegent/api/attachments/download/shared?token=one",
            },
            {
                "clip_id": "wegent-attachment-16",
                "source_path": "http://wegent/api/attachments/download/shared?token=two",
            },
        ]
    }

    merged = merge_tracks_with_original(converted, original)

    assert [item["element_id"] for item in merged["video"]] == ["video-1", "video-2"]


def test_storycut_bundle_keeps_https_wegent_image_source(monkeypatch) -> None:
    monkeypatch.setattr(
        "wecode.video.api.opencut.settings.WEGENT_SOCKET_URL",
        "https://wegent.example.com",
    )
    timeline = _timeline()
    source = "https://wegent.example.com/api/attachments/download/shared?token=signed"
    timeline["video_tracks"][0].update(
        {
            "clip_id": "wegent-attachment-15",
            "source_path": source,
        }
    )

    bundle = build_storycut_bundle(
        timeline=timeline,
        session_id="53",
        uid="feifei16",
        token="opencut-token",
    )

    storycut = bundle["media"][0]["metadata"]["storycut"]
    assert storycut["source"] == source
    assert storycut["sourceUrl"] == source


def test_storycut_bundle_uses_direct_https_for_weibo_video(monkeypatch) -> None:
    monkeypatch.setattr(
        "wecode.video.api.opencut.settings.WEGENT_SOCKET_URL",
        "http://10.2.3.4:8400",
    )
    timeline = {
        "id": 6,
        "task_id": "plan-timeline-video",
        "video_tracks": [
            {
                "clip_id": "video-1",
                "kind": "video",
                "source_path": "http://f.video.weibocdn.com/video-1.mp4",
                "source_window": {"start": 0, "end": 3000},
                "timeline_window": {"start": 0, "end": 3000},
            }
        ],
    }

    bundle = build_storycut_bundle(
        timeline=timeline,
        session_id="41",
        uid="admin",
        token="signed-token",
    )

    video = bundle["media"][0]
    assert video["url"] == "https://f.video.weibocdn.com/video-1.mp4"
    assert video["metadata"]["originalSourceUrl"] == video["url"]
    assert video["metadata"]["storycut"]["browserSafeSource"] == video["url"]
    assert "proxySource" not in video["metadata"]["storycut"]


def test_storycut_save_payload_maps_edits_back_to_aigc_tracks() -> None:
    ticks_per_second = 120000
    payload = {
        "schema": "storycut.opencut-refined",
        "media": [
            {
                "id": "image-media",
                "url": "https://wx1.sinaimg.cn/large/image-1.jpg",
                "storycut": {
                    "source": "https://wx1.sinaimg.cn/large/image-1.jpg",
                    "metadata": {"clip_id": "image-1"},
                },
            },
            {
                "id": "music-media",
                "url": "https://video.weibocdn.com/music-1.mp3",
                "storycut": {
                    "source": "https://video.weibocdn.com/music-1.mp3",
                    "metadata": {"clip_id": "music-1"},
                },
            },
        ],
        "project": {
            "scenes": [
                {
                    "isMain": True,
                    "tracks": {
                        "main": {
                            "id": "storycut-main-video",
                            "name": "视频",
                            "type": "video",
                            "elements": [
                                {
                                    "id": "visual-1",
                                    "type": "image",
                                    "mediaId": "image-media",
                                    "startTime": 0,
                                    "duration": 3 * ticks_per_second,
                                    "trimStart": 0,
                                }
                            ],
                        },
                        "overlay": [
                            {
                                "id": "storycut-subtitles",
                                "name": "字幕",
                                "type": "text",
                                "elements": [
                                    {
                                        "id": "subtitle-1",
                                        "type": "text",
                                        "startTime": 0,
                                        "duration": 3 * ticks_per_second,
                                        "params": {
                                            "content": "修改后的字幕",
                                            "fontSize": 8,
                                        },
                                    }
                                ],
                            },
                            {
                                "id": "storycut-stickers",
                                "name": "前景贴纸",
                                "type": "sticker",
                                "elements": [
                                    {
                                        "id": "heart-1",
                                        "type": "sticker",
                                        "stickerId": "vlog:heart-pop",
                                        "startTime": 0,
                                        "duration": 3 * ticks_per_second,
                                        "params": {
                                            "transform.positionX": -200,
                                            "transform.positionY": 400,
                                        },
                                    }
                                ],
                            },
                            {
                                "id": "storycut-stickers-2",
                                "name": "背景相框",
                                "type": "sticker",
                                "elements": [
                                    {
                                        "id": "frame-1",
                                        "type": "sticker",
                                        "stickerId": "vlog:frame",
                                        "startTime": 0,
                                        "duration": 3 * ticks_per_second,
                                    }
                                ],
                            },
                        ],
                        "audio": [
                            {
                                "id": "storycut-bgm",
                                "name": "BGM",
                                "type": "music",
                                "elements": [
                                    {
                                        "id": "music-1",
                                        "type": "audio",
                                        "mediaId": "music-media",
                                        "startTime": 0,
                                        "duration": 3 * ticks_per_second,
                                        "trimStart": 0,
                                        "params": {"volume": -6},
                                    }
                                ],
                            }
                        ],
                    },
                }
            ]
        },
        "transitions": [],
    }

    tracks = storycut_payload_to_tracks(payload)

    assert tracks["video"][0]["source_path"].endswith("image-1.jpg")
    assert tracks["video"][0]["timeline_window"]["duration"] == 3000
    assert tracks["subtitles"][0]["text"] == "修改后的字幕"
    assert tracks["subtitles"][0]["style"]["fontSize"] == 8
    assert [item["storycut_track_index"] for item in tracks["stickers"]] == [2, 3]
    assert tracks["stickers"][0]["storycut_track_label"] == "前景贴纸"
    assert tracks["bgm"][0]["path"].endswith("music-1.mp3")
    assert tracks["bgm"][0]["volume_db"] == -6
    assert tracks["bgm"][0]["volume_scale"] == pytest.approx(0.501187)


def test_opencut_save_rejects_unresolved_visual_media() -> None:
    payload = {
        "project": {
            "scenes": [
                {
                    "isMain": True,
                    "tracks": {
                        "main": {
                            "elements": [
                                {
                                    "id": "visual-1",
                                    "type": "image",
                                    "mediaId": "missing-media",
                                }
                            ]
                        },
                        "overlay": [],
                        "audio": [],
                    },
                }
            ]
        }
    }

    with pytest.raises(HTTPException) as exc_info:
        validate_converted_media_tracks(
            payload,
            {
                "video": [],
                "subtitles": [],
                "voiceover": [],
                "bgm": [],
                "source_audio": [],
                "mg": [],
                "stickers": [],
                "text_animations": [],
                "transitions": [],
            },
        )

    assert exc_info.value.status_code == 400


def test_refined_timeline_preserves_track_order_and_canvas() -> None:
    tracks = {
        "video": _timeline()["video_tracks"],
        "subtitles": [
            {
                **_timeline()["subtitle_tracks"][0],
                "storycut_track_index": 1,
            }
        ],
        "voiceover": [],
        "bgm": _timeline()["bgm_tracks"],
        "mg": [],
        "stickers": [
            {
                "sticker_id": "vlog:heart-pop",
                "storycut_track_index": 2,
                "timeline_window": {"start": 0, "end": 3000},
            }
        ],
        "text_animations": [],
        "transitions": [],
    }

    timeline = build_refined_timeline(
        session_id="37",
        artifact_id="plan-timeline-1",
        payload={
            "project": {
                "settings": {
                    "canvasSize": {"width": 720, "height": 1280},
                    "background": {"color": "#123456"},
                }
            }
        },
        original=_timeline(),
        tracks=tracks,
    )

    assert timeline["subtitle_tracks"][0]["storycut_track_index"] == 1
    assert timeline["sticker_tracks"][0]["storycut_track_index"] == 2
    assert timeline["canvas_size"] == {"width": 720, "height": 1280}
    assert timeline["video_tracks"][0]["render_background_color"] == "#123456"
    assert timeline["duration_ms"] == 3000


@pytest.mark.asyncio
async def test_opencut_save_uses_lossless_local_timeline_endpoint(
    monkeypatch,
) -> None:
    captured: dict = {}

    class Response:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return {"success": True}

    class Client:
        def __init__(self, **kwargs) -> None:
            captured["client"] = kwargs

        async def __aenter__(self) -> "Client":
            return self

        async def __aexit__(self, *args: object) -> None:
            return None

        async def post(self, url: str, **kwargs: object) -> Response:
            captured.update({"url": url, **kwargs})
            return Response()

    monkeypatch.setattr(
        "wecode.video.api.opencut.httpx.AsyncClient",
        Client,
    )
    tracks = {
        "video": _timeline()["video_tracks"],
        "subtitles": [],
        "voiceover": [],
        "bgm": [],
        "source_audio": [],
        "mg": [],
        "stickers": [{"storycut_track_index": 2}],
        "text_animations": [],
        "transitions": [],
    }

    result = await _update_timeline(
        session_id="37",
        artifact_id="plan-timeline-1",
        uid="admin",
        payload={},
        original=_timeline(),
        tracks=tracks,
    )

    assert result == {"success": True}
    assert captured["url"].endswith("/v2/material-video/local-timelines")
    assert captured["json"]["timeline"]["sticker_tracks"] == [
        {"storycut_track_index": 2}
    ]
