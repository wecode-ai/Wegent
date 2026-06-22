# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Discord channel provider."""

import asyncio
import logging
from typing import Any, Dict, Optional

import discord

from app.services.channels.base import BaseChannelProvider
from app.services.channels.discord.handler import DiscordChannelHandler
from app.services.channels.messager_config import (
    get_channel_default_model_name,
    get_channel_default_team_id,
    get_channel_user_mapping_config,
)

logger = logging.getLogger(__name__)

DISCORD_STARTUP_TIMEOUT_SECONDS = 10.0


class DiscordChannelProvider(BaseChannelProvider):
    """Discord channel provider for DM-only bot integration."""

    def __init__(self, channel: Any):
        """Initialize the Discord channel provider."""
        super().__init__(channel)
        self._client: Optional[discord.Client] = None
        self._handler: Optional[DiscordChannelHandler] = None
        self._task: Optional[asyncio.Task] = None
        self._ready_event: Optional[asyncio.Event] = None

    @property
    def bot_token(self) -> Optional[str]:
        """Get the Discord bot token from config."""
        return self.config.get("bot_token") or self.config.get("botToken")

    def _is_configured(self) -> bool:
        """Check whether Discord is configured with a bot token."""
        return bool(self.bot_token)

    def _create_client(self) -> discord.Client:
        """Create the Discord client with DM and message content intents."""
        intents = discord.Intents.default()
        intents.dm_messages = True
        intents.message_content = True
        return discord.Client(intents=intents)

    async def start(self) -> bool:
        """Start the Discord client in a background task."""
        if not self._is_configured():
            self._set_error("Discord not configured: missing bot_token")
            return False

        if self._is_running:
            logger.warning(
                "[Discord] Channel %s (id=%d) is already running",
                self.channel_name,
                self.channel_id,
            )
            return True

        try:
            logger.info(
                "[Discord] Starting channel %s (id=%d)...",
                self.channel_name,
                self.channel_id,
            )

            channel_id = self.channel_id
            self._handler = DiscordChannelHandler(
                channel_id=channel_id,
                get_default_team_id=lambda: get_channel_default_team_id(channel_id),
                get_default_model_name=lambda: get_channel_default_model_name(
                    channel_id
                ),
                get_user_mapping_config=lambda: get_channel_user_mapping_config(
                    channel_id
                ),
            )
            self._client = self._create_client()
            self._ready_event = asyncio.Event()
            self._register_events(self._client, self._handler)
            self._task = asyncio.create_task(self._run_client())

            if not await self._wait_until_ready():
                await self._cleanup()
                return False

            self._set_running(True)

            logger.info(
                "[Discord] Channel %s (id=%d) started successfully",
                self.channel_name,
                self.channel_id,
            )
            return True
        except Exception as e:
            self._set_error(f"Failed to start: {e}")
            self._set_running(False)
            await self._cleanup()
            return False

    async def _wait_until_ready(self) -> bool:
        """Wait until the Discord client is ready or fails during startup."""
        if self._ready_event is None or self._task is None:
            self._set_error("Discord startup failed: client not initialized")
            return False

        ready_waiter = asyncio.create_task(self._ready_event.wait())
        try:
            done, _pending = await asyncio.wait(
                {ready_waiter, self._task},
                timeout=DISCORD_STARTUP_TIMEOUT_SECONDS,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if not done:
                self._set_error("Discord startup timed out")
                return False
            if self._task in done and not self._ready_event.is_set():
                if not self.last_error:
                    self._set_error("Discord client stopped before ready")
                return False
            return self._ready_event.is_set()
        finally:
            if not ready_waiter.done():
                ready_waiter.cancel()
                await asyncio.gather(ready_waiter, return_exceptions=True)

    async def _run_client(self) -> None:
        """Run the Discord client and record unexpected runtime failures."""
        try:
            if self._client is None:
                return
            await self._client.start(self.bot_token)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            self._set_error(f"Discord client stopped: {e}")
        finally:
            self._set_running(False)

    def _register_events(
        self, client: discord.Client, handler: DiscordChannelHandler
    ) -> None:
        """Register Discord client event handlers."""

        @client.event
        async def on_ready() -> None:
            if self._ready_event is not None:
                self._ready_event.set()
            logger.info(
                "[Discord] Channel %s (id=%d) logged in as %s",
                self.channel_name,
                self.channel_id,
                client.user,
            )

        @client.event
        async def on_message(message: discord.Message) -> None:
            author = getattr(message, "author", None)
            if author == client.user:
                return
            if getattr(author, "bot", False):
                return
            if not isinstance(
                getattr(message, "channel", None), discord.abc.PrivateChannel
            ):
                return

            await handler.handle_message(message)

    async def stop(self) -> None:
        """Stop the Discord client and clear provider state."""
        if not self._is_running and self._client is None and self._task is None:
            logger.debug(
                "[Discord] Channel %s (id=%d) is not running",
                self.channel_name,
                self.channel_id,
            )
            return

        logger.info(
            "[Discord] Stopping channel %s (id=%d)...",
            self.channel_name,
            self.channel_id,
        )
        self._set_running(False)
        await self._cleanup()

        logger.info(
            "[Discord] Channel %s (id=%d) stopped",
            self.channel_name,
            self.channel_id,
        )

    async def _cleanup(self) -> None:
        """Close client, cancel background task, and clear references."""
        if self._client is not None:
            try:
                await self._client.close()
            except Exception as e:
                logger.warning("[Discord] Error closing client: %s", e)

        if self._task is not None and not self._task.done():
            self._task.cancel()
            try:
                await asyncio.wait_for(self._task, timeout=3.0)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                pass

        self._task = None
        self._client = None
        self._handler = None
        self._ready_event = None

    def get_status(self) -> Dict[str, Any]:
        """Get the current status of the Discord provider."""
        status = super().get_status()
        status["extra_info"] = {
            "default_team_id": self.default_team_id,
            "dm_only": True,
        }
        return status
