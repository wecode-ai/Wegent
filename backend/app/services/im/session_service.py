# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Provider-neutral private IM session state management."""

import hashlib
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Sequence

from sqlalchemy.orm import Session

from app.core.cache import cache_manager
from app.models.im_session import IMPrivateSession, IMSessionMode, IMSessionState

logger = logging.getLogger(__name__)

PENDING_STATE_TTL_MINUTES = 15
PRIVATE_SESSION_KEY_PREFIX = "channel:private_session:"
USER_PRIVATE_SESSIONS_PREFIX = "channel:user_private_sessions:"
USER_GLOBAL_NOTIFICATION_PREFIX = "channel:user_global_notification:"
USER_RUNTIME_TASK_SUBSCRIPTIONS_PREFIX = "channel:user_runtime_task_subscriptions:"
RUNTIME_TASK_REPLY_TARGET_PREFIX = "channel:runtime_task_reply_target:"
RUNTIME_TASK_REPLY_TARGET_TTL_SECONDS = 7 * 24 * 60 * 60

CHANNEL_LABELS = {
    "dingtalk": "钉钉",
    "telegram": "Telegram",
    "discord": "Discord",
    "weibo": "微博",
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

    async def get_session_bot_purpose(
        self,
        db: Session | None,
        session: IMPrivateSession,
    ) -> str:
        """Resolve the bot purpose for a private IM session's channel."""
        if db is None:
            return "wegent_chat"

        from app.models.kind import Kind

        channel = (
            db.query(Kind)
            .filter(
                Kind.id == session.channel_id,
                Kind.kind == "Messager",
                Kind.user_id == 0,
                Kind.is_active == True,
            )
            .first()
        )
        if channel is None or not isinstance(channel.json, dict):
            return "wegent_chat"
        spec = channel.json.get("spec", {})
        if not isinstance(spec, dict):
            return "wegent_chat"
        purpose = spec.get("botPurpose") or "wegent_chat"
        return str(purpose)

    async def get_global_notification_settings(
        self, user_id: int
    ) -> "IMGlobalNotificationSettings":
        data = await cache_manager.get(self._global_notification_key(user_id))
        if not isinstance(data, dict):
            return IMGlobalNotificationSettings()
        session_key = data.get("session_key")
        return IMGlobalNotificationSettings(
            enabled=bool(data.get("enabled")),
            session_key=session_key if isinstance(session_key, str) else None,
        )

    async def enable_global_notification(
        self,
        db: Session | None,
        *,
        session: IMPrivateSession,
    ) -> "IMGlobalNotificationSettings":
        settings = IMGlobalNotificationSettings(
            enabled=True,
            session_key=session.session_key,
        )
        await self._save_global_notification_settings(session.user_id, settings)
        await self._add_user_session(session)
        return settings

    async def disable_global_notification(
        self,
        user_id: int,
    ) -> "IMGlobalNotificationSettings":
        current = await self.get_global_notification_settings(user_id)
        settings = IMGlobalNotificationSettings(
            enabled=False,
            session_key=current.session_key,
        )
        await self._save_global_notification_settings(user_id, settings)
        return settings

    async def update_global_notification(
        self,
        db: Session | None,
        *,
        user_id: int,
        enabled: bool,
        session_key: str | None = None,
    ) -> "IMGlobalNotificationSettings":
        current = await self.get_global_notification_settings(user_id)
        next_session_key = (
            session_key if session_key is not None else current.session_key
        )
        if enabled and not next_session_key:
            from fastapi import HTTPException, status

            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="IM notification session is required",
            )
        if next_session_key:
            session = await self.get_session(next_session_key)
            if session is None or session.user_id != user_id:
                from fastapi import HTTPException, status

                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="IM private session not found",
                )
            await self._add_user_session(session)

        settings = IMGlobalNotificationSettings(
            enabled=enabled,
            session_key=next_session_key,
        )
        await self._save_global_notification_settings(user_id, settings)
        return settings

    async def subscribe_runtime_task_notification(
        self,
        db: Session | None,
        *,
        session: IMPrivateSession,
        runtime_task: dict[str, Any],
    ) -> None:
        task_key = self.runtime_task_notification_key(runtime_task)
        subscriptions = await self._get_runtime_task_subscriptions(session.user_id)
        session_keys = set(subscriptions.get(task_key, []))
        session_keys.add(session.session_key)
        subscriptions[task_key] = sorted(session_keys)
        await self._save_runtime_task_subscriptions(session.user_id, subscriptions)
        await self._add_user_session(session)

    async def list_runtime_task_notification_sessions(
        self,
        db: Session | None,
        *,
        user_id: int,
        runtime_task: dict[str, Any],
    ) -> list[IMPrivateSession]:
        task_key = self.runtime_task_notification_key(runtime_task)
        subscriptions = await self._get_runtime_task_subscriptions(user_id)
        session_keys = subscriptions.get(task_key, [])
        if not isinstance(session_keys, list):
            return []

        sessions: list[IMPrivateSession] = []
        for session_key in session_keys:
            if not isinstance(session_key, str):
                continue
            session = await self.get_session(session_key)
            if session is not None and session.user_id == user_id:
                sessions.append(session)
        return sessions

    async def list_runtime_task_notification_subscriptions(
        self,
        *,
        user_id: int,
    ) -> dict[str, list[str]]:
        return await self._get_runtime_task_subscriptions(user_id)

    async def unsubscribe_runtime_task_notification(
        self,
        *,
        user_id: int,
        runtime_task: dict[str, Any],
    ) -> None:
        task_key = self.runtime_task_notification_key(runtime_task)
        subscriptions = await self._get_runtime_task_subscriptions(user_id)
        subscriptions.pop(task_key, None)
        await self._save_runtime_task_subscriptions(user_id, subscriptions)

    async def save_runtime_task_reply_target(
        self,
        *,
        session: IMPrivateSession,
        message_id: int | str,
        runtime_task: dict[str, Any],
    ) -> None:
        self.runtime_task_notification_key(runtime_task)
        normalized_message_id = self._normalize_reply_message_id(message_id)
        if not normalized_message_id:
            return
        await cache_manager.set(
            self._runtime_task_reply_target_key(
                session.session_key,
                normalized_message_id,
            ),
            dict(runtime_task),
            expire=RUNTIME_TASK_REPLY_TARGET_TTL_SECONDS,
        )

    async def get_runtime_task_reply_target(
        self,
        *,
        session: IMPrivateSession,
        message_id: int | str | None,
    ) -> dict[str, Any] | None:
        normalized_message_id = self._normalize_reply_message_id(message_id)
        if not normalized_message_id:
            return None
        data = await cache_manager.get(
            self._runtime_task_reply_target_key(
                session.session_key,
                normalized_message_id,
            )
        )
        if not isinstance(data, dict):
            return None
        try:
            self.runtime_task_notification_key(data)
        except ValueError:
            return None
        return data

    async def list_active_runtime_task_sessions(
        self,
        db: Session | None,
        *,
        user_id: int,
        runtime_task: dict[str, Any],
    ) -> list[IMPrivateSession]:
        task_key = self.runtime_task_notification_key(runtime_task)
        sessions = await self.list_user_sessions(db, user_id=user_id)
        matched_sessions: list[IMPrivateSession] = []
        for session in sessions:
            if not isinstance(session.active_runtime_task, dict):
                continue
            try:
                active_task_key = self.runtime_task_notification_key(
                    session.active_runtime_task
                )
            except ValueError:
                continue
            if active_task_key == task_key:
                matched_sessions.append(session)
        return matched_sessions

    def runtime_task_notification_key(self, runtime_task: dict[str, Any]) -> str:
        device_id = str(
            runtime_task.get("deviceId") or runtime_task.get("device_id") or ""
        ).strip()
        local_task_id = str(
            runtime_task.get("localTaskId") or runtime_task.get("local_task_id") or ""
        ).strip()
        if not device_id or not local_task_id:
            raise ValueError(
                "Runtime task notification identity requires deviceId and localTaskId"
            )
        return "\0".join((device_id, local_task_id))

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
            session.active_runtime_task = None
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
        session.active_runtime_task = None
        session.pending_payload = {}
        session.state_expires_at = None
        await self.save_session(session)

    async def bind_active_runtime_task(
        self,
        db: Session | None,
        *,
        session: IMPrivateSession,
        runtime_task: dict[str, Any],
    ) -> None:
        session.mode = IMSessionMode.TASK
        session.state = IMSessionState.IDLE
        session.active_task_id = None
        session.active_runtime_task = dict(runtime_task)
        session.pending_payload = {}
        session.state_expires_at = None
        await self.save_session(session)

    async def clear_active_task(
        self, db: Session | None, *, session: IMPrivateSession
    ) -> None:
        session.active_task_id = None
        session.active_runtime_task = None
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

    def _global_notification_key(self, user_id: int) -> str:
        return f"{USER_GLOBAL_NOTIFICATION_PREFIX}{user_id}"

    def _runtime_task_subscriptions_key(self, user_id: int) -> str:
        return f"{USER_RUNTIME_TASK_SUBSCRIPTIONS_PREFIX}{user_id}"

    def _runtime_task_reply_target_key(
        self,
        session_key: str,
        message_id: str,
    ) -> str:
        return f"{RUNTIME_TASK_REPLY_TARGET_PREFIX}{session_key}:{message_id}"

    def _normalize_reply_message_id(self, message_id: int | str | None) -> str:
        if isinstance(message_id, bool) or message_id is None:
            return ""
        if isinstance(message_id, int):
            return str(message_id) if message_id > 0 else ""
        normalized = str(message_id).strip()
        return normalized if normalized else ""

    async def _save_global_notification_settings(
        self,
        user_id: int,
        settings: "IMGlobalNotificationSettings",
    ) -> None:
        await cache_manager.set(
            self._global_notification_key(user_id),
            {
                "enabled": settings.enabled,
                "session_key": settings.session_key,
                "updated_at": datetime.now().isoformat(),
            },
            expire=None,
        )

    async def _get_runtime_task_subscriptions(
        self,
        user_id: int,
    ) -> dict[str, list[str]]:
        data = await cache_manager.get(self._runtime_task_subscriptions_key(user_id))
        if not isinstance(data, dict):
            return {}
        normalized: dict[str, list[str]] = {}
        for key, value in data.items():
            if isinstance(key, str) and isinstance(value, list):
                normalized[key] = [
                    item for item in value if isinstance(item, str) and item
                ]
        return normalized

    async def _save_runtime_task_subscriptions(
        self,
        user_id: int,
        subscriptions: dict[str, list[str]],
    ) -> None:
        await cache_manager.set(
            self._runtime_task_subscriptions_key(user_id),
            subscriptions,
            expire=None,
        )

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


@dataclass(frozen=True)
class IMGlobalNotificationSettings:
    """User-level IM notification switch and default private session."""

    enabled: bool = False
    session_key: str | None = None
