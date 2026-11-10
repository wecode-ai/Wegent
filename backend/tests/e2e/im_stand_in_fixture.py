"""External IM input fixtures; Backend storage, routing and Executor stay real."""

from __future__ import annotations

import asyncio
import json
import os
from typing import Any

from app.core.cache import cache_manager
from app.db.session import SessionLocal
from app.models.user import User
from app.services.channels.callback import BaseCallbackInfo, ChannelType
from app.services.channels.handler import BaseChannelHandler, MessageContext
from app.services.im.session_service import im_session_service


class IncomingIM(BaseChannelHandler):
    """Substitute only the external IM transport, with no real delivery."""

    def __init__(self, user_id: int) -> None:
        super().__init__(ChannelType.TELEGRAM, channel_id=779001)
        self.user_id = user_id
        self.replies: list[str] = []

    def parse_message(self, data: dict[str, Any]) -> MessageContext:
        return MessageContext(
            content=data["message"],
            sender_id="im-story-owner",
            sender_name="IM 验证",
            conversation_id=data["conversationId"],
            conversation_type="private",
            is_mention=False,
            raw_message=data,
            extra_data={"message_id": data["messageId"]},
        )

    async def resolve_user(self, db, message_context):
        return db.get(User, self.user_id)

    async def send_text_reply(self, message_context, text):
        self.replies.append(text)
        return True

    def create_callback_info(self, message_context):
        return BaseCallbackInfo(
            channel_type=self.channel_type,
            channel_id=self.channel_id,
            conversation_id=message_context.conversation_id,
        )

    def get_callback_service(self):
        return None

    async def create_streaming_emitter(self, message_context):
        return None


async def run() -> None:
    request = json.loads(os.environ["WEWORK_IM_STORY_REQUEST"])
    user_id = request["userId"]
    if request["operation"] == "seed":
        keys = []
        for index in range(request.get("count", 2)):
            session = await im_session_service.get_or_create_private_session(
                db=None,
                user_id=user_id,
                channel_type="telegram",
                channel_id=779001,
                conversation_id=f"im-story-{user_id}-{index}",
                sender_id="im-story-owner",
                display_name=f"IM 验证 {index + 1}",
            )
            keys.append(session.session_key)
        print(json.dumps({"keys": keys}))
    elif request["operation"] == "target":
        from app.services.device.runtime_route import resolve_runtime_route_identity

        with SessionLocal() as db:
            identity = resolve_runtime_route_identity(
                db, user_id=user_id, submitted_device_id=request["deviceId"]
            )
            assert identity is not None
            print(
                json.dumps(
                    {
                        "deviceId": identity.logical_device_id,
                        "runtimeDeviceId": identity.runtime_device_id,
                    }
                )
            )
    elif request["operation"] == "send":
        from app.core.socketio import initialize_socketio_server

        initialize_socketio_server()
        handler = IncomingIM(user_id)
        accepted = await handler.handle_message(request)
        print(
            json.dumps(
                {"accepted": accepted, "replies": handler.replies}, ensure_ascii=False
            )
        )
    elif request["operation"] == "protocol":
        from tests.e2e.dingtalk_ai_card_conversation import run as run_protocol

        await run_protocol()
        print(json.dumps({"verified": True}))
    else:
        raise ValueError("Unknown IM fixture operation")
    await cache_manager.aclose()


if __name__ == "__main__":
    asyncio.run(run())
