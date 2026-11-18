"""IM protocol input for real Backend, Redis and Executor question replies."""

import asyncio
import json
import os
from typing import Any

from sqlalchemy.orm import Session

from app.core.cache import cache_manager
from app.db.session import SessionLocal
from app.models.kind import Kind
from app.models.user import User
from app.services.channels.callback import BaseCallbackInfo, ChannelType
from app.services.channels.handler import BaseChannelHandler, MessageContext
from app.services.im.session_service import im_session_service
from shared.utils.crypto import encrypt_sensitive_data

CHANNEL_ID = 779179


class IncomingQuestionReply(BaseChannelHandler[dict[str, Any], BaseCallbackInfo]):
    def __init__(self, user_id: int) -> None:
        super().__init__(ChannelType.DINGTALK, CHANNEL_ID)
        self.user_id = user_id
        self.replies: list[str] = []

    def parse_message(self, data: dict[str, Any]) -> MessageContext:
        return MessageContext(
            content=data["message"],
            sender_id="question-ci-owner",
            sender_name="Question protocol",
            conversation_id="question-ci",
            conversation_type="private",
            is_mention=False,
            raw_message=data,
            extra_data={
                "message_id": data["messageId"],
                "reply_to_message_id": data.get("replyTo"),
            },
            proactive_recipient_id="question-ci-staff",
        )

    async def resolve_user(
        self, db: Session, message_context: MessageContext
    ) -> User | None:
        return db.get(User, self.user_id)

    async def send_text_reply(self, message_context: MessageContext, text: str) -> bool:
        self.replies.append(text)
        return True

    def create_callback_info(self, message_context: MessageContext) -> BaseCallbackInfo:
        return BaseCallbackInfo(
            channel_type=self.channel_type,
            channel_id=self.channel_id,
            conversation_id=message_context.conversation_id,
        )

    def get_callback_service(self) -> None:
        return None

    async def create_streaming_emitter(self, message_context: MessageContext) -> None:
        return None


async def seed(request: dict[str, Any]) -> dict[str, Any]:
    user_id = request["userId"]
    session = await im_session_service.get_or_create_private_session(
        db=None,
        user_id=user_id,
        channel_type="dingtalk",
        channel_id=CHANNEL_ID,
        conversation_id="question-ci",
        sender_id="question-ci-owner",
        proactive_recipient_id="question-ci-staff",
    )
    await cache_manager.set_or_raise(
        f"channel:runtime_question_fixture:{user_id}",
        {
            "session_key": session.session_key,
            "values": {
                key: await cache_manager.get_or_raise(key)
                for key in (
                    f"channel:user_global_notification:{user_id}",
                    f"channel:runtime_questions:{user_id}",
                    f"channel:stand_in_binding:{user_id}:{session.session_key}",
                    im_session_service._mode_key(session),
                )
            },
        },
        expire=3600,
    )
    with SessionLocal() as db:
        db.add(
            Kind(
                id=CHANNEL_ID,
                user_id=0,
                kind="Messager",
                namespace="system",
                name="question-ci",
                is_active=True,
                json={
                    "spec": {
                        "channelType": "dingtalk",
                        "isEnabled": True,
                        "config": {
                            "client_id": "question-ci-app",
                            "client_secret": encrypt_sensitive_data(
                                "question-ci-secret"
                            ),
                            "api_base_url": request["apiBase"],
                        },
                    }
                },
            )
        )
        db.commit()
    # A registered connection works without a selected notification target.
    await cache_manager.delete_or_raise(f"channel:user_global_notification:{user_id}")
    return {"sessionKey": session.session_key}


async def run() -> None:
    request = json.loads(os.environ["WEWORK_IM_QUESTION_FIXTURE"])
    operation = request["operation"]
    if operation == "seed":
        result = await seed(request)
    elif operation == "send":
        from app.core.socketio import initialize_socketio_server

        initialize_socketio_server()
        handler = IncomingQuestionReply(request["userId"])
        accepted = await handler.handle_message(request)
        result = {"accepted": accepted, "replies": handler.replies}
    elif operation == "cleanup":
        snapshot_key = f"channel:runtime_question_fixture:{request['userId']}"
        snapshot = await cache_manager.get_or_raise(snapshot_key)
        if snapshot:
            for key, value in snapshot["values"].items():
                if value is None:
                    await cache_manager.delete_or_raise(key)
                else:
                    await cache_manager.set_or_raise(key, value)
            session_key = snapshot["session_key"]
            await cache_manager.delete_or_raise(
                f"channel:private_session:{session_key}"
            )
            async with cache_manager._client_context() as client:
                await client.zrem(
                    f"channel:user_private_sessions:{request['userId']}", session_key
                )
            await cache_manager.delete_or_raise(snapshot_key)
        with SessionLocal() as db:
            db.query(Kind).filter(
                Kind.id == CHANNEL_ID,
                Kind.kind == "Messager",
                Kind.namespace == "system",
                Kind.user_id == 0,
            ).delete()
            db.commit()
        result = {"cleaned": True}
    elif operation == "disable":
        await im_session_service.disable_global_notification(request["userId"])
        result = {"disabled": True}
    else:
        raise ValueError("Unknown question fixture operation")
    print(json.dumps(result, ensure_ascii=False))
    await cache_manager.aclose()


if __name__ == "__main__":
    asyncio.run(run())
