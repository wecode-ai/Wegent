# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Weibo channel provider."""

import logging
from typing import Optional

from app.services.channels.base import BaseChannelProvider, ChannelLike
from app.services.channels.messager_config import (
    get_channel_default_model_name,
    get_channel_default_team_id,
    get_channel_user_mapping_config,
)
from app.services.channels.weibo.client import (
    DEFAULT_TOKEN_ENDPOINT,
    DEFAULT_WS_ENDPOINT,
    WeiboClientConfig,
    WeiboWebSocketClient,
)
from app.services.channels.weibo.handler import WeiboChannelHandler
from app.services.channels.weibo.sender import WeiboSender

logger = logging.getLogger(__name__)


class WeiboChannelProvider(BaseChannelProvider):
    """Weibo Open IM WebSocket channel provider."""

    def __init__(self, channel: ChannelLike):
        super().__init__(channel)
        self._client: Optional[WeiboWebSocketClient] = None
        self._sender: Optional[WeiboSender] = None
        self._handler: Optional[WeiboChannelHandler] = None

    @property
    def app_id(self) -> Optional[str]:
        return self.config.get("app_id")

    @property
    def app_secret(self) -> Optional[str]:
        return self.config.get("app_secret")

    @property
    def sender(self) -> Optional[WeiboSender]:
        return self._sender

    async def start(self) -> bool:
        if not self.app_id or not self.app_secret:
            self._set_error("Weibo not configured: missing app_id or app_secret")
            return False

        if self._is_running:
            logger.warning(
                "[Weibo] Channel %s (id=%d) is already running",
                self.channel_name,
                self.channel_id,
            )
            return True

        try:
            logger.info(
                "[Weibo] Starting channel %s (id=%d)...",
                self.channel_name,
                self.channel_id,
            )
            channel_id = self.channel_id
            config = WeiboClientConfig(
                channel_id=channel_id,
                app_id=self.app_id,
                app_secret=self.app_secret,
                ws_endpoint=self.config.get("ws_endpoint") or DEFAULT_WS_ENDPOINT,
                token_endpoint=self.config.get("token_endpoint")
                or DEFAULT_TOKEN_ENDPOINT,
            )
            self._client = WeiboWebSocketClient(
                config=config,
                on_message=self._handle_weibo_event,
            )
            self._sender = WeiboSender(self._client)
            self._handler = WeiboChannelHandler(
                channel_id=channel_id,
                sender=self._sender,
                get_default_team_id=lambda: get_channel_default_team_id(channel_id),
                get_default_model_name=lambda: get_channel_default_model_name(
                    channel_id
                ),
                get_user_mapping_config=lambda: get_channel_user_mapping_config(
                    channel_id
                ),
            )

            await self._client.start()
            self._set_running(True)
            logger.info(
                "[Weibo] Channel %s (id=%d) started successfully",
                self.channel_name,
                self.channel_id,
            )
            return True
        except Exception as exc:
            self._set_error(f"Failed to start: {exc}")
            self._set_running(False)
            await self._cleanup()
            return False

    async def _handle_weibo_event(self, event: dict) -> None:
        if self._handler is None:
            logger.warning(
                "[Weibo] Received event before handler initialized for channel id=%d",
                self.channel_id,
            )
            return

        try:
            await self._handler.handle_message(event)
        except Exception as exc:
            self._set_error(f"Failed to handle message: {exc}")

    async def stop(self) -> None:
        self._set_running(False)
        await self._cleanup()

    async def _cleanup(self) -> None:
        if self._client is not None:
            try:
                await self._client.close()
            except Exception as exc:
                logger.warning("[Weibo] Error closing client: %s", exc)

        self._client = None
        self._sender = None
        self._handler = None
