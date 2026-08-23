# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace

from app.services.channels.dingtalk.handler import DingTalkChannelHandler


def test_parse_message_preserves_dingtalk_message_id() -> None:
    handler = DingTalkChannelHandler(channel_id=77)
    message = SimpleNamespace(
        text=SimpleNamespace(content="continue runtime"),
        message_type="text",
        sender_id="staff-a",
        sender_nick="Alice",
        sender_staff_id="staff-a",
        sender_corp_id="corp-a",
        chatbot_user_id="bot-a",
        at_users=[],
        conversation_id="conv-private",
        conversation_type="1",
        is_in_at_list=False,
        _wegent_callback_data={"msgId": "dingtalk-message-1"},
    )

    context = handler.parse_message(message)

    assert context.content == "continue runtime"
    assert context.extra_data["message_id"] == "dingtalk-message-1"
    assert context.extra_data["callback_data"]["msgId"] == "dingtalk-message-1"
    assert context.proactive_recipient_id == "staff-a"
