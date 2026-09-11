# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from typing import Any
from unittest.mock import AsyncMock

import pytest
from sqlalchemy.orm import Session

from app.models.im_session import IMPrivateSession
from app.models.kind import Kind
from app.services.im.notification_dispatcher import (
    RUNTIME_IM_NOTIFICATION_CONTENT_DEDUP_TTL_SECONDS,
    im_notification_dispatcher,
)
from app.services.im.session_service import im_session_service
from app.services.subscription.notification_service import (
    subscription_notification_service,
)
from shared.utils.crypto import encrypt_sensitive_data


@pytest.fixture(autouse=True)
def isolate_im_session_cache(
    fake_im_session_cache: Any,
    fake_notification_cache: Any,
) -> Any:
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
        "任务「Native Codex task」有新的 AI 回复：\n\n" "Implemented from native Codex"
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
            "任务「Native Codex task」有新的 AI 回复：\n\n"
            "Implemented from native Codex\n\n"
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
async def test_runtime_task_update_without_target_sessions_skips_dedup_claim(
    test_db: Session,
    test_user,
    fake_im_session_cache,
    fake_notification_cache,
) -> None:
    result = await im_notification_dispatcher.send_runtime_task_update(
        test_db,
        user_id=test_user.id,
        address={
            "deviceId": "device-1",
            "localTaskId": "codex-thread-1",
        },
        title="Native Codex task",
        status="updated",
        content="Unwatched update",
        source="codex_watcher",
        turn_key="turn-1",
    )

    assert result == {"sent": 0, "results": []}
    assert fake_notification_cache.values == {}


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
async def test_runtime_task_update_deduplicates_same_terminal_turn(
    test_db: Session,
    test_user,
    fake_im_session_cache,
    fake_notification_cache,
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
    send_text = AsyncMock(return_value={"success": True})
    monkeypatch.setattr(im_notification_dispatcher, "send_text", send_text)

    first = await im_notification_dispatcher.send_runtime_task_update(
        test_db,
        user_id=test_user.id,
        address=address,
        title="Native Codex task",
        status="updated",
        content="Same terminal reply",
        source="codex_watcher",
        turn_key="turn-1",
    )
    duplicate = await im_notification_dispatcher.send_runtime_task_update(
        test_db,
        user_id=test_user.id,
        address=address,
        title="Native Codex task",
        status="updated",
        content="Same terminal reply",
        source="codex_watcher",
        turn_key="turn-1",
    )

    assert first["sent"] == 1
    assert duplicate == {
        "sent": 0,
        "results": [],
        "skipped": "duplicate_turn",
    }
    send_text.assert_awaited_once()


@pytest.mark.asyncio
async def test_runtime_task_update_releases_claim_when_delivery_fails(
    test_db: Session,
    test_user,
    fake_im_session_cache,
    fake_notification_cache,
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
    send_text = AsyncMock(return_value={"success": False, "error": "unavailable"})
    monkeypatch.setattr(im_notification_dispatcher, "send_text", send_text)

    result = await im_notification_dispatcher.send_runtime_task_update(
        test_db,
        user_id=test_user.id,
        address=address,
        title="Native Codex task",
        status="updated",
        content="Same terminal reply",
        source="codex_watcher",
        turn_key="turn-1",
    )

    assert result["sent"] == 0
    assert fake_notification_cache.values == {}

    send_text.return_value = {"success": True}
    retried = await im_notification_dispatcher.send_runtime_task_update(
        test_db,
        user_id=test_user.id,
        address=address,
        title="Native Codex task",
        status="updated",
        content="Same terminal reply",
        source="codex_watcher",
        turn_key="turn-1",
    )

    assert retried["sent"] == 1


@pytest.mark.asyncio
async def test_runtime_task_update_keeps_claim_when_reply_target_fails(
    test_db: Session,
    test_user,
    fake_im_session_cache,
    fake_notification_cache,
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
    send_text = AsyncMock(
        return_value={"success": True, "result": {"processQueryKey": "query-1"}}
    )
    monkeypatch.setattr(im_notification_dispatcher, "send_text", send_text)
    monkeypatch.setattr(
        im_session_service,
        "save_runtime_task_reply_target",
        AsyncMock(side_effect=RuntimeError("reply target unavailable")),
    )

    delivered = await im_notification_dispatcher.send_runtime_task_update(
        test_db,
        user_id=test_user.id,
        address=address,
        title="Native Codex task",
        status="updated",
        content="Same terminal reply",
        source="codex_watcher",
        turn_key="turn-1",
    )

    assert delivered["sent"] == 1
    assert fake_notification_cache.values != {}

    duplicate = await im_notification_dispatcher.send_runtime_task_update(
        test_db,
        user_id=test_user.id,
        address=address,
        title="Native Codex task",
        status="updated",
        content="Same terminal reply",
        source="codex_watcher",
        turn_key="turn-1",
    )

    assert duplicate["skipped"] == "duplicate_turn"
    send_text.assert_awaited_once()


@pytest.mark.asyncio
async def test_runtime_task_update_without_turn_key_uses_short_claim_ttl(
    test_db: Session,
    test_user,
    fake_im_session_cache,
    fake_notification_cache,
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
    send_text = AsyncMock(return_value={"success": True})
    monkeypatch.setattr(im_notification_dispatcher, "send_text", send_text)

    result = await im_notification_dispatcher.send_runtime_task_update(
        test_db,
        user_id=test_user.id,
        address=address,
        title="Native Codex task",
        status="updated",
        content="Same terminal reply",
        source="codex_watcher",
    )

    assert result["sent"] == 1
    assert list(fake_notification_cache.expires.values()) == [
        RUNTIME_IM_NOTIFICATION_CONTENT_DEDUP_TTL_SECONDS
    ]


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
