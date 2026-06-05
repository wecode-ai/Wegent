# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json

from app.models.user import User
from app.services.media.weibo_media_service import (
    WEIBO_DOWNLOAD_URL,
    WEIBO_SERVICE_UID,
    WeiboMediaService,
    resolve_weibo_media_uid,
)


def test_resolve_weibo_media_uid_prefers_bound_uid() -> None:
    user = User(
        user_name="bound-user",
        password_hash="test",
        email="bound@example.com",
        preferences=json.dumps({"weibo_binding": {"uid": "1234567890"}}),
    )

    assert resolve_weibo_media_uid(user) == 1234567890


def test_resolve_weibo_media_uid_falls_back_without_valid_binding() -> None:
    user = User(
        user_name="unbound-user",
        password_hash="test",
        email="unbound@example.com",
        preferences=json.dumps({"weibo_binding": {"uid": "not-a-number"}}),
    )

    assert resolve_weibo_media_uid(user) == WEIBO_SERVICE_UID
    assert resolve_weibo_media_uid(None) == WEIBO_SERVICE_UID


def test_get_download_url_uses_bound_uid_for_tauth(httpx_mock, monkeypatch) -> None:
    requested_uids: list[int] = []

    def fake_auth_headers(uid: int, headers=None):
        requested_uids.append(uid)
        return {**(headers or {}), "Authorization": f"TAuth2 uid={uid}"}

    monkeypatch.setattr(
        "app.services.media.weibo_media_service.auth_headers",
        fake_auth_headers,
    )
    httpx_mock.add_response(
        method="GET",
        url=f"{WEIBO_DOWNLOAD_URL}?fid=12345&source=3061639762",
        json={"succ": True, "url": "https://example.com/video.mp4"},
    )
    user = User(
        user_name="bound-user",
        password_hash="test",
        email="bound@example.com",
        preferences=json.dumps({"weibo_binding": {"uid": "1234567890"}}),
    )

    video_url = WeiboMediaService().get_download_url(12345, user=user)

    assert video_url == "https://example.com/video.mp4"
    assert requested_uids == [1234567890]
