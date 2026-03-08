# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Feishu long-connection channel provider."""

import asyncio
import logging
from typing import TYPE_CHECKING, Any, Dict, Optional

from app.core.cache import cache_manager
from app.db.session import SessionLocal
from app.services.channels.base import BaseChannelProvider
from app.services.channels.feishu.handler import FeishuChannelHandler
from app.services.channels.feishu.sender import FeishuBotSender

if TYPE_CHECKING:
    from lark_oapi.api.im.v1.model.p2_im_message_receive_v1 import P2ImMessageReceiveV1
    from lark_oapi.ws.client import Client as FeishuWsClient

logger = logging.getLogger(__name__)

MESSAGER_KIND = "Messager"
MESSAGER_USER_ID = 0
FEISHU_MSG_DEDUP_PREFIX = "feishu:msg_dedup:"
FEISHU_MSG_DEDUP_TTL = 300


def _get_channel_default_team_id(channel_id: int) -> Optional[int]:
    from app.models.kind import Kind

    db = SessionLocal()
    try:
        channel = (
            db.query(Kind)
            .filter(
                Kind.id == channel_id,
                Kind.kind == MESSAGER_KIND,
                Kind.user_id == MESSAGER_USER_ID,
                Kind.is_active == True,
            )
            .first()
        )
        return channel.json.get("spec", {}).get("defaultTeamId", 0) if channel else None
    finally:
        db.close()


def _get_channel_default_model_name(channel_id: int) -> Optional[str]:
    from app.models.kind import Kind

    db = SessionLocal()
    try:
        channel = (
            db.query(Kind)
            .filter(
                Kind.id == channel_id,
                Kind.kind == MESSAGER_KIND,
                Kind.user_id == MESSAGER_USER_ID,
                Kind.is_active == True,
            )
            .first()
        )
        if not channel:
            return None
        name = channel.json.get("spec", {}).get("defaultModelName", "")
        return name if name else None
    finally:
        db.close()


def _get_channel_user_mapping_config(channel_id: int) -> Dict[str, Any]:
    from app.models.kind import Kind

    db = SessionLocal()
    try:
        channel = (
            db.query(Kind)
            .filter(
                Kind.id == channel_id,
                Kind.kind == MESSAGER_KIND,
                Kind.user_id == MESSAGER_USER_ID,
                Kind.is_active == True,
            )
            .first()
        )
        if not channel:
            return {"mode": "select_user", "config": None}

        config = channel.json.get("spec", {}).get("config", {})
        return {
            "mode": config.get("user_mapping_mode", "select_user"),
            "config": config.get("user_mapping_config"),
        }
    finally:
        db.close()


class FeishuChannelProvider(BaseChannelProvider):
    """Feishu channel provider based on Feishu official long-connection SDK."""

    def __init__(self, channel: Any):
        super().__init__(channel)
        self._handler: Optional[FeishuChannelHandler] = None
        self.sender: Optional[FeishuBotSender] = None
        self._client: Optional["FeishuWsClient"] = None
        self._task: Optional[asyncio.Task] = None
        self._event_loop: Optional[asyncio.AbstractEventLoop] = None

    @property
    def app_id(self) -> Optional[str]:
        return self.config.get("app_id")

    @property
    def app_secret(self) -> Optional[str]:
        return self.config.get("app_secret")

    def _is_configured(self) -> bool:
        return bool(self.app_id and self.app_secret)

    async def _run_client(self) -> None:
        """Run Feishu websocket client in worker thread."""
        if not self._client:
            return

        try:
            await asyncio.to_thread(self._client.start)
        except asyncio.CancelledError:
            logger.info(
                "[Feishu] Channel %s (id=%d) worker cancelled",
                self.channel_name,
                self.channel_id,
            )
            raise
        except Exception as exc:
            if self.is_running:
                self._set_error(f"Long connection exited unexpectedly: {exc}")
                logger.exception(
                    "[Feishu] Channel %s (id=%d) long connection failed: %s",
                    self.channel_name,
                    self.channel_id,
                    exc,
                )
                self._set_running(False)

    async def _handle_long_connection_event(
        self, event: "P2ImMessageReceiveV1"
    ) -> None:
        """Process Feishu IM message event from websocket SDK."""
        if not self._handler:
            return

        header = getattr(event, "header", None)
        event_id = getattr(header, "event_id", "") if header else ""
        if event_id:
            dedup_key = f"{FEISHU_MSG_DEDUP_PREFIX}{event_id}"
            exists = await cache_manager.get(dedup_key)
            if exists:
                return
            await cache_manager.set(dedup_key, "1", ex=FEISHU_MSG_DEDUP_TTL)

        event_data = getattr(event, "event", None)
        message = getattr(event_data, "message", None)
        if not message or getattr(message, "message_type", "") != "text":
            return

        sender = getattr(event_data, "sender", None)
        sender_id = getattr(sender, "sender_id", None)
        payload = {
            "header": {
                "event_type": getattr(header, "event_type", "im.message.receive_v1"),
                "event_id": event_id,
            },
            "event": {
                "message": {
                    "message_id": getattr(message, "message_id", ""),
                    "chat_id": getattr(message, "chat_id", ""),
                    "chat_type": getattr(message, "chat_type", ""),
                    "message_type": getattr(message, "message_type", ""),
                    "content": getattr(message, "content", ""),
                },
                "sender": {
                    "sender_type": getattr(sender, "sender_type", ""),
                    "sender_id": {
                        "open_id": getattr(sender_id, "open_id", ""),
                        "user_id": getattr(sender_id, "user_id", ""),
                        "union_id": getattr(sender_id, "union_id", ""),
                    },
                },
                "mentions": [
                    {
                        "key": getattr(mention, "key", ""),
                    }
                    for mention in (getattr(message, "mentions", []) or [])
                ],
            },
        }
        await self._handler.handle_message(payload)

    def _create_event_handler(self) -> Any:
        """Create Feishu SDK dispatcher for long-connection events."""
        try:
            from lark_oapi.event.dispatcher_handler import EventDispatcherHandler
        except Exception as exc:
            raise RuntimeError(
                "Feishu SDK dependency missing. Please install lark-oapi."
            ) from exc

        builder = EventDispatcherHandler.builder("", "")

        def _sync_handler(event: Any) -> None:
            if not self._event_loop:
                logger.warning(
                    "[Feishu] Event loop unavailable, dropping event for channel_id=%d",
                    self.channel_id,
                )
                return

            future = asyncio.run_coroutine_threadsafe(
                self._handle_long_connection_event(event),
                self._event_loop,
            )

            def _log_async_error(done_future: Any) -> None:
                try:
                    done_future.result()
                except Exception as exc:  # pragma: no cover - defensive logging
                    logger.exception(
                        "[Feishu] Failed to process long-connection event: %s",
                        exc,
                    )

            future.add_done_callback(_log_async_error)

        return builder.register_p2_im_message_receive_v1(_sync_handler).build()

    async def start(self) -> bool:
        if not self._is_configured():
            self._set_error("Feishu not configured: missing app_id or app_secret")
            return False

        channel_id = self.channel_id
        try:
            from lark_oapi.ws.client import Client as FeishuWsClient

            self.sender = FeishuBotSender(self.app_id, self.app_secret)
            self._handler = FeishuChannelHandler(
                channel_id=channel_id,
                sender=self.sender,
                get_default_team_id=lambda: _get_channel_default_team_id(channel_id),
                get_default_model_name=lambda: _get_channel_default_model_name(
                    channel_id
                ),
                get_user_mapping_config=lambda: _get_channel_user_mapping_config(
                    channel_id
                ),
            )
            self._event_loop = asyncio.get_running_loop()
            self._client = FeishuWsClient(
                app_id=self.app_id,
                app_secret=self.app_secret,
                event_handler=self._create_event_handler(),
            )
            self._task = asyncio.create_task(self._run_client())

            self._set_running(True)
            logger.info(
                "[Feishu] Channel %s (id=%d) started with long connection",
                self.channel_name,
                self.channel_id,
            )
            return True
        except Exception as exc:
            self._set_error(f"Failed to start Feishu long connection: {exc}")
            self._set_running(False)
            self._handler = None
            self.sender = None
            self._client = None
            self._task = None
            logger.exception(
                "[Feishu] Failed to start channel %s (id=%d): %s",
                self.channel_name,
                self.channel_id,
                exc,
            )
            return False

    async def stop(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await asyncio.wait_for(self._task, timeout=2)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                pass

        self._task = None
        self._client = None
        self._event_loop = None
        self._handler = None
        self.sender = None
        self._set_running(False)
