# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Feishu event handler."""

import json
import logging
from typing import Any, Callable, Dict, Optional

from sqlalchemy.orm import Session

from app.models.user import User
from app.services.channels.callback import BaseChannelCallbackService, ChannelType
from app.services.channels.feishu.callback import (
    FeishuCallbackInfo,
    feishu_callback_service,
)
from app.services.channels.feishu.emitter import StreamingResponseEmitter
from app.services.channels.feishu.sender import FeishuBotSender
from app.services.channels.feishu.user_resolver import FeishuUserResolver
from app.services.channels.handler import BaseChannelHandler, MessageContext

logger = logging.getLogger(__name__)


class FeishuChannelHandler(BaseChannelHandler[Dict[str, Any], FeishuCallbackInfo]):
    """Feishu-specific handler."""

    def __init__(
        self,
        channel_id: int,
        sender: FeishuBotSender,
        get_default_team_id: Optional[Callable[[], Optional[int]]] = None,
        get_default_model_name: Optional[Callable[[], Optional[str]]] = None,
        get_user_mapping_config: Optional[Callable[[], Dict[str, Any]]] = None,
    ):
        super().__init__(
            channel_type=ChannelType.FEISHU,
            channel_id=channel_id,
            get_default_team_id=get_default_team_id,
            get_default_model_name=get_default_model_name,
            get_user_mapping_config=get_user_mapping_config,
        )
        self._sender = sender

    def parse_message(self, raw_data: Dict[str, Any]) -> MessageContext:
        event = raw_data.get("event", {})
        sender = event.get("sender", {})
        sender_id = sender.get("sender_id", {})
        message = event.get("message", {})

        content_text = ""
        raw_content = message.get("content", "")
        if isinstance(raw_content, str) and raw_content:
            try:
                content_obj = json.loads(raw_content)
                content_text = content_obj.get("text", "").strip()
            except Exception:
                content_text = raw_content.strip()

        mentions = event.get("mentions", [])

        return MessageContext(
            content=content_text,
            sender_id=sender_id.get("open_id", "") or sender.get("sender_type", ""),
            sender_name=sender.get("sender_id", {}).get("user_id"),
            conversation_id=message.get("chat_id", ""),
            conversation_type=(
                "group" if message.get("chat_type") == "group" else "private"
            ),
            is_mention=bool(mentions),
            raw_message=raw_data,
            extra_data={
                "feishu_staff_id": sender_id.get("user_id"),
                "chat_id": message.get("chat_id", ""),
            },
        )

    async def resolve_user(
        self, db: Session, message_context: MessageContext
    ) -> Optional[User]:
        mapping_config = self.user_mapping_config
        resolver = FeishuUserResolver(
            db,
            user_mapping_mode=mapping_config.mode,
            user_mapping_config=mapping_config.config,
        )
        return await resolver.resolve_user(
            feishu_open_id=message_context.sender_id,
            feishu_name=message_context.sender_name,
            feishu_staff_id=message_context.extra_data.get("feishu_staff_id"),
        )

    async def send_text_reply(self, message_context: MessageContext, text: str) -> bool:
        chat_id = message_context.conversation_id
        result = await self._sender.send_text_message(chat_id=chat_id, text=text)
        return bool(result.get("success"))

    def create_callback_info(
        self, message_context: MessageContext
    ) -> FeishuCallbackInfo:
        return FeishuCallbackInfo(
            channel_id=self._channel_id,
            conversation_id=message_context.conversation_id,
            chat_id=message_context.extra_data.get(
                "chat_id", message_context.conversation_id
            ),
        )

    def get_callback_service(self) -> Optional[BaseChannelCallbackService]:
        return feishu_callback_service

    async def create_streaming_emitter(
        self, message_context: MessageContext
    ) -> Optional[StreamingResponseEmitter]:
        return StreamingResponseEmitter(
            sender=self._sender,
            chat_id=message_context.conversation_id,
        )
