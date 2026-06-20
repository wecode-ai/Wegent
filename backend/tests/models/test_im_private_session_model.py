# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime

import pytest
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.im_session import (
    IMPrivateSession,
    IMSessionMode,
    IMSessionState,
)
from app.models.user import User


def test_im_private_session_defaults(test_db: Session, test_user: User) -> None:
    session = IMPrivateSession(
        user_id=test_user.id,
        channel_type="dingtalk",
        channel_id=101,
        conversation_id="conv-1",
        sender_id="staff-1",
        display_name="Alice",
    )

    test_db.add(session)
    test_db.commit()
    test_db.refresh(session)

    assert session.id is not None
    assert session.mode == IMSessionMode.CHAT
    assert session.state == IMSessionState.IDLE
    assert session.active_task_id is None
    assert session.pending_payload == {}
    assert isinstance(session.created_at, datetime)
    assert isinstance(session.updated_at, datetime)
    assert isinstance(session.last_seen_at, datetime)


def test_im_private_session_identity_is_unique(
    test_db: Session,
    test_user: User,
) -> None:
    first = IMPrivateSession(
        user_id=test_user.id,
        channel_type="dingtalk",
        channel_id=101,
        conversation_id="conv-1",
        sender_id="staff-1",
    )
    second = IMPrivateSession(
        user_id=test_user.id,
        channel_type="dingtalk",
        channel_id=101,
        conversation_id="conv-1",
        sender_id="staff-1",
    )

    test_db.add_all([first, second])

    with pytest.raises(IntegrityError):
        test_db.commit()
