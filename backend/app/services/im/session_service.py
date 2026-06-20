# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Provider-neutral private IM session state management."""

import hashlib
import logging
from datetime import datetime, timedelta
from typing import Any, Sequence

from sqlalchemy.orm import Session

from app.core.cache import cache_manager
from app.models.im_session import IMPrivateSession, IMSessionMode, IMSessionState

logger = logging.getLogger(__name__)

PENDING_STATE_TTL_MINUTES = 15
PRIVATE_SESSION_KEY_PREFIX = "channel:private_session:"
USER_PRIVATE_SESSIONS_PREFIX = "channel:user_private_sessions:"

CHANNEL_LABELS = {
    "dingtalk": "钉钉",
    "telegram": "Telegram",
    "discord": "Discord",
}


class IMSessionService:
    """Read and mutate private IM session state stored in Redis."""

    def get_channel_label(self, channel_type: str) -> str:
        return CHANNEL_LABELS.get(channel_type, channel_type)

    def build_session_key(
        self,
        *,
        user_id: int,
        channel_type: str,
        channel_id: int,
        conversation_id: str,
    ) -> str:
        identity = f"{channel_type}\0{channel_id}\0{conversation_id}\0{user_id}"
        return hashlib.sha256(identity.encode("utf-8")).hexdigest()

    async def get_or_create_private_session(
        self,
        db: Session | None,
        *,
        user_id: int,
        channel_type: str,
        channel_id: int,
        conversation_id: str,
        sender_id: str,
        display_name: str = "",
    ) -> IMPrivateSession:
        now = datetime.now()
        session_key = self.build_session_key(
            user_id=user_id,
            channel_type=channel_type,
            channel_id=channel_id,
            conversation_id=conversation_id,
        )
        session = await self.get_session(session_key)
        if session is None:
            session = IMPrivateSession(
                session_key=session_key,
                user_id=user_id,
                channel_type=channel_type,
                channel_id=channel_id,
                conversation_id=conversation_id,
                sender_id=sender_id,
                display_name=display_name,
                last_seen_at=now,
                created_at=now,
                updated_at=now,
            )
        else:
            session.sender_id = sender_id
            session.display_name = display_name
            session.last_seen_at = now
            session.updated_at = now

        await self.save_session(session)
        return session

    async def get_session(self, session_key: str) -> IMPrivateSession | None:
        data = await cache_manager.get(self._session_cache_key(session_key))
        if not isinstance(data, dict):
            return None
        try:
            return IMPrivateSession.from_dict(data)
        except Exception:
            logger.warning(
                "[IMSessionService] Failed to parse private IM session: key=%s",
                session_key,
                exc_info=True,
            )
            return None

    async def save_session(self, session: IMPrivateSession) -> None:
        session.updated_at = datetime.now()
        await cache_manager.set(
            self._session_cache_key(session.session_key),
            session.to_dict(),
            expire=None,
        )
        await self._add_user_session(session)

    async def list_user_sessions(
        self, db: Session | None, *, user_id: int
    ) -> list[IMPrivateSession]:
        session_keys = await self._list_user_session_keys(user_id)
        sessions: list[IMPrivateSession] = []
        missing_keys: list[str] = []
        for session_key in session_keys:
            session = await self.get_session(session_key)
            if session is None:
                missing_keys.append(session_key)
                continue
            sessions.append(session)
        if missing_keys:
            await self._remove_user_sessions(user_id, missing_keys)
        return sessions

    async def load_user_sessions_by_keys(
        self,
        db: Session | None,
        *,
        user_id: int,
        session_keys: Sequence[str],
    ) -> list[IMPrivateSession]:
        ordered_keys = [str(session_key) for session_key in session_keys]
        if not ordered_keys:
            return []

        sessions_by_key: dict[str, IMPrivateSession] = {}
        missing_keys: list[str] = []
        for session_key in dict.fromkeys(ordered_keys):
            session = await self.get_session(session_key)
            if session is None or session.user_id != user_id:
                missing_keys.append(session_key)
                continue
            sessions_by_key[session_key] = session

        if missing_keys:
            from fastapi import HTTPException, status

            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="IM private session not found",
            )
        return [sessions_by_key[session_key] for session_key in ordered_keys]

    async def set_mode(
        self, db: Session | None, *, session: IMPrivateSession, mode: str
    ) -> None:
        session.mode = mode
        session.state = IMSessionState.IDLE
        session.pending_payload = {}
        session.state_expires_at = None
        if mode == IMSessionMode.CHAT:
            session.active_task_id = None
        await self.save_session(session)

    async def bind_active_task(
        self,
        db: Session | None,
        *,
        session: IMPrivateSession,
        task_id: int,
    ) -> None:
        session.mode = IMSessionMode.TASK
        session.state = IMSessionState.IDLE
        session.active_task_id = task_id
        session.pending_payload = {}
        session.state_expires_at = None
        await self.save_session(session)

    async def clear_active_task(
        self, db: Session | None, *, session: IMPrivateSession
    ) -> None:
        session.active_task_id = None
        session.state = IMSessionState.IDLE
        session.pending_payload = {}
        session.state_expires_at = None
        await self.save_session(session)

    async def set_pending_state(
        self,
        db: Session | None,
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
        await self.save_session(session)

    async def cancel_pending(
        self, db: Session | None, *, session: IMPrivateSession
    ) -> None:
        session.state = IMSessionState.IDLE
        session.pending_payload = {}
        session.state_expires_at = None
        await self.save_session(session)

    async def get_active_pending_payload(
        self,
        db: Session | None,
        session: IMPrivateSession,
    ) -> dict[str, Any] | None:
        if session.state == IMSessionState.IDLE:
            return None
        if session.state_expires_at and session.state_expires_at < datetime.now():
            await self.cancel_pending(db, session=session)
            return None
        payload = session.pending_payload
        return payload if isinstance(payload, dict) else {}

    def _session_cache_key(self, session_key: str) -> str:
        return f"{PRIVATE_SESSION_KEY_PREFIX}{session_key}"

    def _user_sessions_key(self, user_id: int) -> str:
        return f"{USER_PRIVATE_SESSIONS_PREFIX}{user_id}"

    async def _add_user_session(self, session: IMPrivateSession) -> None:
        client = await cache_manager._get_client()
        try:
            await client.zadd(
                self._user_sessions_key(session.user_id),
                {session.session_key: session.last_seen_at.timestamp()},
            )
        finally:
            await client.aclose()

    async def _list_user_session_keys(self, user_id: int) -> list[str]:
        client = await cache_manager._get_client()
        try:
            members = await client.zrevrange(self._user_sessions_key(user_id), 0, -1)
        finally:
            await client.aclose()
        return [_decode_member(member) for member in members]

    async def _remove_user_sessions(
        self, user_id: int, session_keys: Sequence[str]
    ) -> None:
        if not session_keys:
            return
        client = await cache_manager._get_client()
        try:
            await client.zrem(self._user_sessions_key(user_id), *session_keys)
        finally:
            await client.aclose()


def _decode_member(member: Any) -> str:
    if isinstance(member, bytes):
        return member.decode("utf-8")
    return str(member)


im_session_service = IMSessionService()
