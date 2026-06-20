# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime, timedelta

import pytest

from app.models.im_session import IMSessionMode, IMSessionState
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
