# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime, timedelta

import pytest
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.im_session import IMPrivateSession, IMSessionMode, IMSessionState
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


def test_get_or_create_private_session_recovers_from_create_conflict(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    existing = IMPrivateSession(
        user_id=test_user.id,
        channel_type="dingtalk",
        channel_id=12,
        conversation_id="conv-conflict",
        sender_id="staff-old",
        display_name="Old name",
        last_seen_at=datetime.now() - timedelta(minutes=1),
    )
    test_db.add(existing)
    test_db.commit()
    test_db.refresh(existing)
    old_seen_at = existing.last_seen_at

    real_query = test_db.query
    query_calls = 0

    class InitialMissQuery:
        def filter(self, *args):
            return self

        def first(self):
            return None

    def query_with_initial_miss(*args, **kwargs):
        nonlocal query_calls
        if args and args[0] is IMPrivateSession and query_calls == 0:
            query_calls += 1
            return InitialMissQuery()
        return real_query(*args, **kwargs)

    real_commit = test_db.commit
    commit_calls = 0

    def commit_with_conflict_once() -> None:
        nonlocal commit_calls
        commit_calls += 1
        if commit_calls == 1:
            raise IntegrityError(
                "insert conflict",
                params=None,
                orig=Exception("duplicate private session identity"),
            )
        real_commit()

    monkeypatch.setattr(test_db, "query", query_with_initial_miss)
    monkeypatch.setattr(test_db, "commit", commit_with_conflict_once)

    recovered = im_session_service.get_or_create_private_session(
        db=test_db,
        user_id=test_user.id,
        channel_type="dingtalk",
        channel_id=12,
        conversation_id="conv-conflict",
        sender_id="staff-new",
        display_name="New name",
    )

    assert recovered.id == existing.id
    assert recovered.sender_id == "staff-new"
    assert recovered.display_name == "New name"
    assert recovered.last_seen_at >= old_seen_at
    assert commit_calls == 2


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
