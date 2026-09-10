# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
from datetime import datetime, timedelta

import pytest

from app.models.im_session import IMPrivateSession, IMSessionMode, IMSessionState
from app.models.user import User
from app.services.im.session_service import (
    RUNTIME_NOTIFICATION_REPLY_TARGET_TTL_SECONDS,
    im_session_service,
)


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
    assert refreshed.mode == IMSessionMode.CHAT
    assert refreshed.state == IMSessionState.IDLE
    assert refreshed.active_task_id is None
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
async def test_pending_state_expires_and_returns_to_idle(
    fake_im_session_cache,
    test_user: User,
) -> None:
    session = await im_session_service.get_or_create_private_session(
        db=None,
        user_id=test_user.id,
        channel_type="telegram",
        channel_id=33,
        conversation_id="chat-9",
        sender_id="1001",
        display_name="Alice",
    )
    await im_session_service.set_pending_state(
        db=None,
        session=session,
        state=IMSessionState.PENDING_TASK_SWITCH,
        payload={"task_ids": [1, 2]},
        expires_at=datetime.now() - timedelta(seconds=1),
    )

    active_payload = await im_session_service.get_active_pending_payload(None, session)

    assert active_payload is None
    assert session.state == IMSessionState.IDLE
    assert session.pending_payload == {}


@pytest.mark.asyncio
async def test_bind_active_task_sets_task_mode_and_clears_pending_state(
    fake_im_session_cache,
    test_user: User,
) -> None:
    session = await im_session_service.get_or_create_private_session(
        db=None,
        user_id=test_user.id,
        channel_type="dingtalk",
        channel_id=12,
        conversation_id="conv-1",
        sender_id="staff-a",
        display_name="Alice",
    )
    await im_session_service.set_pending_state(
        db=None,
        session=session,
        state=IMSessionState.PENDING_TASK_CREATION,
        payload={"first_message": "fix auth"},
    )

    await im_session_service.bind_active_task(None, session=session, task_id=7001)

    assert session.mode == IMSessionMode.TASK
    assert session.state == IMSessionState.IDLE
    assert session.active_task_id == 7001
    assert session.pending_payload == {}


@pytest.mark.asyncio
async def test_runtime_notification_reply_target_is_latest_and_consumed_once(
    fake_im_session_cache,
    test_user: User,
) -> None:
    session = await im_session_service.get_or_create_private_session(
        db=None,
        user_id=test_user.id,
        channel_type="dingtalk",
        channel_id=12,
        conversation_id="conv-1",
        sender_id="staff-a",
        display_name="Alice",
    )
    first_target = {
        "deviceId": "device-1",
        "localTaskId": "runtime-1",
    }
    latest_target = {
        "deviceId": "device-2",
        "localTaskId": "runtime-2",
    }

    assert await im_session_service.save_runtime_notification_reply_target(
        session=session,
        runtime_task=first_target,
    )
    assert await im_session_service.save_runtime_notification_reply_target(
        session=session,
        runtime_task=latest_target,
    )

    cache_key = f"channel:runtime_notification_reply_target:{session.session_key}"
    assert fake_im_session_cache.expires[cache_key] == (
        RUNTIME_NOTIFICATION_REPLY_TARGET_TTL_SECONDS
    )
    assert (
        await im_session_service.pop_runtime_notification_reply_target(session=session)
        == latest_target
    )
    assert (
        await im_session_service.pop_runtime_notification_reply_target(session=session)
        is None
    )


@pytest.mark.asyncio
async def test_runtime_notification_reply_target_rejects_invalid_cached_address(
    fake_im_session_cache,
    test_user: User,
) -> None:
    session = await im_session_service.get_or_create_private_session(
        db=None,
        user_id=test_user.id,
        channel_type="dingtalk",
        channel_id=12,
        conversation_id="conv-1",
        sender_id="staff-a",
        display_name="Alice",
    )
    cache_key = f"channel:runtime_notification_reply_target:{session.session_key}"
    fake_im_session_cache.values[cache_key] = {"deviceId": "device-1"}

    assert (
        await im_session_service.pop_runtime_notification_reply_target(session=session)
        is None
    )
    assert cache_key not in fake_im_session_cache.values


@pytest.mark.asyncio
async def test_runtime_notification_target_binding_refreshes_concurrent_sessions(
    fake_im_session_cache,
    test_user: User,
) -> None:
    session = await im_session_service.get_or_create_private_session(
        db=None,
        user_id=test_user.id,
        channel_type="dingtalk",
        channel_id=12,
        conversation_id="conv-1",
        sender_id="staff-a",
        display_name="Alice",
    )
    await im_session_service.bind_active_runtime_task(
        None,
        session=session,
        runtime_task={"deviceId": "device-old", "localTaskId": "runtime-old"},
    )
    notification_target = {
        "deviceId": "device-new",
        "localTaskId": "runtime-new",
    }
    await im_session_service.save_runtime_notification_reply_target(
        session=session,
        runtime_task=notification_target,
    )
    first_session = IMPrivateSession.from_dict(session.to_dict())
    second_session = IMPrivateSession.from_dict(session.to_dict())

    results = await asyncio.gather(
        im_session_service.consume_and_bind_runtime_notification_reply_target(
            session=first_session
        ),
        im_session_service.consume_and_bind_runtime_notification_reply_target(
            session=second_session
        ),
    )

    assert sum(result is not None for result in results) == 1
    assert first_session.active_runtime_task == notification_target
    assert second_session.active_runtime_task == notification_target
    assert first_session.mode == IMSessionMode.TASK
    assert second_session.mode == IMSessionMode.TASK


@pytest.mark.asyncio
async def test_runtime_notification_target_binding_failure_keeps_target_for_retry(
    fake_im_session_cache,
    test_user: User,
) -> None:
    session = await im_session_service.get_or_create_private_session(
        db=None,
        user_id=test_user.id,
        channel_type="dingtalk",
        channel_id=12,
        conversation_id="conv-1",
        sender_id="staff-a",
        display_name="Alice",
    )
    notification_target = {
        "deviceId": "device-new",
        "localTaskId": "runtime-new",
    }
    await im_session_service.save_runtime_notification_reply_target(
        session=session,
        runtime_task=notification_target,
    )
    fake_im_session_cache.fail_runtime_notification_transition = True

    with pytest.raises(
        RuntimeError,
        match="Simulated runtime notification persistence failure",
    ):
        await im_session_service.consume_and_bind_runtime_notification_reply_target(
            session=session
        )

    cache_key = f"channel:runtime_notification_reply_target:{session.session_key}"
    assert fake_im_session_cache.values[cache_key] == notification_target
    assert session.active_runtime_task is None

    fake_im_session_cache.fail_runtime_notification_transition = False
    consumed_target = (
        await im_session_service.consume_and_bind_runtime_notification_reply_target(
            session=session
        )
    )

    assert consumed_target == notification_target
    assert session.active_runtime_task == notification_target
    assert cache_key not in fake_im_session_cache.values


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
