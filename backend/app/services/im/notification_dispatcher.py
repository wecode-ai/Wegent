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
from app.services.notification_copy import (
    RUNTIME_REPLY_HINT,
    NotificationLink,
    notification_message,
    runtime_message,
)
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
NOTIFICATION_LINK_LABEL = "查看详情"


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
        message = runtime_message(
            task_title=title or str(address.get("localTaskId") or "本地任务"),
            status=status,
            content=content,
        )
        return await self._send_to_sessions(
            db,
            sessions,
            notification_message(message.title, message.body),
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
                return await self._send_dingtalk(db, session, config, text)
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

    async def send_notification(
        self,
        db: Session,
        session: IMPrivateSession,
        text: str,
        *,
        title: str = "",
        links: Sequence[NotificationLink] = (),
    ) -> dict[str, Any]:
        """Send one inbox notification, linking it when the channel supports it.

        The headline is kept with the body so a pushed notification mirrors the
        inbox row it came from: DingTalk bolds it above the links, other channels
        receive the text followed by the addresses. A notification can offer more
        than one destination — the web board and the Wework deep link — so the
        links travel as a list.
        """

        if not links:
            return await self.send_text(db, session, notification_message(title, text))
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
                return await self._send_dingtalk(
                    db,
                    session,
                    config,
                    text,
                    markdown=True,
                    links=links,
                    headline=title,
                )
            return await self.send_text(
                db,
                session,
                f"{notification_message(title, text)}\n\n{_plain_links(links)}",
            )
        except Exception as exc:
            logger.exception(
                "[IMNotificationDispatcher] Failed to send notification link: "
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
        settings = await im_session_service.get_global_notification_settings(user_id)
        if not settings.enabled:
            return []

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
        db: Session,
        sessions: Sequence[IMPrivateSession],
        message: str,
        runtime_task: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        sent = 0
        results: list[dict[str, Any]] = []
        for session in _dedupe_sessions(sessions):
            outbound_message = message
            if runtime_task is not None and session.channel_type == "dingtalk":
                outbound_message = f"{message}\n\n{RUNTIME_REPLY_HINT}"
            result = await self.send_text(db, session, outbound_message)
            result.setdefault("session_key", session.session_key)
            results.append(result)
            if result.get("success"):
                sent += 1
                if runtime_task is not None:
                    reply_reference = _result_reply_reference(result)
                    if reply_reference is None:
                        logger.warning(
                            "[IMNotificationDispatcher] Runtime notification "
                            "response has no reply reference: session_key=%s",
                            session.session_key,
                        )
                    else:
                        await im_session_service.save_runtime_task_reply_target(
                            session=session,
                            message_id=reply_reference,
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
        db: Session,
        session: IMPrivateSession,
        config: dict[str, Any],
        text: str,
        *,
        markdown: bool = False,
        links: Sequence[NotificationLink] = (),
        headline: str = "",
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

        recipient_id = await self._dingtalk_recipient_id(db, session)
        if not recipient_id:
            return {
                "success": False,
                "channel_id": session.channel_id,
                "channel_type": session.channel_type,
                "error": "Missing DingTalk staff ID",
            }

        sender = DingTalkRobotSender(client_id, client_secret)
        if markdown:
            content = (
                f"**{_escape_markdown(headline)}**\n\n{_escape_markdown(text)}"
                if headline
                else _escape_markdown(text)
            )
            if links:
                content = f"{content}\n\n{_markdown_links(links)}"
            result = await sender.send_markdown_message(
                user_ids=[recipient_id],
                title=_notification_preview_title(headline or text),
                text=content,
            )
        else:
            result = await sender.send_text_message(
                user_ids=[recipient_id],
                content=text,
            )
        return {
            "channel_id": session.channel_id,
            "channel_type": session.channel_type,
            **result,
        }

    async def _dingtalk_recipient_id(
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

        recipient_id = str(binding.sender_staff_id or "").strip()
        if not recipient_id:
            return ""

        session.proactive_recipient_id = recipient_id
        await im_session_service.save_session(session)
        return recipient_id

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


def _markdown_links(links: Sequence[NotificationLink]) -> str:
    """Render every destination as one clickable DingTalk markdown line."""

    return " · ".join(f"[{link.label}]({link.url})" for link in links)


# Markdown control characters that could turn a member's own words into a link,
# an image or emphasis inside the bot's message. Links need their brackets and
# the rest carry the markup, so escaping these characters disarms the text
# while ordinary punctuation — parentheses, dates, dashes — stays readable.
_MARKDOWN_ESCAPES = str.maketrans({char: f"\\{char}" for char in "\\`*_~[]!<>"})


def _escape_markdown(text: str) -> str:
    """Neutralise Markdown syntax in text the recipient's peer controls."""

    return text.translate(_MARKDOWN_ESCAPES)


def _plain_links(links: Sequence[NotificationLink]) -> str:
    """Render the destinations for channels that cannot carry a link label."""

    return "\n".join(link.url for link in links)


def _result_reply_reference(result: dict[str, Any]) -> int | str | None:
    payload = result.get("result")
    if not isinstance(payload, dict):
        return None
    for key in ("processQueryKey", "messageId", "message_id", "id"):
        reply_reference = _normalize_reply_reference(payload.get(key))
        if reply_reference is not None:
            return reply_reference
    result_payload = payload.get("result")
    if not isinstance(result_payload, dict):
        return None
    for key in ("message_id", "messageId", "id"):
        reply_reference = _normalize_reply_reference(result_payload.get(key))
        if reply_reference is not None:
            return reply_reference
    return None


def _normalize_reply_reference(value: Any) -> int | str | None:
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        return None
    if isinstance(value, str) and not value.strip():
        return None
    return value


def _notification_preview_title(text: str, limit: int = 20) -> str:
    """Return the single-line contact-list preview for a markdown message."""

    preview = " ".join(text.split()).strip()
    if len(preview) <= limit:
        return preview or NOTIFICATION_LINK_LABEL
    return f"{preview[:limit]}…"


@contextmanager
def _notification_db_session() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


im_notification_dispatcher = IMNotificationDispatcher()
