# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
from datetime import datetime
from typing import Any
from unittest.mock import AsyncMock

import pytest
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.im_session import IMPrivateSession
from app.models.kind import Kind
from app.schemas.dingtalk_card import BUILTIN_NOTIFICATION_CARD_TEMPLATE_ID
from app.services.im.notification_dispatcher import im_notification_dispatcher
from app.services.im.session_service import im_session_service
from app.services.notification_copy import NotificationLink, PushNotification
from app.services.subscription.notification_service import (
    subscription_notification_service,
)
from shared.utils.crypto import encrypt_sensitive_data


@pytest.fixture(autouse=True)
def isolate_im_session_cache(fake_im_session_cache: Any) -> Any:
    """Keep dispatcher tests from mutating the developer's Redis state."""

    return fake_im_session_cache


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
    proactive_recipient_id: str = "",
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
        proactive_recipient_id=proactive_recipient_id,
        display_name=f"sender-{sender_id}",
        last_seen_at=datetime.now(),
    )


@pytest.mark.asyncio
async def test_dingtalk_notification_uses_private_session_staff_id(
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
        sender_id="sender-union-1",
        proactive_recipient_id="staff-1",
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
async def test_dingtalk_legacy_binding_backfill_requires_matching_conversation(
    test_db: Session,
    test_user,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _create_channel(
        test_db,
        channel_id=9403,
        channel_type="dingtalk",
        config={
            "client_id": "ding-client-id",
            "client_secret": encrypt_sensitive_data("ding-client-secret"),
        },
    )
    session = _create_session(
        user_id=test_user.id,
        channel_id=9403,
        channel_type="dingtalk",
        sender_id="sender-union-1",
    )
    subscription_notification_service.update_user_im_binding(
        test_db,
        user_id=test_user.id,
        channel_id=9403,
        channel_type="dingtalk",
        sender_id="sender-union-2",
        sender_staff_id="staff-2",
        conversation_id="another-conversation",
    )
    test_db.commit()
    calls: list[list[str]] = []

    class FakeDingTalkRobotSender:
        def __init__(self, client_id: str, client_secret: str):
            pass

        async def send_text_message(self, user_ids: list[str], content: str):
            calls.append(user_ids)
            return {"success": True}

    monkeypatch.setattr(
        "app.services.channels.dingtalk.sender.DingTalkRobotSender",
        FakeDingTalkRobotSender,
    )

    mismatched = await im_notification_dispatcher.send_text(
        test_db,
        session,
        "不会串发",
    )

    assert mismatched["success"] is False
    assert mismatched["error"] == "Missing DingTalk staff ID"
    assert calls == []

    subscription_notification_service.update_user_im_binding(
        test_db,
        user_id=test_user.id,
        channel_id=9403,
        channel_type="dingtalk",
        sender_id="sender-union-1",
        sender_staff_id="staff-1",
        conversation_id=session.conversation_id,
    )

    matched = await im_notification_dispatcher.send_text(
        test_db,
        session,
        "安全回填",
    )

    assert matched["success"] is True
    assert calls == [["staff-1"]]
    assert session.proactive_recipient_id == "staff-1"


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
    assert calls[1]["text"] == (
        "你的任务有新的 AI 回复\n\n"
        "任务标题：Native Codex task\n\n"
        "任务状态：有新的 AI 回复\n\n"
        "最新回复：Implemented from native Codex"
    )


@pytest.mark.asyncio
async def test_dingtalk_runtime_notification_enables_quoted_reply_continuation(
    test_db: Session,
    test_user,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _create_channel(
        test_db,
        channel_id=9414,
        channel_type="dingtalk",
        config={
            "client_id": "ding-client-id",
            "client_secret": encrypt_sensitive_data("ding-client-secret"),
        },
    )
    session = _create_session(
        user_id=test_user.id,
        channel_id=9414,
        channel_type="dingtalk",
        sender_id="sender-union-1",
        proactive_recipient_id="staff-1",
    )
    await im_session_service.save_session(session)
    await im_session_service.enable_global_notification(test_db, session=session)
    test_db.commit()
    calls: list[dict[str, Any]] = []

    class FakeDingTalkRobotSender:
        def __init__(self, client_id: str, client_secret: str):
            calls.append({"client_id": client_id, "client_secret": client_secret})

        async def send_text_message(self, user_ids: list[str], content: str):
            calls.append({"user_ids": user_ids, "content": content})
            return {"success": True, "result": {"processQueryKey": "query-1"}}

    monkeypatch.setattr(
        "app.services.channels.dingtalk.sender.DingTalkRobotSender",
        FakeDingTalkRobotSender,
    )
    address = {
        "deviceId": "device-1",
        "localTaskId": "runtime-1",
        "modelSelection": {
            "modelName": "deepseek-v4-pro-responses(public)",
            "modelType": "public",
            "options": {"reasoning": "medium"},
        },
    }

    result = await im_notification_dispatcher.send_runtime_task_update(
        test_db,
        user_id=test_user.id,
        address=address,
        title="Native Codex task",
        status="updated",
        content="Implemented from native Codex",
        source="codex_watcher",
    )

    assert result["sent"] == 1
    assert calls[1] == {
        "user_ids": ["staff-1"],
        "content": (
            "你的任务有新的 AI 回复\n\n"
            "任务标题：Native Codex task\n\n"
            "任务状态：有新的 AI 回复\n\n"
            "最新回复：Implemented from native Codex\n\n"
            "引用本通知回复，即可继续该任务。"
        ),
    }
    assert (
        await im_session_service.get_runtime_task_reply_target(
            session=session,
            message_id="query-1",
        )
        == address
    )


@pytest.mark.asyncio
async def test_dingtalk_notification_pushes_the_inbox_headline_above_a_link(
    test_db: Session,
    test_user,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _create_channel(
        test_db,
        channel_id=9421,
        channel_type="dingtalk",
        config={
            "client_id": "ding-client-id",
            "client_secret": encrypt_sensitive_data("ding-client-secret"),
        },
    )
    session = _create_session(
        user_id=test_user.id,
        channel_id=9421,
        channel_type="dingtalk",
        sender_id="sender-union-1",
        proactive_recipient_id="staff-1",
    )
    test_db.commit()
    calls: list[dict[str, Any]] = []

    class FakeDingTalkRobotSender:
        def __init__(self, client_id: str, client_secret: str):
            calls.append({"client_id": client_id})

        async def send_markdown_message(self, user_ids, title, text):
            calls.append({"user_ids": user_ids, "title": title, "text": text})
            return {"success": True, "result": {"processQueryKey": "query-md"}}

    monkeypatch.setattr(
        "app.services.channels.dingtalk.sender.DingTalkRobotSender",
        FakeDingTalkRobotSender,
    )

    result = await im_notification_dispatcher.send_notification(
        test_db,
        session,
        PushNotification(
            headline="hajimi 在「修复登录」提到了你",
            card_headline="🔔 hajimi 在评论中提到了你",
            facts=(("看板", "test-pro"),),
        ),
        links=[
            NotificationLink(
                label="在 Wework 中打开", url="wework://boards/12/issues/ISSUE-1"
            ),
            NotificationLink(
                label="查看任务",
                url="http://localhost:3000/collaboration/12/issues/ISSUE-1",
            ),
        ],
    )

    assert result["success"] is True
    assert calls[1] == {
        "user_ids": ["staff-1"],
        "title": "hajimi 在「修复登录」提到了你",
        "text": (
            "**hajimi 在「修复登录」提到了你**\n\n"
            "看板：test-pro\n\n"
            "[在 Wework 中打开](wework://boards/12/issues/ISSUE-1)"
            " · [查看任务](http://localhost:3000/collaboration/12/issues/ISSUE-1)"
        ),
    }


async def test_dingtalk_markdown_escapes_link_syntax_from_a_comment(
    test_db: Session,
    test_user,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A member's own words must not render as a link inside the bot's push."""

    _create_channel(
        test_db,
        channel_id=9422,
        channel_type="dingtalk",
        config={
            "client_id": "ding-client-id",
            "client_secret": encrypt_sensitive_data("ding-client-secret"),
        },
    )
    session = _create_session(
        user_id=test_user.id,
        channel_id=9422,
        channel_type="dingtalk",
        sender_id="sender-union-2",
        proactive_recipient_id="staff-2",
    )
    test_db.commit()
    calls: list[dict[str, Any]] = []

    class FakeDingTalkRobotSender:
        def __init__(self, client_id: str, client_secret: str):
            calls.append({"client_id": client_id})

        async def send_markdown_message(self, user_ids, title, text):
            calls.append({"user_ids": user_ids, "title": title, "text": text})
            return {"success": True, "result": {"processQueryKey": "query-escape"}}

    monkeypatch.setattr(
        "app.services.channels.dingtalk.sender.DingTalkRobotSender",
        FakeDingTalkRobotSender,
    )

    result = await im_notification_dispatcher.send_notification(
        test_db,
        session,
        PushNotification(
            headline="hajimi 在「修复登录」提到了你",
            card_headline="🔔 hajimi 在评论中提到了你",
            detail_label="评论内容",
            detail="[点这里](https://tracker.example/login)",
        ),
        links=[
            NotificationLink(
                label="在 Wework 中打开", url="wework://boards/12/issues/ISSUE-1"
            ),
        ],
    )

    assert result["success"] is True
    assert calls[1]["text"] == (
        "**hajimi 在「修复登录」提到了你**\n\n"
        "评论内容：\\[点这里\\](https://tracker.example/login)\n\n"
        "[在 Wework 中打开](wework://boards/12/issues/ISSUE-1)"
    )


@pytest.mark.asyncio
async def test_dingtalk_notification_card_uses_the_builtin_template(
    test_db: Session,
    test_user,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A channel that opted into cards gets a finished card instead of markdown."""

    _create_channel(
        test_db,
        channel_id=9425,
        channel_type="dingtalk",
        config={
            "client_id": "ding-client-id",
            "client_secret": encrypt_sensitive_data("ding-client-secret"),
            "notification_card": {},
        },
    )
    session = _create_session(
        user_id=test_user.id,
        channel_id=9425,
        channel_type="dingtalk",
        sender_id="sender-union-1",
        proactive_recipient_id="staff-1",
    )
    test_db.commit()
    calls: list[dict[str, Any]] = []

    class FakeDingTalkRobotSender:
        def __init__(self, client_id: str, client_secret: str):
            calls.append({"client_id": client_id})

        async def send_card(
            self,
            user_id: str,
            card_template_id: str,
            card_param_map: dict[str, str],
            preview: str = "",
        ):
            calls.append(
                {
                    "user_id": user_id,
                    "card_template_id": card_template_id,
                    "card_param_map": card_param_map,
                    "preview": preview,
                }
            )
            return {"success": True, "outTrackId": "track-1"}

        async def send_markdown_message(self, user_ids, title, text):
            raise AssertionError("a delivered card must replace the markdown push")

    monkeypatch.setattr(
        "app.services.channels.dingtalk.sender.DingTalkRobotSender",
        FakeDingTalkRobotSender,
    )

    result = await im_notification_dispatcher.send_notification(
        test_db,
        session,
        PushNotification(
            headline="hajimi 在「修复登录」提到了你",
            card_headline="🔔 hajimi 在评论中提到了你",
            facts=(("任务编号", "WORK-582"),),
        ),
        links=[
            NotificationLink(
                label="在 Wework 中打开", url="wework://boards/12/issues/ISSUE-1"
            ),
        ],
    )

    assert result["success"] is True
    assert result["outTrackId"] == "track-1"
    assert calls[1]["user_id"] == "staff-1"
    assert calls[1]["card_template_id"] == BUILTIN_NOTIFICATION_CARD_TEMPLATE_ID
    assert calls[1]["preview"] == "🔔 hajimi 在评论中提到了你"
    card_param_map = calls[1]["card_param_map"]
    assert card_param_map["title"] == "🔔 hajimi 在评论中提到了你"
    assert card_param_map["markdown"] == "**任务编号**：WORK-582"
    assert json.loads(card_param_map["sys_full_json_obj"])["msgButtons"] == [
        {
            "text": "在 Wework 中打开",
            "url": "wework://boards/12/issues/ISSUE-1",
            "color": "blue",
        }
    ]


@pytest.mark.asyncio
async def test_dingtalk_notification_card_failure_falls_back_to_markdown(
    test_db: Session,
    test_user,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A tenant that cannot deliver the card still receives the notification."""

    _create_channel(
        test_db,
        channel_id=9426,
        channel_type="dingtalk",
        config={
            "client_id": "ding-client-id",
            "client_secret": encrypt_sensitive_data("ding-client-secret"),
            "notification_card": {"template_id": "card-template-1"},
        },
    )
    session = _create_session(
        user_id=test_user.id,
        channel_id=9426,
        channel_type="dingtalk",
        sender_id="sender-union-2",
        proactive_recipient_id="staff-2",
    )
    test_db.commit()
    calls: list[dict[str, Any]] = []

    class FakeDingTalkRobotSender:
        def __init__(self, client_id: str, client_secret: str):
            pass

        async def send_card(
            self,
            user_id: str,
            card_template_id: str,
            card_param_map: dict[str, str],
            preview: str = "",
        ):
            calls.append(
                {"template_id": card_template_id, "card_param_map": card_param_map}
            )
            return {"success": False, "error": "Card.Instance.Write forbid"}

        async def send_markdown_message(self, user_ids, title, text):
            calls.append({"user_ids": user_ids, "title": title, "text": text})
            return {"success": True, "result": {"processQueryKey": "query-md"}}

    monkeypatch.setattr(
        "app.services.channels.dingtalk.sender.DingTalkRobotSender",
        FakeDingTalkRobotSender,
    )

    result = await im_notification_dispatcher.send_notification(
        test_db,
        session,
        PushNotification(
            headline="hajimi 在「修复登录」提到了你",
            card_headline="🔔 hajimi 在评论中提到了你",
            facts=(("任务编号", "WORK-582"),),
        ),
        links=[
            NotificationLink(
                label="在 Wework 中打开", url="wework://boards/12/issues/ISSUE-1"
            ),
        ],
    )

    assert result["success"] is True
    assert calls[0]["template_id"] == "card-template-1"
    assert calls[0]["card_param_map"]["kindLabel"] == "任务通知"
    assert calls[0]["card_param_map"]["secondaryUrl"] == (
        f"{settings.FRONTEND_URL.rstrip('/')}/open-wework?projectId=12&itemId=ISSUE-1"
    )
    assert "markdown" not in calls[0]["card_param_map"]
    assert calls[1] == {
        "user_ids": ["staff-2"],
        "title": "hajimi 在「修复登录」提到了你",
        "text": (
            "**hajimi 在「修复登录」提到了你**\n\n"
            "任务编号：WORK-582\n\n"
            "[在 Wework 中打开](wework://boards/12/issues/ISSUE-1)"
        ),
    }


@pytest.mark.asyncio
async def test_failed_dingtalk_runtime_notification_does_not_enable_reply(
    test_db: Session,
    test_user,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _create_channel(
        test_db,
        channel_id=9415,
        channel_type="dingtalk",
        config={
            "client_id": "ding-client-id",
            "client_secret": encrypt_sensitive_data("ding-client-secret"),
        },
    )
    session = _create_session(
        user_id=test_user.id,
        channel_id=9415,
        channel_type="dingtalk",
        sender_id="sender-union-1",
        proactive_recipient_id="staff-1",
    )
    await im_session_service.save_session(session)
    await im_session_service.enable_global_notification(test_db, session=session)
    test_db.commit()

    class FakeDingTalkRobotSender:
        def __init__(self, client_id: str, client_secret: str):
            pass

        async def send_text_message(self, user_ids: list[str], content: str):
            return {"success": False, "error": "DingTalk unavailable"}

    monkeypatch.setattr(
        "app.services.channels.dingtalk.sender.DingTalkRobotSender",
        FakeDingTalkRobotSender,
    )

    result = await im_notification_dispatcher.send_runtime_task_update(
        test_db,
        user_id=test_user.id,
        address={"deviceId": "device-1", "localTaskId": "runtime-1"},
        title="Native Codex task",
        status="updated",
        content="Update",
        source="codex_watcher",
    )

    assert result["sent"] == 0
    assert (
        await im_session_service.get_runtime_task_reply_target(
            session=session,
            message_id="query-1",
        )
        is None
    )


@pytest.mark.asyncio
async def test_runtime_task_update_suppresses_global_target_while_client_is_active(
    test_db: Session,
    test_user,
) -> None:
    session = _create_session(
        user_id=test_user.id,
        channel_id=9412,
        channel_type="telegram",
        sender_id="100200300",
    )
    await im_session_service.save_session(session)
    await im_session_service.enable_global_notification(test_db, session=session)
    await im_session_service.update_im_notification_presence(
        user_id=test_user.id,
        client_id="wework-client",
        away=False,
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
        content="Foreground update",
        source="codex_watcher",
    )

    assert result["sent"] == 0
    assert result["results"] == []


@pytest.mark.asyncio
@pytest.mark.parametrize("target_kind", ["active", "subscribed"])
async def test_runtime_task_update_master_switch_suppresses_session_targets(
    test_db: Session,
    test_user,
    fake_im_session_cache,
    monkeypatch: pytest.MonkeyPatch,
    target_kind: str,
) -> None:
    address = {
        "deviceId": "device-1",
        "localTaskId": "codex-thread-1",
    }
    session = _create_session(
        user_id=test_user.id,
        channel_id=9413,
        channel_type="dingtalk",
        sender_id="sender-union-1",
        proactive_recipient_id="staff-1",
    )
    await im_session_service.save_session(session)
    if target_kind == "active":
        await im_session_service.bind_active_runtime_task(
            test_db,
            session=session,
            runtime_task=address,
        )
    else:
        await im_session_service.subscribe_runtime_task_notification(
            test_db,
            session=session,
            runtime_task=address,
        )

    send_text = AsyncMock(return_value={"success": True})
    monkeypatch.setattr(im_notification_dispatcher, "send_text", send_text)

    result = await im_notification_dispatcher.send_runtime_task_update(
        test_db,
        user_id=test_user.id,
        address=address,
        title="Native Codex task",
        status="updated",
        content="Suppressed update",
        source="codex_watcher",
    )

    assert result == {"sent": 0, "results": []}
    send_text.assert_not_awaited()


@pytest.mark.asyncio
async def test_runtime_task_update_uses_active_session_when_master_switch_enabled(
    test_db: Session,
    test_user,
    fake_im_session_cache,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    address = {
        "deviceId": "device-1",
        "localTaskId": "codex-thread-1",
    }
    session = _create_session(
        user_id=test_user.id,
        channel_id=9413,
        channel_type="dingtalk",
        sender_id="sender-union-1",
        proactive_recipient_id="staff-1",
    )
    await im_session_service.save_session(session)
    await im_session_service.bind_active_runtime_task(
        test_db,
        session=session,
        runtime_task=address,
    )
    await im_session_service.enable_global_notification(test_db, session=session)
    await im_session_service.update_im_notification_presence(
        user_id=test_user.id,
        client_id="wework-client",
        away=False,
    )
    send_text = AsyncMock(return_value={"success": True})
    monkeypatch.setattr(im_notification_dispatcher, "send_text", send_text)

    result = await im_notification_dispatcher.send_runtime_task_update(
        test_db,
        user_id=test_user.id,
        address=address,
        title="Native Codex task",
        status="updated",
        content="Bound update",
        source="codex_watcher",
    )

    assert result["sent"] == 1
    send_text.assert_awaited_once()


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
    await im_session_service.enable_global_notification(test_db, session=session)
    await im_session_service.update_im_notification_presence(
        user_id=test_user.id,
        client_id="wework-client",
        away=False,
    )
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
