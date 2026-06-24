# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.api.endpoints.admin import im_channels
from app.schemas.im_channel import IMChannelCreate, IMChannelUpdate, MessagerSpec


def test_weibo_channel_create_schema_accepts_weibo_type():
    channel = IMChannelCreate(
        name="weibo-main",
        channel_type="weibo",
        bot_purpose="wework_local",
        config={
            "app_id": "app-1",
            "app_secret": "secret-1",
            "user_mapping_mode": "select_user",
            "user_mapping_config": {"target_user_id": 1},
        },
        default_team_id=10,
    )

    assert channel.channel_type == "weibo"
    assert channel.bot_purpose == "wework_local"


def test_weibo_messager_spec_accepts_weibo_type():
    spec = MessagerSpec(
        channelType="weibo",
        botPurpose="wework_local",
        config={"app_id": "app-1", "app_secret": "secret-1"},
        defaultTeamId=10,
    )

    assert spec.channelType == "weibo"
    assert spec.botPurpose == "wework_local"


def test_create_messager_json_persists_bot_purpose():
    messager_json = im_channels._create_messager_json(
        name="wework-main",
        namespace="default",
        channel_type="weibo",
        bot_purpose="wework_local",
        is_enabled=True,
        config={"app_id": "app-1", "app_secret": "secret-1"},
        default_team_id=10,
        default_model_name="",
    )

    assert messager_json["spec"]["botPurpose"] == "wework_local"


def test_existing_im_channel_response_defaults_to_wegent_chat():
    kind = SimpleNamespace(
        id=1,
        name="legacy",
        namespace="default",
        json={
            "spec": {
                "channelType": "telegram",
                "isEnabled": True,
                "config": {"bot_token": "encrypted"},
                "defaultTeamId": 10,
                "defaultModelName": "",
            }
        },
        created_at=datetime.now(),
        updated_at=datetime.now(),
    )

    response = im_channels._kind_to_response(kind)

    assert response.bot_purpose == "wegent_chat"


def test_update_rejects_bot_purpose_changes():
    update = IMChannelUpdate(bot_purpose="wework_local")

    with pytest.raises(HTTPException) as exc_info:
        im_channels._validate_bot_purpose_update(
            existing_purpose="wegent_chat",
            requested_purpose=update.bot_purpose,
        )

    assert exc_info.value.status_code == 400


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
