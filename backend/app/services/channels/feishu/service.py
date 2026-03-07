# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Feishu channel provider."""

import logging
from typing import Any, Dict, Optional

from app.core.cache import cache_manager
from app.db.session import SessionLocal
from app.services.channels.base import BaseChannelProvider
from app.services.channels.feishu.handler import FeishuChannelHandler
from app.services.channels.feishu.sender import FeishuBotSender

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
    """Feishu channel provider based on event subscription webhook."""

    def __init__(self, channel: Any):
        super().__init__(channel)
        self._handler: Optional[FeishuChannelHandler] = None
        self.sender: Optional[FeishuBotSender] = None

    @property
    def app_id(self) -> Optional[str]:
        return self.config.get("app_id")

    @property
    def app_secret(self) -> Optional[str]:
        return self.config.get("app_secret")

    @property
    def verification_token(self) -> Optional[str]:
        return self.config.get("verification_token")

    def _is_configured(self) -> bool:
        return bool(self.app_id and self.app_secret)

    async def start(self) -> bool:
        if not self._is_configured():
            self._set_error("Feishu not configured: missing app_id or app_secret")
            return False

        channel_id = self.channel_id
        self.sender = FeishuBotSender(self.app_id, self.app_secret)
        self._handler = FeishuChannelHandler(
            channel_id=channel_id,
            sender=self.sender,
            get_default_team_id=lambda: _get_channel_default_team_id(channel_id),
            get_default_model_name=lambda: _get_channel_default_model_name(channel_id),
            get_user_mapping_config=lambda: _get_channel_user_mapping_config(
                channel_id
            ),
        )
        self._set_running(True)
        logger.info(
            "[Feishu] Channel %s (id=%d) started", self.channel_name, self.channel_id
        )
        return True

    async def stop(self) -> None:
        self._handler = None
        self.sender = None
        self._set_running(False)

    async def handle_event(self, body: Dict[str, Any]) -> Dict[str, Any]:
        if not self._handler:
            return {"ok": False, "error": "channel is not running"}

        if body.get("type") == "url_verification":
            return {"challenge": body.get("challenge", "")}

        header = body.get("header", {})
        event_type = header.get("event_type", "")
        event_id = header.get("event_id", "")

        if event_type != "im.message.receive_v1":
            return {"ok": True}

        if self.verification_token and body.get("token") != self.verification_token:
            logger.warning(
                "[Feishu] verification token mismatch: channel_id=%d", self.channel_id
            )
            return {"ok": False, "error": "verification failed"}

        if event_id:
            dedup_key = f"{FEISHU_MSG_DEDUP_PREFIX}{event_id}"
            exists = await cache_manager.get(dedup_key)
            if exists:
                return {"ok": True}
            await cache_manager.set(dedup_key, "1", ex=FEISHU_MSG_DEDUP_TTL)

        event = body.get("event", {})
        message = event.get("message", {})
        if message.get("message_type") != "text":
            return {"ok": True}

        await self._handler.handle_message(body)
        return {"ok": True}
