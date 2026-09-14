# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

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


def test_dingtalk_create_requires_task_agent():
    with pytest.raises(HTTPException, match="Task agent is required") as raised:
        im_channels._validate_dingtalk_task_team(
            MagicMock(),
            channel_type="dingtalk",
            team_id=0,
            required=True,
        )

    assert raised.value.status_code == 400


def test_dingtalk_task_agent_must_be_claudecode(monkeypatch):
    db = MagicMock()
    team = SimpleNamespace(id=22)
    db.query.return_value.filter.return_value.first.return_value = team
    monkeypatch.setattr(
        "app.services.channels.team_selection.team_uses_only_shell_type",
        MagicMock(return_value=False),
    )

    with pytest.raises(HTTPException, match="must use ClaudeCode") as raised:
        im_channels._validate_dingtalk_task_team(
            db,
            channel_type="dingtalk",
            team_id=22,
        )

    assert raised.value.status_code == 400
