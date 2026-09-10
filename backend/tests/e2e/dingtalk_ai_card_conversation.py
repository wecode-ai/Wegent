# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""CI E2E coverage for DingTalk private-chat runtime conversations.

The test uses the migrated CI database and real Redis-backed session/callback
state. DingTalk transport and the local runtime are the only substituted
boundaries, so the production command router, runtime event parser, callback
registry, cross-worker reconstruction, notification reply routing, and AI Card
emitter run together.
"""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any

import dingtalk_stream
from sqlalchemy.orm import Session

from app.core.cache import cache_manager
from app.db.session import SessionLocal
from app.models.im_session import IMPrivateSession, IMSessionMode, IMSessionState
from app.models.user import User
from app.schemas.runtime_work import RuntimeSendResponse
from app.services import runtime_work_service
from app.services.channels import manager as channel_manager_module
from app.services.channels.callback import (
    forward_event_to_channel_callbacks,
    runtime_local_task_callback_key,
)
from app.services.channels.device_selection import (
    CHANNEL_USER_DEVICE_PREFIX,
    DeviceType,
    device_selection_manager,
)
from app.services.channels.dingtalk.callback import dingtalk_callback_service
from app.services.channels.dingtalk.handler import DingTalkChannelHandler
from app.services.channels.handler import CHANNEL_CONV_TASK_PREFIX, MessageContext
from app.services.execution.dispatcher import ResponsesAPIEventParser
from app.services.im.notification_dispatcher import IMNotificationDispatcher
from app.services.im.session_service import (
    PRIVATE_SESSION_KEY_PREFIX,
    RUNTIME_NOTIFICATION_REPLY_TARGET_PREFIX,
    USER_GLOBAL_NOTIFICATION_PREFIX,
    USER_PRIVATE_SESSIONS_PREFIX,
    USER_RUNTIME_TASK_SUBSCRIPTIONS_PREFIX,
    im_session_service,
)
from shared.models import EventType, ExecutionEvent

CHANNEL_ID = 770001
DEVICE_ID = "dingtalk-ci-e2e-device"
FINAL_ANSWER = "最终答案：配置已经检查完成。"
EMPTY_FINAL_STATUS = "本轮已结束，未生成最终回复。"
WAITING_STATUS = "等待你在 Wework 中确认后继续。"
PRIVATE_THINKING = "private chain of thought must stay inside Wework"
SECRET_VALUE = "dingtalk-ci-e2e-secret"
NOTIFIED_DEVICE_ID = "dingtalk-ci-e2e-notified-device"
NOTIFIED_LOCAL_TASK_ID = "dingtalk-ci-e2e-notified-task"


@dataclass(frozen=True)
class TurnSpec:
    prompt: str
    terminal_data: dict[str, Any]
    expected_final: str
    reconnect_before_progress: bool = False


@dataclass
class CardRecord:
    updates: list[str]
    finished: list[str]
    failed: bool = False


class FakeAICardInstance:
    """Record DingTalk SDK writes while preserving the production card API."""

    records: dict[str, CardRecord] = {}

    def __init__(self, _client: object, _message: object) -> None:
        self.card_instance_id: str | None = None
        self.order: list[str] = []

    def set_order(self, order: list[str]) -> None:
        self.order = order

    def ai_start(self) -> None:
        self.card_instance_id = f"card-{uuid.uuid4().hex}"
        self.records[self.card_instance_id] = CardRecord([], [])

    def ai_streaming(self, content: str, append: bool = False) -> None:
        assert append is False
        self._record().updates.append(content)

    def ai_finish(self, content: str) -> None:
        self._record().finished.append(content)

    def ai_fail(self) -> None:
        self._record().failed = True

    def _record(self) -> CardRecord:
        assert self.card_instance_id is not None
        return self.records.setdefault(self.card_instance_id, CardRecord([], []))


class DingTalkConversationHarness(DingTalkChannelHandler):
    """Drive production channel code with fake external transports."""

    def __init__(self, user_id: int, turns: list[TurnSpec]) -> None:
        from app.api.ws.local_task_responses import LocalTaskResponsesHandler

        super().__init__(channel_id=CHANNEL_ID, dingtalk_client=object())
        self._user_id = user_id
        self._turns = list(turns)
        self._runtime_handler = LocalTaskResponsesHandler(ResponsesAPIEventParser())
        self.replies: list[str] = []
        self.card_ids: list[str] = []
        self.callback_keys: list[str] = []

    async def resolve_user(
        self,
        db: Session,
        message_context: MessageContext,
    ) -> User | None:
        del message_context
        return db.get(User, self._user_id)

    async def send_text_reply(
        self,
        message_context: MessageContext,
        text: str,
    ) -> bool:
        del message_context
        self.replies.append(text)
        return True

    async def _process_chat_message(
        self,
        user: User,
        message_context: MessageContext,
    ) -> None:
        selection = await device_selection_manager.get_selection(user.id)
        assert selection.device_type == DeviceType.CHAT
        assert self._turns, "Received an unexpected DingTalk chat turn"
        turn = self._turns.pop(0)
        assert message_context.content == turn.prompt

        local_task_id = f"turn-{uuid.uuid4().hex}"
        callback_key = runtime_local_task_callback_key(DEVICE_ID, local_task_id)
        emitter = await self.create_streaming_emitter(message_context)
        assert emitter is not None
        self._prepare_streaming_emitter(callback_key, emitter)
        await emitter.emit_start(task_id=callback_key, subtask_id=0)
        await self._register_streaming_emitter(
            task_id=callback_key,
            streaming_emitter=emitter,
            message_context=message_context,
        )

        card_id = emitter.card_instance_id
        assert card_id is not None
        self.card_ids.append(card_id)
        self.callback_keys.append(callback_key)

        if turn.reconnect_before_progress:
            dingtalk_callback_service._active_emitters.pop(callback_key, None)
            dingtalk_callback_service._emitter_created_at.pop(callback_key, None)
            await asyncio.sleep(emitter.MIN_UPDATE_INTERVAL + 0.05)

        await self._forward_runtime_event(
            local_task_id,
            "response.reasoning_summary_text.delta",
            {"delta": f"正在检查配置 token={SECRET_VALUE}"},
        )
        await forward_event_to_channel_callbacks(
            task_id=callback_key,
            subtask_id=0,
            event=ExecutionEvent.create(
                EventType.THINKING,
                task_id=0,
                subtask_id=0,
                content=PRIVATE_THINKING,
            ),
            source="DingTalk CI E2E private-thinking probe",
        )
        await self._forward_runtime_event(
            local_task_id,
            "response.completed",
            turn.terminal_data,
        )

        record = FakeAICardInstance.records[card_id]
        assert any("正在分析" in update for update in record.updates)
        assert turn.expected_final == record.finished[-1]
        assert not record.failed
        rendered = "\n".join([*record.updates, *record.finished])
        assert SECRET_VALUE not in rendered
        assert PRIVATE_THINKING not in rendered
        assert "正在检查配置" not in record.finished[-1]

    async def _forward_runtime_event(
        self,
        local_task_id: str,
        event_type: str,
        data: dict[str, Any],
    ) -> None:
        await self._runtime_handler.forward_runtime_event_to_channels(
            device_id=DEVICE_ID,
            payload={
                "event_type": event_type,
                "taskId": local_task_id,
                "data": data,
                "source": {
                    "source": "im",
                    "channel_type": "dingtalk",
                    "external_id": "dingtalk-ci-e2e",
                },
            },
        )


class DingTalkNotificationHarness(IMNotificationDispatcher):
    """Substitute only DingTalk delivery while exercising notification routing."""

    def __init__(self) -> None:
        self.messages: list[tuple[str, str]] = []

    async def send_text(
        self,
        db: Session,
        session: IMPrivateSession,
        text: str,
    ) -> dict[str, Any]:
        del db
        assert session.channel_type == "dingtalk"
        self.messages.append((session.session_key, text))
        return {"success": True, "channel_type": "dingtalk"}


def _message(content: str, conversation_id: str, sender_id: str) -> Any:
    data = {
        "msgtype": "text",
        "text": {"content": content},
        "msgId": f"msg-{uuid.uuid4().hex}",
        "senderId": sender_id,
        "senderStaffId": sender_id,
        "senderNick": "DingTalk CI E2E",
        "chatbotUserId": "dingtalk-ci-e2e-bot",
        "conversationId": conversation_id,
        "conversationType": "1",
        "isInAtList": False,
        "atUsers": [],
    }
    message = dingtalk_stream.ChatbotMessage.from_dict(data)
    message._wegent_callback_data = data
    return message


async def _cleanup(
    *,
    user_id: int,
    session_key: str,
    conversation_cache_key: str,
    callback_keys: list[str],
    cache_snapshots: dict[str, tuple[Any | None, int]],
) -> None:
    for callback_key in callback_keys:
        emitter = dingtalk_callback_service._active_emitters.pop(callback_key, None)
        if emitter is not None:
            await emitter.close()
        dingtalk_callback_service._emitter_created_at.pop(callback_key, None)
        dingtalk_callback_service._last_emitted_offsets.pop(callback_key, None)
        dingtalk_callback_service._remove_lock_for_task(callback_key)

    client = await cache_manager._get_client()
    try:
        await client.delete(
            f"{PRIVATE_SESSION_KEY_PREFIX}{session_key}",
            conversation_cache_key,
            f"{RUNTIME_NOTIFICATION_REPLY_TARGET_PREFIX}{session_key}",
            *cache_snapshots,
            *(
                f"{dingtalk_callback_service.redis_key_prefix}{callback_key}"
                for callback_key in callback_keys
            ),
        )
        await client.zrem(f"{USER_PRIVATE_SESSIONS_PREFIX}{user_id}", session_key)
    finally:
        await client.aclose()

    for key, (value, ttl) in cache_snapshots.items():
        if value is None:
            continue
        await cache_manager.set(key, value, expire=ttl if ttl > 0 else None)


async def _cache_snapshot(key: str) -> tuple[Any | None, int]:
    value = await cache_manager.get(key)
    client = await cache_manager._get_client()
    try:
        ttl = await client.ttl(key)
    finally:
        await client.aclose()
    return value, ttl


async def run() -> None:
    db = SessionLocal()
    try:
        user = db.query(User).order_by(User.id).first()
        assert user is not None, "DingTalk E2E requires an initialized CI user"
        user_id = user.id
    finally:
        db.close()

    conversation_id = f"dingtalk-ci-e2e-{uuid.uuid4().hex}"
    sender_id = f"dingtalk-ci-e2e-user-{uuid.uuid4().hex}"
    session_key = im_session_service.build_session_key(
        user_id=user_id,
        channel_type="dingtalk",
        channel_id=CHANNEL_ID,
        conversation_id=conversation_id,
    )
    conversation_cache_key = (
        f"{CHANNEL_CONV_TASK_PREFIX}dingtalk:{conversation_id}:{user_id}"
    )
    turns = [
        TurnSpec(
            prompt="检查配置并给出最终答案",
            terminal_data={"value": FINAL_ANSWER, "valueOrigin": "final"},
            expected_final=FINAL_ANSWER,
            reconnect_before_progress=True,
        ),
        TurnSpec(
            prompt="执行一个没有显式最终答案的步骤",
            terminal_data={
                "value": "I will inspect the repository",
                "valueOrigin": "process_fallback",
            },
            expected_final=EMPTY_FINAL_STATUS,
        ),
        TurnSpec(
            prompt="执行一个需要确认的步骤",
            terminal_data={
                "value": "",
                "valueOrigin": "empty",
                "stop_reason": "requires_action",
                "silent_exit": True,
                "silent_exit_reason": "waiting_for_user_input",
            },
            expected_final=WAITING_STATUS,
        ),
    ]
    handler = DingTalkConversationHarness(user_id, turns)
    device_selection_key = f"{CHANNEL_USER_DEVICE_PREFIX}{user_id}"
    global_notification_key = f"{USER_GLOBAL_NOTIFICATION_PREFIX}{user_id}"
    runtime_subscriptions_key = f"{USER_RUNTIME_TASK_SUBSCRIPTIONS_PREFIX}{user_id}"
    cache_snapshots = {
        key: await _cache_snapshot(key)
        for key in (
            device_selection_key,
            global_notification_key,
            runtime_subscriptions_key,
        )
    }
    original_card_class = dingtalk_stream.AIMarkdownCardInstance
    original_get_channel_manager = channel_manager_module.get_channel_manager
    original_send_runtime_message = runtime_work_service.send_runtime_message
    runtime_requests: list[Any] = []

    async def fake_send_runtime_message(**kwargs: Any) -> RuntimeSendResponse:
        request = kwargs["request"]
        runtime_requests.append(request)
        return RuntimeSendResponse(
            accepted=True,
            taskId=request.address.local_task_id,
        )

    dingtalk_stream.AIMarkdownCardInstance = FakeAICardInstance
    channel_manager_module.get_channel_manager = lambda: SimpleNamespace(
        get_channel=lambda channel_id: (
            SimpleNamespace(_client=handler._dingtalk_client)
            if channel_id == CHANNEL_ID
            else None
        )
    )
    runtime_work_service.send_runtime_message = fake_send_runtime_message

    try:
        await device_selection_manager.set_cloud_executor(user_id)
        assert (
            await device_selection_manager.get_selection(user_id)
        ).device_type == DeviceType.CLOUD
        await cache_manager.set(conversation_cache_key, 999999, expire=60)
        assert await handler.handle_message(
            _message("/new", conversation_id, sender_id)
        )
        assert await handler.handle_message(_message("1", conversation_id, sender_id))
        assert await cache_manager.get(conversation_cache_key) is None
        assert (
            await device_selection_manager.get_selection(user_id)
        ).device_type == DeviceType.CHAT

        session = await im_session_service.get_session(session_key)
        assert session is not None
        assert session.mode == IMSessionMode.CHAT
        assert session.state == IMSessionState.IDLE
        assert session.pending_payload == {}
        assert any("1. 新建 Chat" in reply for reply in handler.replies)
        assert any("已开始新 Chat" in reply for reply in handler.replies)

        for turn in turns:
            assert await handler.handle_message(
                _message(turn.prompt, conversation_id, sender_id)
            )

        assert not handler._turns
        assert len(handler.card_ids) == len(turns)
        assert FakeAICardInstance.records[handler.card_ids[0]].finished == [
            FINAL_ANSWER
        ]
        assert FakeAICardInstance.records[handler.card_ids[1]].finished == [
            EMPTY_FINAL_STATUS
        ]
        assert FakeAICardInstance.records[handler.card_ids[2]].finished == [
            WAITING_STATUS
        ]

        notified_runtime_task = {
            "deviceId": NOTIFIED_DEVICE_ID,
            "workspacePath": "/workspace/notified",
            "localTaskId": NOTIFIED_LOCAL_TASK_ID,
        }
        previous_runtime_task = {
            "deviceId": "dingtalk-ci-e2e-previous-device",
            "workspacePath": "/workspace/previous",
            "localTaskId": "dingtalk-ci-e2e-previous-task",
        }
        db = SessionLocal()
        try:
            session = await im_session_service.get_session(session_key)
            assert session is not None
            await im_session_service.bind_active_runtime_task(
                db,
                session=session,
                runtime_task=previous_runtime_task,
            )
            await im_session_service.enable_global_notification(db, session=session)
            await im_session_service.subscribe_runtime_task_notification(
                db,
                session=session,
                runtime_task=notified_runtime_task,
            )
            notification_harness = DingTalkNotificationHarness()
            notification_result = await notification_harness.send_runtime_task_update(
                db,
                user_id=user_id,
                address=notified_runtime_task,
                title="CI notification task",
                status="updated",
                content="CI runtime update",
                source="codex_watcher",
            )
        finally:
            db.close()

        assert notification_result["sent"] == 1
        assert notification_harness.messages == [
            (
                session_key,
                "任务「CI notification task」有新的 AI 回复：\n\n"
                "CI runtime update\n\n"
                "在当前钉钉私聊中直接回复，即可继续该任务。",
            )
        ]
        pending_target_key = f"{RUNTIME_NOTIFICATION_REPLY_TARGET_PREFIX}{session_key}"
        assert await cache_manager.get(pending_target_key) == notified_runtime_task

        callback_key = runtime_local_task_callback_key(
            NOTIFIED_DEVICE_ID,
            NOTIFIED_LOCAL_TASK_ID,
        )
        handler.callback_keys.append(callback_key)
        first_reply = "根据通知继续处理"
        second_reply = "继续补充验证"
        assert await handler.handle_message(
            _message(first_reply, conversation_id, sender_id)
        )
        assert await cache_manager.get(pending_target_key) is None
        assert await handler.handle_message(
            _message(second_reply, conversation_id, sender_id)
        )

        assert [request.message for request in runtime_requests] == [
            first_reply,
            second_reply,
        ]
        for request in runtime_requests:
            assert request.address.device_id == NOTIFIED_DEVICE_ID
            assert request.address.local_task_id == NOTIFIED_LOCAL_TASK_ID
            assert request.source is not None
            assert request.source.channel_type == "dingtalk"
            assert request.source.external_id == session_key
            assert request.client_user_message_id.startswith(
                f"im:dingtalk:{CHANNEL_ID}:msg-"
            )

        session = await im_session_service.get_session(session_key)
        assert session is not None
        assert session.mode == IMSessionMode.TASK
        assert session.active_runtime_task == notified_runtime_task
    finally:
        dingtalk_stream.AIMarkdownCardInstance = original_card_class
        channel_manager_module.get_channel_manager = original_get_channel_manager
        runtime_work_service.send_runtime_message = original_send_runtime_message
        await _cleanup(
            user_id=user_id,
            session_key=session_key,
            conversation_cache_key=conversation_cache_key,
            callback_keys=handler.callback_keys,
            cache_snapshots=cache_snapshots,
        )


if __name__ == "__main__":
    asyncio.run(run())
    print("DingTalk private-chat runtime conversation E2E passed")
