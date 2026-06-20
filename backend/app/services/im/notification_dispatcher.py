# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Best-effort private IM notifications for task continuation events."""

import logging
from typing import Any, Sequence

from sqlalchemy.orm import Session

from app.models.im_session import IMPrivateSession
from app.models.kind import Kind
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
            result.setdefault("session_id", session.id)
            results.append(result)
            if result.get("success"):
                sent += 1

        return {"sent": sent, "results": results}

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

            return {
                "success": False,
                "channel_id": session.channel_id,
                "channel_type": session.channel_type,
                "error": f"Unsupported channel type: {session.channel_type}",
            }
        except Exception as exc:
            logger.exception(
                "[IMNotificationDispatcher] Failed to send notification: "
                "session_id=%s channel_type=%s",
                session.id,
                session.channel_type,
            )
            return {
                "success": False,
                "channel_id": session.channel_id,
                "channel_type": session.channel_type,
                "error": str(exc),
            }

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


im_notification_dispatcher = IMNotificationDispatcher()
