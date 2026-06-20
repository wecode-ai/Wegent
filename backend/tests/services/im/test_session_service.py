# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from app.models.im_session import IMSessionMode, IMSessionState
from app.models.user import User
from app.services.im.session_service import im_session_service


def test_get_or_create_private_session_refreshes_existing_session(
    test_db: Session,
    test_user: User,
) -> None:
    first = im_session_service.get_or_create_private_session(
        db=test_db,
        user_id=test_user.id,
        channel_type="dingtalk",
        channel_id=12,
        conversation_id="conv-1",
        sender_id="staff-a",
        display_name="Old name",
    )
    old_seen_at = first.last_seen_at

    refreshed = im_session_service.get_or_create_private_session(
        db=test_db,
        user_id=test_user.id,
        channel_type="dingtalk",
        channel_id=12,
        conversation_id="conv-1",
        sender_id="",
        display_name="",
    )

    assert refreshed.id == first.id
    assert refreshed.sender_id == ""
    assert refreshed.display_name == ""
    assert refreshed.last_seen_at >= old_seen_at


def test_pending_state_expires_and_returns_to_idle(
    test_db: Session,
    test_user: User,
) -> None:
    session = im_session_service.get_or_create_private_session(
        db=test_db,
        user_id=test_user.id,
        channel_type="telegram",
        channel_id=33,
        conversation_id="chat-9",
        sender_id="chat-9",
        display_name="Alice",
    )
    im_session_service.set_pending_state(
        db=test_db,
        session=session,
        state=IMSessionState.PENDING_TASK_SWITCH,
        payload={"task_ids": [1, 2]},
        expires_at=datetime.now() - timedelta(seconds=1),
    )

    active_payload = im_session_service.get_active_pending_payload(test_db, session)

    assert active_payload is None
    assert session.state == IMSessionState.IDLE
    assert session.pending_payload == {}


def test_bind_active_task_sets_task_mode_and_clears_pending_state(
    test_db: Session,
    test_user: User,
) -> None:
    session = im_session_service.get_or_create_private_session(
        db=test_db,
        user_id=test_user.id,
        channel_type="dingtalk",
        channel_id=12,
        conversation_id="conv-1",
        sender_id="staff-a",
        display_name="Alice",
    )
    im_session_service.set_pending_state(
        db=test_db,
        session=session,
        state=IMSessionState.PENDING_TASK_CREATION,
        payload={"first_message": "fix auth"},
    )

    im_session_service.bind_active_task(test_db, session=session, task_id=7001)

    assert session.mode == IMSessionMode.TASK
    assert session.state == IMSessionState.IDLE
    assert session.active_task_id == 7001
    assert session.pending_payload == {}
