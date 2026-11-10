# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime, timedelta

import pytest

from app.models.im_session import IMPrivateSession, IMSessionMode
from app.models.user import User
from app.services.im.session_service import im_session_service


@pytest.mark.asyncio
async def test_get_or_create_private_session_uses_stable_redis_key(
    fake_im_session_cache,
    test_user: User,
) -> None:
    first = await im_session_service.get_or_create_private_session(
        db=None,
        user_id=test_user.id,
        channel_type="telegram",
        channel_id=33,
        conversation_id="chat-9",
        sender_id="1001",
        proactive_recipient_id="staff-original",
        display_name="Alice",
    )

    refreshed = await im_session_service.get_or_create_private_session(
        db=None,
        user_id=test_user.id,
        channel_type="telegram",
        channel_id=33,
        conversation_id="chat-9",
        sender_id="1001",
        display_name="Alice New",
    )

    assert refreshed.session_key == first.session_key
    assert refreshed.display_name == "Alice New"
    assert refreshed.proactive_recipient_id == "staff-original"
    assert (
        f"channel:user_private_sessions:{test_user.id}" in fake_im_session_cache.zsets
    )
    assert (
        fake_im_session_cache.expires[f"channel:private_session:{first.session_key}"]
        is None
    )


@pytest.mark.asyncio
async def test_list_user_sessions_returns_recent_redis_sessions(
    fake_im_session_cache,
    test_user: User,
) -> None:
    older = await im_session_service.get_or_create_private_session(
        db=None,
        user_id=test_user.id,
        channel_type="telegram",
        channel_id=33,
        conversation_id="older",
        sender_id="1001",
        display_name="Older",
    )
    newer = await im_session_service.get_or_create_private_session(
        db=None,
        user_id=test_user.id,
        channel_type="discord",
        channel_id=44,
        conversation_id="newer",
        sender_id="2001",
        display_name="Newer",
    )
    older.last_seen_at = datetime.now() - timedelta(minutes=5)
    await im_session_service.save_session(older)

    sessions = await im_session_service.list_user_sessions(
        db=None, user_id=test_user.id
    )

    assert [session.session_key for session in sessions] == [
        newer.session_key,
        older.session_key,
    ]


@pytest.mark.asyncio
async def test_im_notification_presence_aggregates_clients_and_expires(
    fake_im_session_cache,
    test_user: User,
) -> None:
    assert await im_session_service.is_user_away_for_im_notifications(test_user.id)

    away = await im_session_service.update_im_notification_presence(
        user_id=test_user.id,
        client_id="client-a",
        away=True,
    )
    assert away is True

    away = await im_session_service.update_im_notification_presence(
        user_id=test_user.id,
        client_id="client-b",
        away=False,
    )
    assert away is False

    away = await im_session_service.update_im_notification_presence(
        user_id=test_user.id,
        client_id="client-b",
        away=True,
    )
    assert away is True

    key = f"channel:user_im_notification_presence:{test_user.id}"
    fake_im_session_cache.zsets[key] = {"client-a\0active": 0}
    assert await im_session_service.is_user_away_for_im_notifications(test_user.id)


async def test_loading_legacy_session_drops_task_bindings_and_preserves_address(
    fake_im_session_cache,
):
    old = {
        "session_key": "legacy",
        "user_id": 7,
        "channel_type": "telegram",
        "channel_id": 1,
        "conversation_id": "chat",
        "sender_id": "sender",
        "mode": "task",
        "state": "pending_task_switch",
        "active_task_id": 42,
        "active_runtime_task": {"deviceId": "old", "localTaskId": "old-task"},
        "pending_payload": {"choices": [42]},
        "state_expires_at": "2020-01-01T00:00:00",
    }
    old.update(
        {
            key: datetime.now().isoformat()
            for key in ("last_seen_at", "created_at", "updated_at")
        }
    )
    await fake_im_session_cache.set("channel:private_session:legacy", old)
    session = await im_session_service.get_session("legacy")
    assert session is not None
    assert session.conversation_id == "chat"
    assert await im_session_service.get_mode(session) == IMSessionMode.STAND_IN
    assert not hasattr(session, "active_task_id")
    assert not hasattr(session, "active_runtime_task")
    await im_session_service.save_session(session)
    saved = fake_im_session_cache.values["channel:private_session:legacy"]
    assert "active_task_id" not in saved
    assert "mode" not in saved
    assert "pending_payload" not in saved


async def test_address_refresh_cannot_overwrite_a_concurrent_mode_change(
    fake_im_session_cache,
):
    session = IMPrivateSession("mode-race", 7, "telegram", 1, "chat", "sender")
    await im_session_service.save_session(session)
    stale = await im_session_service.get_session(session.session_key)
    await im_session_service.set_mode(session, IMSessionMode.STAND_IN)
    await im_session_service.save_session(stale)
    assert await im_session_service.get_mode(stale) == IMSessionMode.STAND_IN
    await im_session_service.set_mode(session, IMSessionMode.CHAT)
    await im_session_service.save_session(stale)
    assert await im_session_service.get_mode(stale) == IMSessionMode.CHAT


async def test_legacy_task_read_cannot_reactivate_stand_in_after_chat_choice(
    fake_im_session_cache,
):
    session = IMPrivateSession("legacy-mode", 7, "telegram", 1, "chat", "sender")
    data = session.to_dict()
    data["mode"] = "task"
    await fake_im_session_cache.set("channel:private_session:legacy-mode", data)
    await im_session_service.get_session("legacy-mode")
    assert await im_session_service.get_mode(session) == IMSessionMode.STAND_IN
    await im_session_service.set_mode(session, IMSessionMode.CHAT)
    await im_session_service.get_session("legacy-mode")
    assert await im_session_service.get_mode(session) == IMSessionMode.CHAT
