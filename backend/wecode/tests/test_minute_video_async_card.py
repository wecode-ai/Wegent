# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from wecode.service.minute_video_async_card import is_configured_qia_query_url


def test_allows_only_configured_qia_workflow_origin(monkeypatch) -> None:
    monkeypatch.setenv("AIGC_VIDEO_AGENT_URL", "https://qia.example.com")

    assert is_configured_qia_query_url(
        "https://qia.example.com/aigc_video/v2/scripts/1/card-status"
    )
    assert not is_configured_qia_query_url(
        "https://other.example.com/aigc_video/v2/scripts/1/card-status"
    )
    assert not is_configured_qia_query_url("https://qia.example.com/admin")
    assert not is_configured_qia_query_url(
        "https://user:password@qia.example.com/aigc_video/status"
    )
