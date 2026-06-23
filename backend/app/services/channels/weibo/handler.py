# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Weibo channel handler."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any, Callable, Dict, Optional

from sqlalchemy.orm import Session

from app.models.user import User
from app.services.channels.callback import BaseChannelCallbackService, ChannelType
from app.services.channels.handler import BaseChannelHandler, MessageContext
from app.services.channels.weibo.callback import WeiboCallbackInfo
from app.services.channels.weibo.sender import WeiboSender
from app.services.channels.weibo.user_resolver import WeiboUserResolver

if TYPE_CHECKING:
    from app.services.execution.emitters import ResultEmitter

logger = logging.getLogger(__name__)


class WeiboChannelHandler(BaseChannelHandler[dict[str, Any], WeiboCallbackInfo]):
    """Weibo Open IM implementation for private messages."""

    def __init__(
        self,
        channel_id: int,
        sender: Optional[WeiboSender] = None,
        get_default_team_id: Optional[Callable[[], Optional[int]]] = None,
        get_default_model_name: Optional[Callable[[], Optional[str]]] = None,
        get_user_mapping_config: Optional[Callable[[], Dict[str, Any]]] = None,
    ):
        super().__init__(
            channel_type=ChannelType.WEIBO,
            channel_id=channel_id,
            get_default_team_id=get_default_team_id,
            get_default_model_name=get_default_model_name,
            get_user_mapping_config=get_user_mapping_config,
        )
        self._sender = sender

    def set_sender(self, sender: WeiboSender) -> None:
        self._sender = sender

    def parse_message(self, raw_data: Any) -> MessageContext:
        if not isinstance(raw_data, dict):
            return self._empty_context(raw_data, "unknown")

        event_type = str(raw_data.get("type") or "")
        payload = raw_data.get("payload")
        if event_type != "message" or not isinstance(payload, dict):
            return self._empty_context(raw_data, event_type)

        sender_id = str(payload.get("fromUserId") or "")
        return MessageContext(
            content=str(payload.get("text") or ""),
            sender_id=sender_id,
            sender_name=payload.get("fromUserName"),
            conversation_id=sender_id,
            conversation_type="private",
            is_mention=False,
            raw_message=raw_data,
            extra_data={
                "event_type": event_type,
                "weibo_user_id": sender_id,
                "weibo_email": payload.get("fromUserEmail"),
                "weibo_message_id": payload.get("messageId"),
                "weibo_timestamp": payload.get("timestamp"),
            },
        )

    def _empty_context(self, raw_data: Any, event_type: str) -> MessageContext:
        return MessageContext(
            content="",
            sender_id="",
            sender_name=None,
            conversation_id="",
            conversation_type="private",
            is_mention=False,
            raw_message=raw_data,
            extra_data={"event_type": event_type},
        )

    async def resolve_user(
        self,
        db: Session,
        message_context: MessageContext,
    ) -> Optional[User]:
        mapping_config = self.user_mapping_config
        resolver = WeiboUserResolver(
            db,
            user_mapping_mode=mapping_config.mode,
            user_mapping_config=mapping_config.config,
        )
        return await resolver.resolve_user(
            weibo_user_id=message_context.extra_data.get("weibo_user_id", ""),
            weibo_email=message_context.extra_data.get("weibo_email"),
        )

    async def send_text_reply(self, message_context: MessageContext, text: str) -> bool:
        if not self._sender:
            self.logger.error("[WeiboHandler] No sender available for reply")
            return False

        to_user_id = message_context.conversation_id or message_context.sender_id
        if not to_user_id:
            self.logger.error("[WeiboHandler] No Weibo user ID available for reply")
            return False

        try:
            return await self._sender.send_text_message(
                to_user_id=to_user_id,
                text=text,
            )
        except Exception as exc:
            self.logger.exception("[WeiboHandler] Failed to send reply: %s", exc)
            return False

    def create_callback_info(
        self, message_context: MessageContext
    ) -> WeiboCallbackInfo:
        to_user_id = message_context.conversation_id or message_context.sender_id
        return WeiboCallbackInfo(
            channel_id=self._channel_id,
            conversation_id=message_context.conversation_id,
            to_user_id=to_user_id,
        )

    def get_callback_service(self) -> Optional[BaseChannelCallbackService]:
        from app.services.channels.weibo.callback import weibo_callback_service

        return weibo_callback_service

    async def create_streaming_emitter(
        self,
        message_context: MessageContext,
    ) -> Optional["ResultEmitter"]:
        if not self._sender:
            return None

        to_user_id = message_context.conversation_id or message_context.sender_id
        if not to_user_id:
            return None

        from app.services.channels.weibo.emitter import WeiboStreamingResponseEmitter

        return WeiboStreamingResponseEmitter(
            channel_id=self._channel_id,
            to_user_id=to_user_id,
            sender=self._sender,
        )
