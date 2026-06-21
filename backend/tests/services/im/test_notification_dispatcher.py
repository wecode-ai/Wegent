# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from typing import Any

import pytest
from sqlalchemy.orm import Session

from app.models.im_session import IMPrivateSession
from app.models.kind import Kind
from app.services.im.notification_dispatcher import im_notification_dispatcher
from app.services.im.session_service import im_session_service
from shared.utils.crypto import encrypt_sensitive_data


def _create_channel(
    db: Session,
    *,
    channel_id: int,
    channel_type: str,
    config: dict[str, Any],
) -> Kind:
    channel = Kind(
        id=channel_id,
        user_id=0,
        kind="Messager",
        name=f"{channel_type}-{channel_id}",
        namespace="system",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Messager",
            "metadata": {"name": f"{channel_type}-{channel_id}", "namespace": "system"},
            "spec": {
                "channelType": channel_type,
                "isEnabled": True,
                "config": config,
            },
        },
        is_active=True,
    )
    db.add(channel)
    return channel


def _create_session(
    *,
    user_id: int,
    channel_id: int,
    channel_type: str,
    sender_id: str,
) -> IMPrivateSession:
    return IMPrivateSession(
        session_key=im_session_service.build_session_key(
            user_id=user_id,
            channel_type=channel_type,
            channel_id=channel_id,
            conversation_id=f"conv-{channel_id}",
        ),
        user_id=user_id,
        channel_type=channel_type,
        channel_id=channel_id,
        conversation_id=f"conv-{channel_id}",
        sender_id=sender_id,
        display_name=f"sender-{sender_id}",
        last_seen_at=datetime.now(),
    )


@pytest.mark.asyncio
async def test_dingtalk_notification_decrypts_channel_secret(
    test_db: Session,
    test_user,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _create_channel(
        test_db,
        channel_id=9401,
        channel_type="dingtalk",
        config={
            "client_id": "ding-client-id",
            "client_secret": encrypt_sensitive_data("ding-client-secret"),
        },
    )
    session = _create_session(
        user_id=test_user.id,
        channel_id=9401,
        channel_type="dingtalk",
        sender_id="staff-1",
    )
    test_db.commit()
    calls: list[dict[str, Any]] = []

    class FakeDingTalkRobotSender:
        def __init__(self, client_id: str, client_secret: str):
            calls.append({"client_id": client_id, "client_secret": client_secret})

        async def send_text_message(self, user_ids: list[str], content: str):
            calls.append({"user_ids": user_ids, "content": content})
            return {"success": True}

    monkeypatch.setattr(
        "app.services.channels.dingtalk.sender.DingTalkRobotSender",
        FakeDingTalkRobotSender,
    )

    result = await im_notification_dispatcher.send_text(
        test_db,
        session,
        "已切换",
    )

    assert result["success"] is True
    assert calls[0] == {
        "client_id": "ding-client-id",
        "client_secret": "ding-client-secret",
    }
    assert calls[1] == {"user_ids": ["staff-1"], "content": "已切换"}


@pytest.mark.asyncio
async def test_telegram_notification_decrypts_bot_token(
    test_db: Session,
    test_user,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _create_channel(
        test_db,
        channel_id=9402,
        channel_type="telegram",
        config={"botToken": encrypt_sensitive_data("telegram-token")},
    )
    session = _create_session(
        user_id=test_user.id,
        channel_id=9402,
        channel_type="telegram",
        sender_id="100200300",
    )
    test_db.commit()
    calls: list[dict[str, Any]] = []

    class FakeTelegramBotSender:
        def __init__(self, bot_token: str):
            calls.append({"bot_token": bot_token})

        async def send_text_message(self, chat_id: int, text: str):
            calls.append({"chat_id": chat_id, "text": text})
            return {
                "success": True,
                "result": {
                    "result": {
                        "message_id": 3201,
                    },
                },
            }

    monkeypatch.setattr(
        "app.services.channels.telegram.sender.TelegramBotSender",
        FakeTelegramBotSender,
    )

    result = await im_notification_dispatcher.send_text(
        test_db,
        session,
        "已切换",
    )

    assert result["success"] is True
    assert calls[0] == {"bot_token": "telegram-token"}
    assert calls[1] == {"chat_id": 100200300, "text": "已切换"}


@pytest.mark.asyncio
async def test_runtime_task_update_uses_global_im_notification_target(
    test_db: Session,
    test_user,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _create_channel(
        test_db,
        channel_id=9412,
        channel_type="telegram",
        config={"botToken": encrypt_sensitive_data("telegram-token")},
    )
    session = _create_session(
        user_id=test_user.id,
        channel_id=9412,
        channel_type="telegram",
        sender_id="100200300",
    )
    await im_session_service.save_session(session)
    await im_session_service.enable_global_notification(test_db, session=session)
    test_db.commit()
    calls: list[dict[str, Any]] = []

    class FakeTelegramBotSender:
        def __init__(self, bot_token: str):
            calls.append({"bot_token": bot_token})

        async def send_text_message(self, chat_id: int, text: str):
            calls.append({"chat_id": chat_id, "text": text})
            return {
                "success": True,
                "result": {
                    "result": {
                        "message_id": 3201,
                    },
                },
            }

    monkeypatch.setattr(
        "app.services.channels.telegram.sender.TelegramBotSender",
        FakeTelegramBotSender,
    )

    result = await im_notification_dispatcher.send_runtime_task_update(
        test_db,
        user_id=test_user.id,
        address={
            "deviceId": "device-1",
            "localTaskId": "codex-thread-1",
        },
        title="Native Codex task",
        status="updated",
        content="Implemented from native Codex",
        source="codex_watcher",
    )

    assert result["sent"] == 1
    assert calls[1]["chat_id"] == 100200300
    assert "Native Codex task" in calls[1]["text"]
    assert "Implemented from native Codex" in calls[1]["text"]


@pytest.mark.asyncio
async def test_runtime_task_update_uses_subscribed_native_codex_task(
    test_db: Session,
    test_user,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _create_channel(
        test_db,
        channel_id=9413,
        channel_type="telegram",
        config={"botToken": encrypt_sensitive_data("telegram-token")},
    )
    session = _create_session(
        user_id=test_user.id,
        channel_id=9413,
        channel_type="telegram",
        sender_id="100200301",
    )
    subscription_address = {
        "deviceId": "device-1",
        "localTaskId": "codex-thread-1",
        "workspacePath": "/repo/Wegent",
    }
    await im_session_service.save_session(session)
    await im_session_service.subscribe_runtime_task_notification(
        test_db,
        session=session,
        runtime_task=subscription_address,
    )
    test_db.commit()
    calls: list[dict[str, Any]] = []

    class FakeTelegramBotSender:
        def __init__(self, bot_token: str):
            calls.append({"bot_token": bot_token})

        async def send_text_message(self, chat_id: int, text: str):
            calls.append({"chat_id": chat_id, "text": text})
            return {
                "success": True,
                "result": {
                    "result": {
                        "message_id": 3201,
                    },
                },
            }

    monkeypatch.setattr(
        "app.services.channels.telegram.sender.TelegramBotSender",
        FakeTelegramBotSender,
    )

    result = await im_notification_dispatcher.send_runtime_task_update(
        test_db,
        user_id=test_user.id,
        address={
            "deviceId": "device-1",
            "localTaskId": "codex-thread-1",
        },
        title="Native Codex task",
        status="updated",
        content="Subscribed update",
        source="codex_watcher",
    )

    assert result["sent"] == 1
    assert calls[1]["chat_id"] == 100200301
    assert "Native Codex task" in calls[1]["text"]
    assert "Subscribed update" in calls[1]["text"]
    assert await im_session_service.get_runtime_task_reply_target(
        session=session,
        message_id=3201,
    ) == {
        "deviceId": "device-1",
        "localTaskId": "codex-thread-1",
    }


@pytest.mark.asyncio
async def test_discord_notification_decrypts_bot_token(
    test_db: Session,
    test_user,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _create_channel(
        test_db,
        channel_id=9403,
        channel_type="discord",
        config={"botToken": encrypt_sensitive_data("discord-token")},
    )
    session = _create_session(
        user_id=test_user.id,
        channel_id=9403,
        channel_type="discord",
        sender_id="123456",
    )
    test_db.commit()
    calls: list[dict[str, Any]] = []

    class FakeDiscordBotSender:
        def __init__(self, bot_token: str):
            calls.append({"bot_token": bot_token})

        async def send_text_message(self, user_id: str, text: str):
            calls.append({"user_id": user_id, "text": text})
            return {"success": True}

    monkeypatch.setattr(
        "app.services.channels.discord.sender.DiscordBotSender",
        FakeDiscordBotSender,
    )

    result = await im_notification_dispatcher.send_text(
        test_db,
        session,
        "已切换",
    )

    assert result["success"] is True
    assert calls[0] == {"bot_token": "discord-token"}
    assert calls[1] == {"user_id": "123456", "text": "已切换"}
