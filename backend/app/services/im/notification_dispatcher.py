# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Best-effort private IM notifications for task continuation events."""

import logging
from contextlib import contextmanager
from typing import Any, Generator, Sequence

from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.models.im_session import IMPrivateSession
from app.models.kind import Kind
from app.services.im.session_service import im_session_service
from shared.utils.crypto import decrypt_sensitive_data

logger = logging.getLogger(__name__)

MESSAGER_KIND = "Messager"
MESSAGER_USER_ID = 0
SENSITIVE_CONFIG_KEYS = {
    "client_secret",
    "secret",
    "token",
    "access_token",
    "app_secret",
    "encrypt_key",
    "encoding_aes_key",
    "bot_token",
}


class IMNotificationDispatcher:
    """Send provider-neutral best-effort notifications to private IM sessions."""

    async def send_task_switched(
        self,
        db: Session,
        sessions: Sequence[IMPrivateSession],
        task_title: str,
    ) -> dict[str, Any]:
        """Notify each session that subsequent IM messages target a task."""

        title = task_title or "当前任务"
        message = f"已切换到任务「{title}」，后续消息将继续发送到该任务。"
        results: list[dict[str, Any]] = []
        sent = 0

        for session in sessions:
            result = await self.send_text(db, session, message)
            result.setdefault("session_key", session.session_key)
            results.append(result)
            if result.get("success"):
                sent += 1

        return {"sent": sent, "results": results}

    async def send_runtime_task_update(
        self,
        db: Session,
        *,
        user_id: int,
        address: dict[str, Any],
        title: str,
        status: str,
        content: str = "",
        source: str | None = None,
    ) -> dict[str, Any]:
        """Notify IM sessions about a runtime task update using priority rules."""

        if source == "im":
            return {"sent": 0, "results": [], "skipped": "im_source"}

        sessions = await self._runtime_notification_sessions(
            db=db,
            user_id=user_id,
            address=address,
        )
        message = _runtime_task_update_message(
            title=title,
            local_task_id=str(address.get("localTaskId") or "本地任务"),
            status=status,
            content=content,
        )
        return await self._send_to_sessions(
            db,
            sessions,
            message,
            runtime_task=address,
        )

    async def send_runtime_task_update_for_user(
        self,
        *,
        user_id: int,
        address: dict[str, Any],
        title: str,
        status: str,
        content: str = "",
        source: str | None = None,
    ) -> dict[str, Any]:
        """Notify IM sessions about a runtime task update without exposing DB plumbing."""

        with _notification_db_session() as db:
            return await self.send_runtime_task_update(
                db,
                user_id=user_id,
                address=address,
                title=title,
                status=status,
                content=content,
                source=source,
            )

    async def send_text(
        self,
        db: Session,
        session: IMPrivateSession,
        text: str,
    ) -> dict[str, Any]:
        """Send one text message, returning a success flag instead of raising."""

        try:
            channel = self._get_channel(db, session.channel_id)
            if channel is None:
                return {
                    "success": False,
                    "channel_id": session.channel_id,
                    "channel_type": session.channel_type,
                    "error": "Channel not found",
                }

            config = _get_channel_config(channel)
            if session.channel_type == "dingtalk":
                return await self._send_dingtalk(session, config, text)
            if session.channel_type == "telegram":
                return await self._send_telegram(session, config, text)
            if session.channel_type == "discord":
                return await self._send_discord(session, config, text)

            return {
                "success": False,
                "channel_id": session.channel_id,
                "channel_type": session.channel_type,
                "error": f"Unsupported channel type: {session.channel_type}",
            }
        except Exception as exc:
            logger.exception(
                "[IMNotificationDispatcher] Failed to send notification: "
                "session_key=%s channel_type=%s",
                session.session_key,
                session.channel_type,
            )
            return {
                "success": False,
                "channel_id": session.channel_id,
                "channel_type": session.channel_type,
                "error": str(exc),
            }

    async def _runtime_notification_sessions(
        self,
        *,
        db: Session,
        user_id: int,
        address: dict[str, Any],
    ) -> list[IMPrivateSession]:
        active_sessions = await im_session_service.list_active_runtime_task_sessions(
            db,
            user_id=user_id,
            runtime_task=address,
        )
        if active_sessions:
            return _dedupe_sessions(active_sessions)

        subscribed_sessions = (
            await im_session_service.list_runtime_task_notification_sessions(
                db,
                user_id=user_id,
                runtime_task=address,
            )
        )
        if subscribed_sessions:
            return _dedupe_sessions(subscribed_sessions)

        settings = await im_session_service.get_global_notification_settings(user_id)
        if not settings.enabled or not settings.session_key:
            return []
        session = await im_session_service.get_session(settings.session_key)
        if session is None or session.user_id != user_id:
            return []
        return [session]

    async def _send_to_sessions(
        self,
        db: Session,
        sessions: Sequence[IMPrivateSession],
        message: str,
        runtime_task: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        sent = 0
        results: list[dict[str, Any]] = []
        for session in _dedupe_sessions(sessions):
            result = await self.send_text(db, session, message)
            result.setdefault("session_key", session.session_key)
            results.append(result)
            if result.get("success"):
                sent += 1
                message_id = _result_message_id(result)
                if runtime_task is not None and message_id is not None:
                    await im_session_service.save_runtime_task_reply_target(
                        session=session,
                        message_id=message_id,
                        runtime_task=runtime_task,
                    )
        return {"sent": sent, "results": results}

    def _get_channel(self, db: Session, channel_id: int) -> Kind | None:
        return (
            db.query(Kind)
            .filter(
                Kind.id == channel_id,
                Kind.kind == MESSAGER_KIND,
                Kind.user_id == MESSAGER_USER_ID,
                Kind.is_active == True,
            )
            .first()
        )

    async def _send_dingtalk(
        self,
        session: IMPrivateSession,
        config: dict[str, Any],
        text: str,
    ) -> dict[str, Any]:
        from app.services.channels.dingtalk.sender import DingTalkRobotSender

        client_id = _config_value(config, "client_id", "clientId")
        client_secret = _config_value(config, "client_secret", "clientSecret")
        if not client_id or not client_secret:
            return {
                "success": False,
                "channel_id": session.channel_id,
                "channel_type": session.channel_type,
                "error": "Missing DingTalk credentials",
            }

        sender = DingTalkRobotSender(client_id, client_secret)
        result = await sender.send_text_message(
            user_ids=[session.sender_id],
            content=text,
        )
        return {
            "channel_id": session.channel_id,
            "channel_type": session.channel_type,
            **result,
        }

    async def _send_telegram(
        self,
        session: IMPrivateSession,
        config: dict[str, Any],
        text: str,
    ) -> dict[str, Any]:
        from app.services.channels.telegram.sender import TelegramBotSender

        bot_token = _config_value(config, "bot_token", "botToken")
        if not bot_token:
            return {
                "success": False,
                "channel_id": session.channel_id,
                "channel_type": session.channel_type,
                "error": "Missing Telegram bot token",
            }

        sender = TelegramBotSender(bot_token)
        result = await sender.send_text_message(
            chat_id=int(session.sender_id),
            text=text,
        )
        return {
            "channel_id": session.channel_id,
            "channel_type": session.channel_type,
            **result,
        }

    async def _send_discord(
        self,
        session: IMPrivateSession,
        config: dict[str, Any],
        text: str,
    ) -> dict[str, Any]:
        from app.services.channels.discord.sender import DiscordBotSender

        bot_token = _config_value(config, "bot_token", "botToken")
        if not bot_token:
            return {
                "success": False,
                "channel_id": session.channel_id,
                "channel_type": session.channel_type,
                "error": "Missing Discord bot token",
            }

        sender = DiscordBotSender(bot_token)
        result = await sender.send_text_message(
            user_id=session.sender_id,
            text=text,
        )
        return {
            "channel_id": session.channel_id,
            "channel_type": session.channel_type,
            **result,
        }


def _get_channel_config(channel: Kind) -> dict[str, Any]:
    spec = channel.json.get("spec", {}) if isinstance(channel.json, dict) else {}
    config = spec.get("config", {}) if isinstance(spec, dict) else {}
    if not isinstance(config, dict):
        return {}
    return _decrypt_config(config)


def _decrypt_config(config: dict[str, Any]) -> dict[str, Any]:
    decrypted = config.copy()
    for key, value in config.items():
        if _is_sensitive_key(key) and isinstance(value, str) and value:
            decrypted[key] = decrypt_sensitive_data(value)
    return decrypted


def _is_sensitive_key(key: str) -> bool:
    key_lower = key.lower()
    return any(sensitive_key in key_lower for sensitive_key in SENSITIVE_CONFIG_KEYS)


def _config_value(config: dict[str, Any], *keys: str) -> str | None:
    for key in keys:
        value = config.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _dedupe_sessions(
    sessions: Sequence[IMPrivateSession],
) -> list[IMPrivateSession]:
    seen: set[str] = set()
    deduped: list[IMPrivateSession] = []
    for session in sessions:
        if session.session_key in seen:
            continue
        seen.add(session.session_key)
        deduped.append(session)
    return deduped


def _result_message_id(result: dict[str, Any]) -> int | str | None:
    payload = result.get("result")
    if not isinstance(payload, dict):
        return None
    result_payload = payload.get("result")
    if not isinstance(result_payload, dict):
        return None
    message_id = result_payload.get("message_id")
    if isinstance(message_id, (int, str)) and not isinstance(message_id, bool):
        return message_id
    return None


@contextmanager
def _notification_db_session() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _runtime_task_update_message(
    *,
    title: str,
    local_task_id: str,
    status: str,
    content: str,
) -> str:
    task_title = title or local_task_id or "本地任务"
    if status in {"failed", "FAILED"}:
        body = content or "任务执行失败。"
        return f"任务「{task_title}」执行失败：\n\n{body}"
    if status in {"cancelled", "CANCELLED"}:
        return f"任务「{task_title}」已取消。"

    body = content or "任务有新的更新，请打开 Wework 查看完整对话。"
    return "\n".join(
        [
            f"任务「{task_title}」有新的 AI 回复：",
            "",
            body,
            "",
            "回复这条通知可继续该任务。",
        ]
    )


im_notification_dispatcher = IMNotificationDispatcher()
