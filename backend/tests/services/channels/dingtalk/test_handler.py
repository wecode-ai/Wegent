# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import copy
import json
import logging
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, Mock

import pytest
import requests
from dingtalk_stream import AckMessage

from app.services.channels.device_selection import DeviceSelection, DeviceType
from app.services.channels.dingtalk import handler as handler_module
from app.services.channels.dingtalk.handler import (
    DingTalkChannelHandler,
    WegentChatbotHandler,
)
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


@pytest.mark.asyncio
@pytest.mark.parametrize("is_new", [True, False])
async def test_received_log_preserves_reference_structure_and_redacts_credentials(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture, is_new: bool
) -> None:
    # Reference fields are synthetic: diagnostics must retain unknown SDK fields.
    data = {
        "msgId": "message-2",
        "msgtype": "text",
        "conversationId": "group-1",
        "conversationType": "2",
        "senderId": "sender-a",
        "sessionWebhook": "https://example.test/reply?session=transport-secret",
        "text": {
            "content": "请继续分析" * 30,
            "reference": {
                "msgId": "message-1",
                "cardInstanceId": "card-1",
                "content": [{"text": "上一轮回答", "downloadCode": "media-secret"}],
                "encoded": json.dumps({"accessToken": "encoded-secret"}),
            },
        },
    }
    original = copy.deepcopy(data)
    on_message = AsyncMock()
    handler = WegentChatbotHandler(channel_id=77, on_message=on_message)
    monkeypatch.setattr(
        handler_module.cache_manager, "setnx", AsyncMock(return_value=is_new)
    )

    with caplog.at_level(logging.INFO, logger=handler_module.__name__):
        status, _ = await handler.process(
            SimpleNamespace(data=data, headers=SimpleNamespace(extensions={}))
        )

    assert status == AckMessage.STATUS_OK
    assert data == original
    records = [r for r in caplog.records if r.msg == "[DingTalkMessage] %s %s"]
    assert len(records) == 1
    assert records[0].args[0] == "received"
    logged = json.loads(records[0].args[1])
    assert logged["channel_id"] == 77
    assert logged["data"]["msgId"] == "message-2"
    assert logged["data"]["conversationId"] == "group-1"
    assert logged["data"]["text"]["content"] == data["text"]["content"]
    reference = logged["data"]["text"]["reference"]
    assert reference["msgId"] == "message-1"
    assert reference["cardInstanceId"] == "card-1"
    assert reference["content"][0]["text"] == "上一轮回答"
    for secret in ("transport-secret", "media-secret", "encoded-secret"):
        assert secret not in caplog.text
    assert on_message.await_count == int(is_new)


@pytest.mark.asyncio
async def test_received_payload_is_logged_before_sdk_parsing(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    def reject_message(_data):
        raise ValueError("Unsupported test message")

    monkeypatch.setattr(handler_module.ChatbotMessage, "from_dict", reject_message)
    handler = WegentChatbotHandler(channel_id=77)

    with caplog.at_level(logging.INFO, logger=handler_module.__name__):
        status, _ = await handler.process(
            SimpleNamespace(
                data={"msgId": "unknown-format", "unknownField": True},
                headers=SimpleNamespace(extensions={}),
            )
        )

    assert status == AckMessage.STATUS_SYSTEM_EXCEPTION
    records = [r for r in caplog.records if r.msg == "[DingTalkMessage] %s %s"]
    assert len(records) == 1
    assert json.loads(records[0].args[1])["data"]["unknownField"] is True


@pytest.mark.asyncio
async def test_received_rich_text_image_credentials_are_redacted(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    data = {
        "msgId": "image-message-1",
        "msgtype": "richText",
        "content": {
            "richText": [
                {"text": "测试一下图片"},
                {
                    "type": "picture",
                    "pictureDownloadCode": "picture-download-secret",
                    "downloadCode": "download-secret",
                },
            ]
        },
    }
    original = copy.deepcopy(data)
    handler = WegentChatbotHandler(channel_id=77, on_message=AsyncMock())
    monkeypatch.setattr(
        handler_module.cache_manager, "setnx", AsyncMock(return_value=True)
    )

    with caplog.at_level(logging.INFO, logger=handler_module.__name__):
        status, _ = await handler.process(
            SimpleNamespace(data=data, headers=SimpleNamespace(extensions={}))
        )

    assert status == AckMessage.STATUS_OK
    assert data == original
    records = [r for r in caplog.records if r.msg == "[DingTalkMessage] %s %s"]
    assert len(records) == 1
    logged = json.loads(records[0].args[1])["data"]
    parts = logged["content"]["richText"]
    assert parts[0]["text"] == "测试一下图片"
    assert parts[1] == {
        "type": "picture",
        "pictureDownloadCode": "[REDACTED]",
        "downloadCode": "[REDACTED]",
    }
    assert "picture-download-secret" not in caplog.text
    assert "download-secret" not in caplog.text


@pytest.mark.asyncio
@pytest.mark.parametrize("source", ["file", "encoded_file", "quoted_file"])
async def test_file_download_reaches_message_context(
    monkeypatch: pytest.MonkeyPatch, source: str
) -> None:
    file_content = {
        "downloadCode": "test-download-code",
        "fileName": "遮罩组件.html",
    }
    data = {"msgId": "file-message-1", "conversationType": "2"}
    if source == "quoted_file":
        data.update(
            msgtype="text",
            text={
                "content": " 测试文件 引用",
                "isReplyMsg": True,
                "repliedMsg": {
                    "msgType": "file",
                    "msgId": "original-file-message",
                    "content": file_content,
                },
            },
        )
    else:
        data.update(
            msgtype="file",
            content=(
                json.dumps(file_content) if source == "encoded_file" else file_content
            ),
        )
    original = copy.deepcopy(data)
    handler = WegentChatbotHandler(channel_id=77)
    download_url = "https://example.test/file"
    get_url = Mock(return_value=download_url)
    content = b"<html><body>test</body></html>"
    get_file = Mock(return_value=Mock(content=content))
    handle_message = AsyncMock(return_value=True)
    monkeypatch.setattr(handler, "get_image_download_url", get_url)
    monkeypatch.setattr(requests, "get", get_file)
    monkeypatch.setattr(handler_module, "SessionLocal", Mock())
    monkeypatch.setattr(
        handler_module.cache_manager, "setnx", AsyncMock(return_value=True)
    )
    monkeypatch.setattr(
        handler._channel_handler, "resolve_user", AsyncMock(return_value=None)
    )
    monkeypatch.setattr(handler._channel_handler, "handle_message", handle_message)

    status, _ = await handler.process(
        SimpleNamespace(data=data, headers=SimpleNamespace(extensions={}))
    )

    assert status == AckMessage.STATUS_OK
    assert data == original
    get_url.assert_called_once_with("test-download-code")
    get_file.assert_called_once_with(download_url, timeout=60)
    handle_message.assert_awaited_once()
    context = handler._channel_handler.parse_message(handle_message.await_args.args[0])
    assert context.files == [
        {
            "filename": "遮罩组件.html",
            "binary_data": content,
            "file_size": len(content),
        }
    ]
    if source == "quoted_file":
        assert context.content == "测试文件 引用"
        assert (
            context.extra_data["callback_data"]["text"]["repliedMsg"]
            == data["text"]["repliedMsg"]
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("file_content", [None, [], "[]", "invalid json", {}])
async def test_invalid_file_metadata_does_not_download(
    monkeypatch: pytest.MonkeyPatch, file_content: object
) -> None:
    handler = WegentChatbotHandler(channel_id=77)
    get_url = Mock()
    monkeypatch.setattr(handler, "get_image_download_url", get_url)

    files = await handler._download_dingtalk_file(file_content)

    assert files == []
    get_url.assert_not_called()


@pytest.mark.asyncio
async def test_failed_file_download_does_not_log_download_credentials(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    handler = WegentChatbotHandler(channel_id=77)
    monkeypatch.setattr(
        handler,
        "get_image_download_url",
        Mock(return_value="https://example.test/file?signature=download-secret"),
    )
    response = Mock()
    response.raise_for_status.side_effect = requests.HTTPError(
        "403 Forbidden: https://example.test/file?signature=download-secret"
    )
    monkeypatch.setattr(requests, "get", Mock(return_value=response))

    with caplog.at_level(logging.ERROR, logger=handler_module.__name__):
        files = await handler._download_dingtalk_file(
            {"downloadCode": "file-download-code", "fileName": "file.html"}
        )

    assert files == []
    assert "HTTPError" in caplog.text
    assert "download-secret" not in caplog.text
    assert "file-download-code" not in caplog.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "response, expected",
    [
        ({"errcode": 0}, True),
        ({"errcode": 400, "errmsg": "denied"}, False),
        (None, False),
    ],
)
async def test_text_reply_checks_dingtalk_business_result(response, expected, caplog):
    from dingtalk_stream import ChatbotMessage

    handler = DingTalkChannelHandler(channel_id=77)
    sdk = Mock()
    sdk.reply_text.return_value = response
    handler.set_chatbot_handler(sdk)
    message = ChatbotMessage.from_dict(
        {"msgtype": "text", "text": {"content": "/new"}, "msgId": "new-test"}
    )
    context = handler.parse_message(message)
    with caplog.at_level(logging.INFO):
        assert await handler.send_text_reply(context, "选择新会话") is expected
    sdk.reply_text.assert_called_once_with("选择新会话", message)
    assert "text_reply_result" in caplog.text


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
