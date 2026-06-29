# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.api.endpoints.admin import im_channels
from app.schemas.im_channel import IMChannelCreate, MessagerSpec


def test_weibo_channel_create_schema_accepts_weibo_type():
    channel = IMChannelCreate(
        name="weibo-main",
        channel_type="weibo",
        config={
            "app_id": "app-1",
            "app_secret": "secret-1",
            "user_mapping_mode": "select_user",
            "user_mapping_config": {"target_user_id": 1},
        },
        default_team_id=10,
    )

    assert channel.channel_type == "weibo"


def test_weibo_messager_spec_accepts_weibo_type():
    spec = MessagerSpec(
        channelType="weibo",
        config={"app_id": "app-1", "app_secret": "secret-1"},
        defaultTeamId=10,
    )

    assert spec.channelType == "weibo"


def test_weibo_app_secret_is_encrypted_and_masked():
    encrypted = im_channels._encrypt_config(
        {
            "app_id": "app-1",
            "app_secret": "secret-1",
            "ws_endpoint": "ws://example.test/ws",
        }
    )

    assert encrypted["app_id"] == "app-1"
    assert encrypted["app_secret"] != "secret-1"
    assert im_channels._mask_config(encrypted)["app_secret"] == "***"
