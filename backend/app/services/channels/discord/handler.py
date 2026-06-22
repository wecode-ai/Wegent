# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Discord channel handler."""

import logging
from typing import TYPE_CHECKING, Any, Callable, Dict, Optional

from sqlalchemy.orm import Session

from app.models.user import User
from app.services.channels.callback import (
    BaseCallbackInfo,
    BaseChannelCallbackService,
    ChannelType,
)
from app.services.channels.discord.user_resolver import DiscordUserResolver
from app.services.channels.handler import BaseChannelHandler, MessageContext

if TYPE_CHECKING:
    import discord

    from app.services.execution.emitters import ResultEmitter

logger = logging.getLogger(__name__)


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

    async def resolve_user(
        self, db: Session, message_context: MessageContext
    ) -> Optional[User]:
        """Resolve Discord user to Wegent user."""
        mapping_config = self.user_mapping_config
        resolver = DiscordUserResolver(
            db,
            user_mapping_mode=mapping_config.mode,
            user_mapping_config=mapping_config.config,
        )
        return await resolver.resolve_user(
            discord_user_id=message_context.extra_data.get("discord_user_id", 0),
            discord_username=message_context.extra_data.get("discord_username"),
            discord_global_name=message_context.extra_data.get("discord_global_name"),
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
