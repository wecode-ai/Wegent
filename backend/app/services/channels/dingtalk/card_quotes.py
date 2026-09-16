"""Route quoted cards through server-owned delivery addresses, never visible text."""

import hashlib
import json
import logging
from typing import TYPE_CHECKING, Any

from dingtalk_stream import AckMessage, CallbackMessage
from dingtalk_stream.frames import Headers

from app.core.cache import cache_manager
from app.services.channels.commands import parse_command
from app.services.channels.dingtalk.card_binding import CARD_BINDING_TTL, load_binding
from app.services.channels.dingtalk.message_logging import log_dingtalk_message

if TYPE_CHECKING:
    from app.services.channels.dingtalk.card_follow_up import (
        DingTalkCardCallbackHandler,
    )


def quote_key(channel_id: int, conversation_id: str, carrier_id: str) -> str:
    digest = hashlib.sha256(
        json.dumps([conversation_id, carrier_id]).encode()
    ).hexdigest()
    return f"dingtalk:card_quote:{channel_id}:{digest}"


async def save_quote_address(
    channel_id: int, conversation_id: str, carrier_id: str, track_id: str
) -> None:
    saved = await cache_manager.set(
        quote_key(channel_id, conversation_id, carrier_id),
        track_id,
        expire=CARD_BINDING_TTL,
    )
    if not saved:
        raise RuntimeError("Could not persist DingTalk quoted card address")


async def route_quoted_card(
    receiver: "DingTalkCardCallbackHandler", data: dict[str, Any]
) -> bool:
    """Only a verified, mapped group card quote can enter the follow-up inbox."""
    text = data.get("text")
    if not isinstance(text, dict) or not text.get("isReplyMsg"):
        return False
    quoted = text.get("repliedMsg")
    if not isinstance(quoted, dict) or quoted.get("msgType") != "interactiveCard":
        return False
    content = text.get("content")
    if not isinstance(content, str) or parse_command(content.strip()):
        return False
    carrier_id = data.get("originalProcessQueryKey")
    conversation_id = data.get("conversationId")
    if (
        data.get("conversationType") != "2"
        or not data.get("isInAtList")
        or not isinstance(carrier_id, str)
        or not carrier_id
        or not isinstance(conversation_id, str)
        or not conversation_id
    ):
        return False
    if not data.get("chatbotUserId") or quoted.get("senderId") != data["chatbotUserId"]:
        return False
    channel_id = receiver.handler.channel_id
    track_id = await cache_manager.get(
        quote_key(channel_id, conversation_id, carrier_id)
    )
    if not isinstance(track_id, str) or not track_id:
        return False
    binding = await load_binding(channel_id, track_id)
    if binding is None:
        return False
    if data.get("senderCorpId") != binding.incoming_data.get("senderCorpId"):
        return False
    callback = CallbackMessage()
    callback.headers = Headers()
    callback.headers.message_id = str(data.get("msgId") or "")
    callback.data = {
        "type": "actionCallback",
        "outTrackId": track_id,
        "corpId": data.get("senderCorpId"),
        "userId": data.get("senderStaffId"),
        "userIdType": 1,
        "spaceType": "im",
        "spaceId": conversation_id,
        "content": {
            "cardPrivateData": {
                "actionIds": [binding.config.follow_up_action],
                "params": {binding.config.follow_up_text_key: content},
            }
        },
    }
    status, message = await receiver.process(callback)
    log_dingtalk_message(
        logging.getLogger(__name__),
        "card_quote_routed",
        {
            "channel_id": channel_id,
            "task_id": binding.task_id,
            "outTrackId": track_id,
            "message_id": callback.headers.message_id,
            "accepted": status == AckMessage.STATUS_OK,
        },
    )
    if status != AckMessage.STATUS_OK:
        await receiver._report_error(
            receiver._reply_binding(binding, data.get("senderStaffId")), message
        )
    return True
