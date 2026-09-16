"""Quoted replies must follow the delivered card, not the sender's current task."""

from unittest.mock import AsyncMock, Mock

import pytest
from dingtalk_stream import ChatbotMessage

from app.core.cache import cache_manager
from app.schemas.dingtalk_card import DingTalkChatCardConfig
from app.services.channels.dingtalk.card_binding import CardBinding, save_binding
from app.services.channels.dingtalk.card_follow_up import DingTalkCardCallbackHandler
from app.services.channels.dingtalk.card_quotes import (
    route_quoted_card,
    save_quote_address,
)
from app.services.channels.dingtalk.handler import (
    DingTalkChannelHandler,
    WegentChatbotHandler,
)


@pytest.fixture
async def quote_case(monkeypatch):
    values = {}

    async def get(key):
        return values.get(key)

    async def set_value(key, value, expire=None):
        values[key] = value
        return True

    monkeypatch.setattr(cache_manager, "get", get)
    monkeypatch.setattr(cache_manager, "set", set_value)
    config = DingTalkChatCardConfig(template_id="test.schema")
    binding = CardBinding(
        channel_id=285,
        user_id=7,
        task_id=446,
        subtask_id=668,
        config=config,
        ready=True,
        incoming_data={
            "senderStaffId": "212680",
            "senderCorpId": "corp-a",
            "conversationId": "group-a",
            "conversationType": "2",
        },
    )
    await save_binding("card-446", binding)
    await save_quote_address(285, "group-a", "delivery-carrier", "card-446")
    handler = DingTalkChannelHandler(
        channel_id=285, get_chat_card_config=lambda: config.model_dump()
    )
    receiver = DingTalkCardCallbackHandler(handler)
    receiver.inbox = Mock(enqueue=AsyncMock(return_value=True))
    receiver._schedule = Mock()
    receiver._report_error = AsyncMock()
    data = {
        "conversationType": "2",
        "conversationId": "group-a",
        "isInAtList": True,
        "originalProcessQueryKey": "delivery-carrier",
        "originalMsgId": "quoted-msg",
        "msgId": "new-msg",
        "chatbotUserId": "robot-a",
        "senderStaffId": "220750",
        "senderCorpId": "corp-a",
        "text": {
            "isReplyMsg": True,
            "content": "2027 追加",
            "repliedMsg": {
                "msgType": "interactiveCard",
                "msgId": "quoted-msg",
                "senderId": "robot-a",
                "content": {"taskId": "999"},
            },
        },
    }
    return receiver, binding, data


@pytest.mark.asyncio
async def test_quote_uses_delivery_mapping_and_actual_actor(quote_case):
    receiver, _, data = quote_case
    assert await route_quoted_card(receiver, data)
    record = receiver.inbox.enqueue.call_args.args[0]
    assert record.binding.task_id == 446
    assert record.actor_staff_id == "220750"
    assert record.text == "2027 追加"
    assert record.track_id == "card-446"
    receiver._schedule.assert_called_once_with("new-msg")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "change",
    [
        {"originalProcessQueryKey": "unmapped"},
        {"conversationId": "another-group"},
        {"senderCorpId": "another-corp"},
        {"conversationType": "1"},
        {"isInAtList": False},
        {"chatbotUserId": "another-robot"},
        {"text": {"isReplyMsg": False, "content": "hello"}},
    ],
)
async def test_unmatched_messages_keep_original_routing(quote_case, change):
    receiver, _, data = quote_case
    data.update(change)
    assert not await route_quoted_card(receiver, data)
    receiver.inbox.enqueue.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("command", ["/new", "/help"])
async def test_quoted_commands_keep_command_routing(quote_case, command):
    receiver, _, data = quote_case
    data["text"]["content"] = command
    assert not await route_quoted_card(receiver, data)
    receiver.inbox.enqueue.assert_not_awaited()


@pytest.mark.asyncio
async def test_quote_of_running_card_reports_rejection_without_new_task(quote_case):
    receiver, binding, data = quote_case
    binding.ready = False
    await save_binding("card-446", binding)
    assert await route_quoted_card(receiver, data)
    receiver.inbox.enqueue.assert_not_awaited()
    assert "仍在生成" in receiver._report_error.call_args.args[1]


@pytest.mark.asyncio
async def test_duplicate_quote_reuses_inbox_deduplication(quote_case):
    receiver, _, data = quote_case
    receiver.inbox.enqueue.side_effect = [True, False]
    assert await route_quoted_card(receiver, data)
    assert await route_quoted_card(receiver, data)
    receiver._schedule.assert_called_once()


@pytest.mark.asyncio
async def test_sdk_routes_matched_quote_before_normal_task_creation():
    handler = WegentChatbotHandler(channel_id=285)
    route = AsyncMock(return_value=True)
    handler.set_card_quote_handler(route)
    handler._channel_handler.handle_message = AsyncMock()
    data = {"text": {"content": "next"}, "msgtype": "text"}
    assert await handler._process_with_channel_handler(
        ChatbotMessage.from_dict(data), data
    )
    route.assert_awaited_once_with(data)
    handler._channel_handler.handle_message.assert_not_awaited()
