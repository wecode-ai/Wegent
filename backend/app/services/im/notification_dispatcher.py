# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Best-effort private IM notifications for task continuation events."""

import logging
from dataclasses import dataclass
from typing import Any, Sequence

from sqlalchemy.orm import Session

from app.models.im_session import IMPrivateSession
from app.models.kind import Kind
from app.services.im.session_service import im_session_service
from app.services.subscription.notification_service import (
    subscription_notification_service,
)
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


@dataclass(frozen=True)
class _PreparedNotification:
    session: IMPrivateSession
    config: dict[str, Any] | None
    dingtalk_recipient_id: str = ""


class IMNotificationDispatcher:
    """Send provider-neutral best-effort notifications to private IM sessions."""

    async def send_task_switched_nonblocking(
        self,
        sessions: Sequence[IMPrivateSession],
        task_title: str,
    ) -> dict[str, Any]:
        """Send task-switch messages without synchronous DB work on the loop."""

        from app.services.chat.storage.db import run_sync_in_executor

        prepared = await run_sync_in_executor(
            self._prepare_notifications_with_owned_session,
            tuple(_dedupe_sessions(sessions)),
        )
        title = task_title or "当前任务"
        message = f"已切换到任务「{title}」，后续消息将继续发送到该任务。"
        results: list[dict[str, Any]] = []
        sent = 0
        for item in prepared:
            result = await self._send_prepared_text(item, message)
            result.setdefault("session_key", item.session.session_key)
            results.append(result)
            if result.get("success"):
                sent += 1
        return {"sent": sent, "results": results}

    def _prepare_notifications_with_owned_session(
        self,
        sessions: tuple[IMPrivateSession, ...],
    ) -> tuple[_PreparedNotification, ...]:
        from app.services.chat.storage.db import get_db_session

        with get_db_session() as db:
            return tuple(
                self._prepare_notification(db, session) for session in sessions
            )

    def _prepare_notification(
        self,
        db: Session,
        session: IMPrivateSession,
    ) -> _PreparedNotification:
        channel = self._get_channel(db, session.channel_id)
        if channel is None:
            return _PreparedNotification(session=session, config=None)
        config = get_channel_config(channel)
        recipient_id = ""
        if session.channel_type == "dingtalk":
            recipient_id = self._resolve_dingtalk_recipient_id_sync(db, session)
        return _PreparedNotification(
            session=session,
            config=config,
            dingtalk_recipient_id=recipient_id,
        )

    def _resolve_dingtalk_recipient_id_sync(
        self,
        db: Session,
        session: IMPrivateSession,
    ) -> str:
        recipient_id = str(session.proactive_recipient_id or "").strip()
        if recipient_id:
            return recipient_id
        bindings = subscription_notification_service.get_user_im_bindings(
            db,
            user_id=session.user_id,
        )
        binding = bindings.get(str(session.channel_id))
        if (
            binding is None
            or binding.channel_type != session.channel_type
            or str(binding.last_conversation_id or "").strip()
            != session.conversation_id
        ):
            return ""
        return str(binding.sender_staff_id or "").strip()

    async def _send_prepared_text(
        self,
        prepared: _PreparedNotification,
        text: str,
    ) -> dict[str, Any]:
        session = prepared.session
        try:
            if prepared.config is None:
                return {
                    "success": False,
                    "channel_id": session.channel_id,
                    "channel_type": session.channel_type,
                    "error": "Channel not found",
                }
            if session.channel_type == "dingtalk":
                recipient_id = prepared.dingtalk_recipient_id
                if recipient_id and recipient_id != session.proactive_recipient_id:
                    session.proactive_recipient_id = recipient_id
                    await im_session_service.save_session(session)
                return await self._send_dingtalk_to_recipient(
                    session,
                    prepared.config,
                    text,
                    recipient_id,
                )
            if session.channel_type == "telegram":
                return await self._send_telegram(session, prepared.config, text)
            if session.channel_type == "discord":
                return await self._send_discord(session, prepared.config, text)
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

        if source == "im":
            return {"sent": 0, "results": [], "skipped": "im_source"}

        sessions = await self._runtime_notification_sessions(
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
            sessions,
            message,
            runtime_task=address,
        )

    async def send_text(
        self,
        session: IMPrivateSession,
        text: str,
    ) -> dict[str, Any]:
        """Send one text message, returning a success flag instead of raising."""

        from app.services.chat.storage.db import run_sync_in_executor

        prepared = await run_sync_in_executor(self._prepare_notification_owned, session)
        return await self._send_prepared_text(prepared, text)

    def _prepare_notification_owned(
        self,
        session: IMPrivateSession,
    ) -> _PreparedNotification:
        from app.services.chat.storage.db import get_db_session

        with get_db_session() as db:
            return self._prepare_notification(db, session)

    async def _runtime_notification_sessions(
        self,
        *,
        user_id: int,
        address: dict[str, Any],
    ) -> list[IMPrivateSession]:
        settings = await im_session_service.get_global_notification_settings(user_id)
        if not settings.enabled:
            return []

        active_sessions = await im_session_service.list_active_runtime_task_sessions(
            user_id=user_id,
            runtime_task=address,
        )
        if active_sessions:
            return _dedupe_sessions(active_sessions)

        subscribed_sessions = (
            await im_session_service.list_runtime_task_notification_sessions(
                user_id=user_id,
                runtime_task=address,
            )
        )
        if subscribed_sessions:
            return _dedupe_sessions(subscribed_sessions)

        if not settings.session_key:
            return []
        if not await im_session_service.is_user_away_for_im_notifications(user_id):
            return []
        session = await im_session_service.get_session(settings.session_key)
        if session is None or session.user_id != user_id:
            return []
        return [session]

    async def _send_to_sessions(
        self,
        sessions: Sequence[IMPrivateSession],
        message: str,
        runtime_task: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        from app.services.chat.storage.db import run_sync_in_executor

        prepared = await run_sync_in_executor(
            self._prepare_notifications_with_owned_session,
            tuple(_dedupe_sessions(sessions)),
        )
        sent = 0
        results: list[dict[str, Any]] = []
        for item in prepared:
            session = item.session
            result = await self._send_prepared_text(item, message)
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

    async def _send_dingtalk_to_recipient(
        self,
        session: IMPrivateSession,
        config: dict[str, Any],
        text: str,
        recipient_id: str,
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
        if not recipient_id:
            return {
                "success": False,
                "channel_id": session.channel_id,
                "channel_type": session.channel_type,
                "error": "Missing DingTalk staff ID",
            }

        sender = DingTalkRobotSender(client_id, client_secret)
        result = await sender.send_text_message(
            user_ids=[recipient_id],
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


def get_channel_config(channel: Kind) -> dict[str, Any]:
    """Return a detached, decrypted IM channel configuration."""

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
    return f"任务「{task_title}」有新的 AI 回复：\n\n{body}"


im_notification_dispatcher = IMNotificationDispatcher()
