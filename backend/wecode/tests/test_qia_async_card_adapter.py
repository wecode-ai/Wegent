# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.services.execution.agents.video.async_card import (
    normalize_async_card_payload,
)
from wecode.service import qia_async_card_adapter


def test_allows_only_configured_qia_workflow_origin(monkeypatch) -> None:
    monkeypatch.setattr(
        qia_async_card_adapter.settings,
        "AIGC_VIDEO_AGENT_URL",
        "https://qia.example.com",
    )

    assert qia_async_card_adapter.is_configured_qia_query_url(
        "https://qia.example.com/aigc_video/v2/scripts/1/card-status"
    )
    assert not qia_async_card_adapter.is_configured_qia_query_url(
        "https://other.example.com/aigc_video/v2/scripts/1/card-status"
    )
    assert not qia_async_card_adapter.is_configured_qia_query_url(
        "https://qia.example.com/admin"
    )
    assert not qia_async_card_adapter.is_configured_qia_query_url(
        "https://user:password@qia.example.com/aigc_video/status"
    )


def test_allows_configured_qia_base_path(monkeypatch) -> None:
    monkeypatch.setattr(
        qia_async_card_adapter.settings,
        "AIGC_VIDEO_AGENT_URL",
        "http://qia.example.com:8200/2",
    )

    assert qia_async_card_adapter.is_configured_qia_query_url(
        "http://qia.example.com:8200/2/aigc_video/v2/scripts/1/card-status"
    )
    assert not qia_async_card_adapter.is_configured_qia_query_url(
        "http://qia.example.com:8200/aigc_video/v2/scripts/1/card-status"
    )
    assert not qia_async_card_adapter.is_configured_qia_query_url(
        "http://qia.example.com:8200/3/aigc_video/v2/scripts/1/card-status"
    )


def test_rejects_qia_url_when_not_configured(monkeypatch) -> None:
    monkeypatch.setattr(
        qia_async_card_adapter.settings,
        "AIGC_VIDEO_AGENT_URL",
        "",
    )

    assert not qia_async_card_adapter.is_configured_qia_query_url(
        "https://qia.example.com/aigc_video/v2/scripts/1/card-status"
    )


def test_normalizes_qia_detail_link_and_buttons(monkeypatch) -> None:
    monkeypatch.setattr(
        qia_async_card_adapter.settings,
        "FRONTEND_URL",
        "http://localhost:3000",
    )

    snapshot = normalize_async_card_payload(
        {
            "wb_data": {
                "status": "completed",
                "card": {
                    "title": "一分钟短片",
                    "link": (
                        "/chat?mode=video&taskId=10" "&openPanel=script&scriptId=5"
                    ),
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
            }
        }
    )

    assert snapshot.card["link"] == (
        "http://localhost:3000/chat?mode=video&taskId=10" "&openPanel=script&scriptId=5"
    )
    assert snapshot.card["buttons"] == [
        {
            "button_id": "next",
            "button_name": "开始生成主体",
            "button_type": "chat",
        }
    ]
    assert "content" not in snapshot.card


def test_rejects_untrusted_relative_qia_detail_link(monkeypatch) -> None:
    monkeypatch.setattr(
        qia_async_card_adapter.settings,
        "FRONTEND_URL",
        "http://localhost:3000",
    )

    snapshot = normalize_async_card_payload(
        {
            "wb_data": {
                "status": "completed",
                "card": {
                    "title": "一分钟短片",
                    "link": "/admin?mode=video",
                },
            }
        }
    )

    assert "link" not in snapshot.card
