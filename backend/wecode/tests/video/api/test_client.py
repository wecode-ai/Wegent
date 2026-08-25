# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest

from wecode.video.api.client import (
    parse_card_status,
    validate_image_url,
    validate_playback_url,
    validate_task_url,
)


def test_validate_task_url_accepts_configured_aigc_path(monkeypatch):
    monkeypatch.setattr(
        "wecode.video.api.client.settings.AIGC_VIDEO_AGENT_URL",
        "http://10.2.40.157:8200/2",
    )

    result = validate_task_url(
        "http://10.2.40.157:8200/2/aigc_video/v2/scripts/1/card-status?uid=2"
    )

    assert result.endswith("card-status?uid=2")


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1:8200/2/aigc_video/v2/task/1",
        "http://10.2.40.157:8200/private/task/1",
        "file:///etc/passwd",
    ],
)
def test_validate_task_url_rejects_urls_outside_configured_service(monkeypatch, url):
    monkeypatch.setattr(
        "wecode.video.api.client.settings.AIGC_VIDEO_AGENT_URL",
        "http://10.2.40.157:8200/2",
    )

    with pytest.raises(ValueError):
        validate_task_url(url)


def test_validate_playback_url_accepts_weibo_video_cdn():
    result = validate_playback_url("http://f.video.weibocdn.com/o0/example-video")

    assert result == "http://f.video.weibocdn.com/o0/example-video"


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/private.mp4",
        "https://weibocdn.com.example.com/video.mp4",
        "file:///etc/passwd",
    ],
)
def test_validate_playback_url_rejects_non_weibo_hosts(url):
    with pytest.raises(ValueError):
        validate_playback_url(url)


def test_validate_image_url_accepts_weibo_image_cdn():
    result = validate_image_url("https://wx4.sinaimg.cn/large/example.jpg")

    assert result.endswith("example.jpg")


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/private.jpg",
        "https://sinaimg.cn.example.com/image.jpg",
        "file:///etc/passwd",
    ],
)
def test_validate_image_url_rejects_non_weibo_hosts(url):
    with pytest.raises(ValueError):
        validate_image_url(url)


def test_parse_card_status_flattens_aigc_buttons():
    parsed = parse_card_status(
        {
            "status": "completed",
            "wb_data": {
                "status": "completed",
                "progress": 100,
                "progress_text": "正在创建剧本",
                "card": {
                    "title": "一分钟短片",
                    "preview_type": "script",
                    "preview_content": {"text": "# 一分钟短片"},
                    "content": [
                        {
                            "type": "button",
                            "value": [
                                {
                                    "button_id": "next",
                                    "button_name": "开始生成主体",
                                    "button_type": "chat",
                                    "prompt": "private workflow prompt",
                                    "skill": ["prompts-to-movie-stepped"],
                                }
                            ],
                        }
                    ],
                },
            },
        }
    )

    assert parsed.is_completed is True
    assert parsed.card["buttons"][0]["button_name"] == "开始生成主体"
    assert "prompt" not in parsed.card["buttons"][0]
    assert "skill" not in parsed.card["buttons"][0]
    assert parsed.card["progress_text"] == "正在创建剧本"


def test_parse_card_status_resolves_relative_video_detail_link(monkeypatch):
    monkeypatch.setattr(
        "wecode.video.api.client.settings.FRONTEND_URL",
        "https://wegent.example.com",
    )

    parsed = parse_card_status(
        {
            "wb_data": {
                "status": "completed",
                "card": {
                    "link": (
                        "/chat?mode=video&taskId=10" "&openPanel=script&scriptId=5"
                    ),
                },
            },
        }
    )

    assert parsed.card["link"] == (
        "https://wegent.example.com/chat?mode=video&taskId=10"
        "&openPanel=script&scriptId=5"
    )
