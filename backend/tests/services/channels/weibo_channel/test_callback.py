# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from app.services.channels.callback import ChannelType
from app.services.channels.weibo.callback import WeiboCallbackInfo, WeiboCallbackService


def test_callback_info_round_trips_to_dict():
    info = WeiboCallbackInfo(
        channel_id=7,
        conversation_id="10001",
        to_user_id="10001",
    )

    data = info.to_dict()
    restored = WeiboCallbackInfo.from_dict(data)

    assert data["channel_type"] == "weibo"
    assert restored.channel_type == ChannelType.WEIBO
    assert restored.channel_id == 7
    assert restored.conversation_id == "10001"
    assert restored.to_user_id == "10001"


@pytest.mark.asyncio
async def test_callback_service_creates_emitter_from_running_provider():
    service = WeiboCallbackService()
    sender = AsyncMock()
    provider = SimpleNamespace(sender=sender)

    with patch("app.services.channels.manager.get_channel_manager") as mock_manager:
        mock_manager.return_value.get_channel.return_value = provider
        emitter = await service._create_emitter(
            task_id=11,
            subtask_id=13,
            callback_info=WeiboCallbackInfo(
                channel_id=7,
                conversation_id="10001",
                to_user_id="10001",
            ),
        )

    assert emitter is not None
    assert emitter._sender is sender
