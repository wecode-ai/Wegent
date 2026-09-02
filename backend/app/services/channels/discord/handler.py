# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Discord channel handler."""

import logging
from typing import TYPE_CHECKING, Any, Callable, Dict, Optional

from app.db.session import SessionLocal
from app.services.channels.callback import (
    BaseCallbackInfo,
    BaseChannelCallbackService,
    ChannelType,
)
from app.services.channels.discord.user_resolver import DiscordUserResolver
from app.services.channels.handler import BaseChannelHandler, MessageContext
from app.services.chat.storage.db import run_sync_in_executor

if TYPE_CHECKING:
    import discord

    from app.services.execution.emitters import ResultEmitter

logger = logging.getLogger(__name__)


def _resolve_discord_user_id_sync(
    mapping_mode: str,
    mapping_config: Optional[dict[str, Any]],
    discord_user_id: int,
    discord_username: Optional[str],
    discord_global_name: Optional[str],
) -> Optional[int]:
    db = SessionLocal()
    try:
        user = DiscordUserResolver(
            db,
            user_mapping_mode=mapping_mode,
            user_mapping_config=mapping_config,
        ).resolve_user_sync(
            discord_user_id=discord_user_id,
            discord_username=discord_username,
            discord_global_name=discord_global_name,
        )
        return int(user.id) if user else None
    finally:
        db.close()


class DiscordChannelHandler(BaseChannelHandler[Any, BaseCallbackInfo]):
    """Discord-specific implementation for DM messages only."""

    def __init__(
        self,
        channel_id: int,
        get_default_team_id: Optional[Callable[[], Optional[int]]] = None,
        get_default_model_name: Optional[Callable[[], Optional[str]]] = None,
        get_user_mapping_config: Optional[Callable[[], Dict[str, Any]]] = None,
    ):
        """Initialize the Discord channel handler."""
        super().__init__(
            channel_type=ChannelType.DISCORD,
            channel_id=channel_id,
            get_default_team_id=get_default_team_id,
            get_default_model_name=get_default_model_name,
            get_user_mapping_config=get_user_mapping_config,
        )

    def parse_message(self, raw_data: Any) -> MessageContext:
        """Parse a Discord DM message into generic MessageContext."""
        message: "discord.Message" = raw_data
        author = getattr(message, "author", None)
        channel = getattr(message, "channel", None)

        author_id = self._extract_author_id(author)
        username = getattr(author, "name", None)
        global_name = getattr(author, "global_name", None)
        sender_name = getattr(author, "display_name", None) or global_name or username
        channel_id = getattr(channel, "id", "")

        return MessageContext(
            content=getattr(message, "content", None) or "",
            sender_id=str(author_id),
            sender_name=sender_name,
            conversation_id=str(channel_id) if channel_id != "" else "",
            conversation_type="private",
            is_mention=False,
            raw_message=message,
            extra_data={
                "discord_user_id": author_id,
                "discord_username": username,
                "discord_global_name": global_name,
                "discord_channel_id": channel_id,
                "discord_message_id": getattr(message, "id", None),
            },
        )

    def _extract_author_id(self, author: Any) -> int:
        raw_author_id = getattr(author, "id", 0)
        if raw_author_id is None:
            return 0
        try:
            return int(raw_author_id)
        except (TypeError, ValueError):
            return 0

    async def resolve_user_id(self, message_context: MessageContext) -> Optional[int]:
        mapping_config = await self.get_user_mapping_config_nonblocking()
        return await run_sync_in_executor(
            _resolve_discord_user_id_sync,
            mapping_config.mode,
            mapping_config.config,
            message_context.extra_data.get("discord_user_id", 0),
            message_context.extra_data.get("discord_username"),
            message_context.extra_data.get("discord_global_name"),
        )

    async def send_text_reply(self, message_context: MessageContext, text: str) -> bool:
        """Send a text reply to the Discord message channel."""
        channel = getattr(message_context.raw_message, "channel", None)
        if channel is None or not hasattr(channel, "send"):
            self.logger.error("[DiscordHandler] No channel available for reply")
            return False

        try:
            await channel.send(text)
            return True
        except Exception as e:
            self.logger.exception("[DiscordHandler] Failed to send reply: %s", e)
            return False

    def create_callback_info(self, message_context: MessageContext) -> BaseCallbackInfo:
        """Create Discord callback info for task completion notification."""
        return BaseCallbackInfo(
            channel_type=ChannelType.DISCORD,
            channel_id=self._channel_id,
            conversation_id=message_context.conversation_id,
        )

    def get_callback_service(self) -> Optional[BaseChannelCallbackService]:
        """Return no callback service for Discord v1."""
        return None

    async def create_streaming_emitter(
        self, message_context: MessageContext
    ) -> Optional["ResultEmitter"]:
        """Return no streaming emitter for Discord v1."""
        return None
