# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Provider-neutral private IM session state management."""

from datetime import datetime, timedelta
from typing import Any

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.im_session import IMPrivateSession, IMSessionMode, IMSessionState

PENDING_STATE_TTL_MINUTES = 15

CHANNEL_LABELS = {
    "dingtalk": "钉钉",
    "telegram": "Telegram",
    "discord": "Discord",
}


class IMSessionService:
    """Read and mutate private IM session state."""

    def get_channel_label(self, channel_type: str) -> str:
        return CHANNEL_LABELS.get(channel_type, channel_type)

    def get_or_create_private_session(
        self,
        db: Session,
        *,
        user_id: int,
        channel_type: str,
        channel_id: int,
        conversation_id: str,
        sender_id: str,
        display_name: str = "",
    ) -> IMPrivateSession:
        now = datetime.now()
        session = self._find_private_session(
            db,
            user_id=user_id,
            channel_type=channel_type,
            channel_id=channel_id,
            conversation_id=conversation_id,
        )
        if session is None:
            session = IMPrivateSession(
                user_id=user_id,
                channel_type=channel_type,
                channel_id=channel_id,
                conversation_id=conversation_id,
                sender_id=sender_id,
                display_name=display_name,
                last_seen_at=now,
            )
            db.add(session)
            try:
                db.commit()
            except IntegrityError:
                db.rollback()
                session = self._find_private_session(
                    db,
                    user_id=user_id,
                    channel_type=channel_type,
                    channel_id=channel_id,
                    conversation_id=conversation_id,
                )
                if session is None:
                    raise
                self._mark_private_session_seen(
                    session,
                    sender_id=sender_id,
                    display_name=display_name,
                    last_seen_at=now,
                )
                db.commit()
        else:
            self._mark_private_session_seen(
                session,
                sender_id=sender_id,
                display_name=display_name,
                last_seen_at=now,
            )
            db.commit()
        db.refresh(session)
        return session

    def _find_private_session(
        self,
        db: Session,
        *,
        user_id: int,
        channel_type: str,
        channel_id: int,
        conversation_id: str,
    ) -> IMPrivateSession | None:
        return (
            db.query(IMPrivateSession)
            .filter(
                IMPrivateSession.user_id == user_id,
                IMPrivateSession.channel_type == channel_type,
                IMPrivateSession.channel_id == channel_id,
                IMPrivateSession.conversation_id == conversation_id,
            )
            .first()
        )

    def _mark_private_session_seen(
        self,
        session: IMPrivateSession,
        *,
        sender_id: str,
        display_name: str,
        last_seen_at: datetime,
    ) -> None:
        session.sender_id = sender_id
        session.display_name = display_name
        session.last_seen_at = last_seen_at

    def list_user_sessions(self, db: Session, *, user_id: int) -> list[IMPrivateSession]:
        return (
            db.query(IMPrivateSession)
            .filter(IMPrivateSession.user_id == user_id)
            .order_by(IMPrivateSession.last_seen_at.desc(), IMPrivateSession.id.desc())
            .all()
        )

    def set_mode(self, db: Session, *, session: IMPrivateSession, mode: str) -> None:
        session.mode = mode
        session.state = IMSessionState.IDLE
        session.pending_payload = {}
        session.state_expires_at = None
        if mode == IMSessionMode.CHAT:
            session.active_task_id = None
        db.commit()
        db.refresh(session)

    def bind_active_task(
        self,
        db: Session,
        *,
        session: IMPrivateSession,
        task_id: int,
    ) -> None:
        session.mode = IMSessionMode.TASK
        session.state = IMSessionState.IDLE
        session.active_task_id = task_id
        session.pending_payload = {}
        session.state_expires_at = None
        db.commit()
        db.refresh(session)

    def clear_active_task(self, db: Session, *, session: IMPrivateSession) -> None:
        session.active_task_id = None
        session.state = IMSessionState.IDLE
        session.pending_payload = {}
        session.state_expires_at = None
        db.commit()
        db.refresh(session)

    def set_pending_state(
        self,
        db: Session,
        *,
        session: IMPrivateSession,
        state: str,
        payload: dict[str, Any],
        expires_at: datetime | None = None,
        force_task_mode: bool = True,
    ) -> None:
        if force_task_mode:
            session.mode = IMSessionMode.TASK
        session.state = state
        session.pending_payload = payload
        session.state_expires_at = expires_at or (
            datetime.now() + timedelta(minutes=PENDING_STATE_TTL_MINUTES)
        )
        db.commit()
        db.refresh(session)

    def cancel_pending(self, db: Session, *, session: IMPrivateSession) -> None:
        session.state = IMSessionState.IDLE
        session.pending_payload = {}
        session.state_expires_at = None
        db.commit()
        db.refresh(session)

    def get_active_pending_payload(
        self,
        db: Session,
        session: IMPrivateSession,
    ) -> dict[str, Any] | None:
        if session.state == IMSessionState.IDLE:
            return None
        if session.state_expires_at and session.state_expires_at < datetime.now():
            self.cancel_pending(db, session=session)
            return None
        payload = session.pending_payload
        return payload if isinstance(payload, dict) else {}


im_session_service = IMSessionService()
