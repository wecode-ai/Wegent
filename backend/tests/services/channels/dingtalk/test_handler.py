# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services.channels.device_selection import DeviceSelection, DeviceType
from app.services.channels.dingtalk.handler import DingTalkChannelHandler
from app.services.channels.handler import MessageContext


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


@pytest.mark.parametrize(
    ("callback_data", "expected_reply_id"),
    [
        (
            {
                "text": {
                    "content": "quoted reply",
                    "isReplyMsg": True,
                    "repliedMsg": {"msgId": "quoted-message-id"},
                },
                "originalProcessQueryKey": "notification-query-key",
            },
            "notification-query-key",
        ),
        (
            {
                "text": {
                    "content": "quoted reply",
                    "isReplyMsg": True,
                    "repliedMsg": {"msgId": "quoted-message-id"},
                },
            },
            "quoted-message-id",
        ),
    ],
)
def test_parse_message_preserves_dingtalk_quote_reference(
    callback_data: dict,
    expected_reply_id: str,
) -> None:
    handler = DingTalkChannelHandler(channel_id=77)
    message = SimpleNamespace(
        text=SimpleNamespace(content="quoted reply"),
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
        _wegent_callback_data=callback_data,
    )

    context = handler.parse_message(message)

    assert context.extra_data["reply_to_message_id"] == expected_reply_id


def test_parse_message_does_not_mark_plain_text_as_quote() -> None:
    handler = DingTalkChannelHandler(channel_id=77)
    message = SimpleNamespace(
        text=SimpleNamespace(content="plain text"),
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
        _wegent_callback_data={
            "msgId": "plain-message-id",
            "text": {"content": "plain text"},
        },
    )

    context = handler.parse_message(message)

    assert "reply_to_message_id" not in context.extra_data


def _message_context() -> MessageContext:
    return MessageContext(
        content="你好",
        sender_id="staff-a",
        sender_name="Alice",
        conversation_id="conv-private",
        conversation_type="private",
        is_mention=False,
        raw_message={},
        extra_data={},
    )


@pytest.mark.asyncio
async def test_devices_command_selects_app_execution_target(
    monkeypatch: pytest.MonkeyPatch,
    test_db,
    test_user,
) -> None:
    handler = DingTalkChannelHandler(channel_id=77)
    handler.send_text_reply = AsyncMock(return_value=True)
    handler._get_device_mode_model_override = AsyncMock(return_value=(None, None))
    handler._delete_conversation_task_id = AsyncMock()
    get_all_devices = AsyncMock(
        return_value=[
            {
                "device_id": "local-device",
                "execution_target_id": "app-record-1819",
                "name": "APB22015038",
                "status": "online",
            }
        ]
    )
    get_selection = AsyncMock(return_value=DeviceSelection.default())
    set_local_device = AsyncMock(return_value=True)
    monkeypatch.setattr(
        "app.services.device_service.device_service.get_all_devices",
        get_all_devices,
    )
    monkeypatch.setattr(
        "app.services.channels.handler.model_selection_manager.get_selection",
        AsyncMock(return_value=None),
    )
    monkeypatch.setattr(
        "app.services.channels.handler.device_selection_manager.get_selection",
        get_selection,
    )
    monkeypatch.setattr(
        "app.services.channels.handler.device_selection_manager.set_local_device",
        set_local_device,
    )

    await handler._handle_devices_command(
        test_db,
        test_user,
        "1",
        _message_context(),
    )

    set_local_device.assert_awaited_once_with(
        test_user.id,
        "app-record-1819",
        "APB22015038",
    )


@pytest.mark.asyncio
async def test_devices_command_marks_app_execution_target_current(
    monkeypatch: pytest.MonkeyPatch,
    test_db,
    test_user,
) -> None:
    handler = DingTalkChannelHandler(channel_id=77)
    handler.send_text_reply = AsyncMock(return_value=True)
    devices = [
        {
            "device_id": "local-device",
            "execution_target_id": "app-record-1819",
            "name": "APB22015038",
            "status": "online",
        }
    ]
    monkeypatch.setattr(
        "app.services.device_service.device_service.get_all_devices",
        AsyncMock(return_value=devices),
    )
    monkeypatch.setattr(
        "app.services.channels.handler.device_selection_manager.get_selection",
        AsyncMock(
            return_value=DeviceSelection(
                device_type=DeviceType.LOCAL,
                device_id="app-record-1819",
                device_name="APB22015038",
            )
        ),
    )

    await handler._handle_devices_command(
        test_db,
        test_user,
        None,
        _message_context(),
    )

    reply = handler.send_text_reply.await_args.args[1]
    assert "APB22015038" in reply
    assert "⭐ 当前" in reply


@pytest.mark.asyncio
async def test_device_mode_migrates_legacy_app_selection_before_routing(
    monkeypatch: pytest.MonkeyPatch,
    test_user,
) -> None:
    handler = DingTalkChannelHandler(channel_id=77)
    handler.send_text_reply = AsyncMock(return_value=True)
    handler._get_task_mode_team = MagicMock(return_value=SimpleNamespace(id=10))
    handler._create_and_process_device_task = AsyncMock(return_value=None)
    route = SimpleNamespace(
        logical_device_id="local-device",
        runtime_device_id="app-record-1819",
        online_info={"status": "online", "socket_id": "socket-1"},
    )
    resolve = AsyncMock(return_value=route)
    set_local_device = AsyncMock(return_value=True)
    db = SimpleNamespace(close=MagicMock())
    monkeypatch.setattr("app.services.channels.handler.SessionLocal", lambda: db)
    monkeypatch.setattr(
        "app.services.device.runtime_route.runtime_route_resolver.resolve",
        resolve,
    )
    monkeypatch.setattr(
        "app.services.channels.handler.device_selection_manager.set_local_device",
        set_local_device,
    )

    await handler._process_device_mode(
        test_user,
        DeviceSelection(
            device_type=DeviceType.LOCAL,
            device_id="local-device",
            device_name="APB22015038",
        ),
        _message_context(),
    )

    resolve.assert_awaited_once_with(
        user_id=test_user.id,
        submitted_device_id="local-device",
    )
    set_local_device.assert_awaited_once_with(
        test_user.id,
        "app-record-1819",
        "APB22015038",
    )
    assert handler._create_and_process_device_task.await_args.kwargs["device_id"] == (
        "app-record-1819"
    )
