# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""CI E2E coverage for DingTalk private-chat AI and selection cards.

The test uses the migrated CI database and real Redis-backed session/callback
state. DingTalk transport, model/device inventory, and the local runtime are the
only substituted boundaries, so production command routing, selection
application, callback reconstruction, and AI Card projection run together.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any

import dingtalk_stream
from sqlalchemy.orm import Session

from app.core.cache import cache_manager
from app.core.constants import CLIENT_ORIGIN_WEWORK
from app.db.session import SessionLocal
from app.models.im_session import IMSessionMode, IMSessionState
from app.models.task import TaskResource
from app.models.user import User
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
from app.services.channels.dingtalk.selection_cards import (
    ACTIVE_CARD_PREFIX,
    CARD_ACTION_PREFIX,
    CARD_STATE_PREFIX,
    DingTalkSelectionCardCallbackHandler,
    DingTalkSelectionCardService,
    save_conversation_card_state,
)
from app.services.channels.handler import CHANNEL_CONV_TASK_PREFIX, MessageContext
from app.services.channels.model_selection import (
    CHANNEL_USER_MODEL_PREFIX,
    ModelSelection,
    model_selection_manager,
)
from app.services.channels.selection_service import channel_selection_service
from app.services.device_service import device_service
from app.services.execution.dispatcher import ResponsesAPIEventParser
from app.services.im.session_service import (
    PRIVATE_SESSION_KEY_PREFIX,
    USER_PRIVATE_SESSIONS_PREFIX,
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
INTERACTION_TEMPLATE_ID = "dingtalk-ci-selection.schema"
CONVERSATION_TEMPLATE_ID = "dingtalk-ci-answer.schema"
CLAUDE_MODEL_NAME = "dingtalk-ci-claude"
GPT_MODEL_NAME = "dingtalk-ci-gpt"
DEVICE_EXECUTION_TARGET_ID = "app-record-dingtalk-ci"


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


@dataclass(frozen=True)
class CacheSnapshot:
    value: Any
    ttl: int


@dataclass(frozen=True)
class SelectionCardRecord:
    out_track_id: str
    template_id: str
    space_type: str
    space_id: str
    card_data: dict[str, Any]


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


class FakeSelectionCardTransport:
    """Record card deliveries while callbacks use real Redis state."""

    def __init__(self) -> None:
        self.records: list[SelectionCardRecord] = []

    def new_out_track_id(self) -> str:
        return f"selection-card-{uuid.uuid4().hex}"

    async def create_and_deliver(
        self,
        *,
        out_track_id: str,
        template_id: str,
        space: Any,
        card_data: dict[str, Any],
    ) -> bool:
        self.records.append(
            SelectionCardRecord(
                out_track_id=out_track_id,
                template_id=template_id,
                space_type=space.space_type,
                space_id=space.space_id,
                card_data=dict(card_data),
            )
        )
        return True


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


class DingTalkSelectionHarness(DingTalkChannelHandler):
    """Drive the production inbound command path for selection cards."""

    def __init__(
        self,
        user_id: int,
        selection_service: DingTalkSelectionCardService,
    ) -> None:
        super().__init__(
            channel_id=CHANNEL_ID,
            dingtalk_client=object(),
            conversation_card_template_id=CONVERSATION_TEMPLATE_ID,
            interaction_card_template_id=INTERACTION_TEMPLATE_ID,
            selection_card_service=selection_service,
        )
        self._user_id = user_id
        self.replies: list[str] = []

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
        del user, message_context
        raise AssertionError("Selection-card command unexpectedly reached chat routing")


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


def _create_selection_task(db: Session, user_id: int, title: str) -> TaskResource:
    name = f"dingtalk-selection-e2e-{uuid.uuid4().hex}"
    task = TaskResource(
        user_id=user_id,
        kind="Task",
        name=name,
        namespace="default",
        client_origin=CLIENT_ORIGIN_WEWORK,
        is_active=TaskResource.STATE_ACTIVE,
        is_group_chat=False,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Task",
            "metadata": {"name": name, "namespace": "default"},
            "spec": {
                "title": title,
                "prompt": title,
                "teamRef": {
                    "name": "wegent-wework",
                    "namespace": "default",
                    "user_id": user_id,
                },
                "workspaceRef": {
                    "name": "workspace-dingtalk-e2e",
                    "namespace": "default",
                },
                "is_group_chat": False,
            },
            "status": {"status": "COMPLETED"},
        },
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    return task


async def _cache_snapshot(key: str) -> CacheSnapshot:
    value = await cache_manager.get(key)
    client = await cache_manager._get_client()
    try:
        ttl = await client.ttl(key)
    finally:
        await client.aclose()
    return CacheSnapshot(value=value, ttl=ttl)


async def _restore_cache_snapshot(key: str, snapshot: CacheSnapshot) -> None:
    if snapshot.value is None:
        await cache_manager.delete(key)
        return
    expire = snapshot.ttl if snapshot.ttl > 0 else None
    await cache_manager.set(key, snapshot.value, expire=expire)


def _card_callback(
    *,
    out_track_id: str,
    actor_id: str,
    params: dict[str, str],
) -> Any:
    callback = dingtalk_stream.CallbackMessage()
    callback.data = {
        "outTrackId": out_track_id,
        "userId": actor_id,
        "content": json.dumps({"cardPrivateData": {"params": params}}),
    }
    return callback


async def _invoke_card_action(
    callback_handler: DingTalkSelectionCardCallbackHandler,
    *,
    out_track_id: str,
    actor_id: str,
    params: dict[str, str],
) -> dict[str, Any]:
    status, response = await callback_handler.process(
        _card_callback(
            out_track_id=out_track_id,
            actor_id=actor_id,
            params=params,
        )
    )
    assert status == dingtalk_stream.AckMessage.STATUS_OK
    assert isinstance(response, dict)
    return response


def _option_token(response: dict[str, Any], label: str) -> str:
    card_param_map = response["cardData"]["cardParamMap"]
    options = json.loads(card_param_map["options"])
    option = next(item for item in options if item["label"] == label)
    assert option["disabled"] is False
    token = option["token"]
    assert token and label not in token
    return token


async def _cleanup(
    *,
    user_id: int,
    session_key: str,
    conversation_cache_key: str,
    callback_keys: list[str],
    previous_device_selection: Any | None,
    previous_device_selection_ttl: int,
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
            f"{CHANNEL_USER_DEVICE_PREFIX}{user_id}",
            *(
                f"{dingtalk_callback_service.redis_key_prefix}{callback_key}"
                for callback_key in callback_keys
            ),
        )
        await client.zrem(f"{USER_PRIVATE_SESSIONS_PREFIX}{user_id}", session_key)
    finally:
        await client.aclose()

    if previous_device_selection is not None:
        expire = (
            previous_device_selection_ttl if previous_device_selection_ttl > 0 else None
        )
        await cache_manager.set(
            f"{CHANNEL_USER_DEVICE_PREFIX}{user_id}",
            previous_device_selection,
            expire=expire,
        )


async def _run_selection_card_flow(user_id: int) -> None:
    conversation_id = f"dingtalk-selection-e2e-{uuid.uuid4().hex}"
    sender_id = f"dingtalk-selection-user-{uuid.uuid4().hex}"
    task_title = f"DingTalk selection E2E {uuid.uuid4().hex[:8]}"
    session_key = im_session_service.build_session_key(
        user_id=user_id,
        channel_type="dingtalk",
        channel_id=CHANNEL_ID,
        conversation_id=conversation_id,
    )
    model_key = f"{CHANNEL_USER_MODEL_PREFIX}{user_id}"
    device_key = f"{CHANNEL_USER_DEVICE_PREFIX}{user_id}"
    model_snapshot = await _cache_snapshot(model_key)
    device_snapshot = await _cache_snapshot(device_key)

    db = SessionLocal()
    try:
        task = _create_selection_task(db, user_id, task_title)
        task_id = task.id
    finally:
        db.close()

    models = [
        {
            "name": GPT_MODEL_NAME,
            "displayName": "GPT E2E",
            "type": "public",
            "provider": "openai",
        },
        {
            "name": CLAUDE_MODEL_NAME,
            "displayName": "Claude E2E",
            "type": "public",
            "provider": "anthropic",
        },
    ]
    devices = [
        {
            "device_id": "dingtalk-ci-logical-device",
            "execution_target_id": DEVICE_EXECUTION_TARGET_ID,
            "name": "DingTalk CI Mac",
            "status": "online",
        }
    ]

    async def get_devices(_db: Session, requested_user_id: int) -> list[dict[str, Any]]:
        assert requested_user_id == user_id
        return [dict(device) for device in devices]

    model_override_existed = "_available_models" in channel_selection_service.__dict__
    model_override = channel_selection_service.__dict__.get("_available_models")
    device_override_existed = "get_all_devices" in device_service.__dict__
    device_override = device_service.__dict__.get("get_all_devices")
    setattr(
        channel_selection_service,
        "_available_models",
        lambda _db, _user: [dict(model) for model in models],
    )
    setattr(device_service, "get_all_devices", get_devices)

    transport = FakeSelectionCardTransport()
    selection_service = DingTalkSelectionCardService(
        client=object(),
        channel_id=CHANNEL_ID,
        interaction_template_id=INTERACTION_TEMPLATE_ID,
        get_default_model_name=lambda: None,
        get_user_mapping_config=lambda: {
            "mode": "select_user",
            "config": {"target_user_id": user_id},
        },
    )
    selection_service._transport = transport
    callback_handler = DingTalkSelectionCardCallbackHandler(selection_service)
    handler = DingTalkSelectionHarness(user_id, selection_service)
    action_tokens: list[tuple[str, str]] = []
    answer_card_id = f"answer-card-{uuid.uuid4().hex}"

    try:
        await model_selection_manager.set_selection(
            user_id,
            ModelSelection(
                model_name=GPT_MODEL_NAME,
                model_type="public",
                display_name="GPT E2E",
                provider="openai",
            ),
        )
        await device_selection_manager.set_cloud_executor(user_id)

        incoming_message = _message("设置", conversation_id, sender_id)
        assert await handler.handle_message(incoming_message)
        assert handler.replies == []
        assert len(transport.records) == 1
        card = transport.records[0]
        assert card.template_id == INTERACTION_TEMPLATE_ID
        assert card.space_type == "IM_ROBOT"
        assert card.space_id == sender_id
        assert card.card_data["view"] == "console"
        assert card.card_data["showTask"] is True

        direct_entries = [
            ("/models", "model", "Claude E2E"),
            ("/devices", "device", "DingTalk CI Mac"),
            ("/switch", "task", task_title),
        ]
        for command, kind, option_label in direct_entries:
            assert await handler.handle_message(
                _message(command, conversation_id, sender_id)
            )
            direct_card = transport.records[-1]
            assert direct_card.card_data["view"] == "options"
            assert direct_card.card_data["kind"] == kind
            assert any(
                option["label"] == option_label
                for option in direct_card.card_data["options"]
            )
        assert len(transport.records) == 4
        assert handler.replies == []

        non_requester = await _invoke_card_action(
            callback_handler,
            out_track_id=card.out_track_id,
            actor_id="another-staff-user",
            params={"action": "open_kind", "kind": "model"},
        )
        assert non_requester["cardUpdateOptions"]["updateCardDataByKey"] is False
        assert "仅发起" in non_requester["userPrivateData"]["cardParamMap"]["status"]

        response = await _invoke_card_action(
            callback_handler,
            out_track_id=card.out_track_id,
            actor_id=sender_id,
            params={"action": "open_kind", "kind": "model"},
        )
        model_token = _option_token(response, "Claude E2E")
        action_tokens.append((card.out_track_id, model_token))
        response = await _invoke_card_action(
            callback_handler,
            out_track_id=card.out_track_id,
            actor_id=sender_id,
            params={"action": "select", "token": model_token},
        )
        assert response["cardData"]["cardParamMap"]["status"] == (
            "已切换到模型：Claude E2E"
        )
        model_selection = await model_selection_manager.get_selection(user_id)
        assert model_selection is not None
        assert model_selection.model_name == CLAUDE_MODEL_NAME

        response = await _invoke_card_action(
            callback_handler,
            out_track_id=card.out_track_id,
            actor_id=sender_id,
            params={"action": "open_kind", "kind": "device"},
        )
        device_token = _option_token(response, "DingTalk CI Mac")
        action_tokens.append((card.out_track_id, device_token))
        response = await _invoke_card_action(
            callback_handler,
            out_track_id=card.out_track_id,
            actor_id=sender_id,
            params={"action": "select", "token": device_token},
        )
        assert response["cardData"]["cardParamMap"]["status"] == (
            "已切换到设备：DingTalk CI Mac"
        )
        device_selection = await device_selection_manager.get_selection(user_id)
        assert device_selection.device_type == DeviceType.LOCAL
        assert device_selection.device_id == DEVICE_EXECUTION_TARGET_ID

        response = await _invoke_card_action(
            callback_handler,
            out_track_id=card.out_track_id,
            actor_id=sender_id,
            params={"action": "open_kind", "kind": "task"},
        )
        task_token = _option_token(response, task_title)
        action_tokens.append((card.out_track_id, task_token))
        response = await _invoke_card_action(
            callback_handler,
            out_track_id=card.out_track_id,
            actor_id=sender_id,
            params={"action": "select", "token": task_token},
        )
        assert response["cardData"]["cardParamMap"]["status"] == (
            f"已切换到任务：{task_title}"
        )
        session = await im_session_service.get_session(session_key)
        assert session is not None
        assert session.mode == IMSessionMode.TASK
        assert session.active_task_id == task_id
        assert session.state == IMSessionState.IDLE

        await save_conversation_card_state(
            out_track_id=answer_card_id,
            channel_id=CHANNEL_ID,
            interaction_template_id=INTERACTION_TEMPLATE_ID,
            user_id=user_id,
            incoming_message=incoming_message,
        )
        delivered_count = len(transport.records)
        response = await _invoke_card_action(
            callback_handler,
            out_track_id=answer_card_id,
            actor_id=sender_id,
            params={"action": "open_console"},
        )
        assert "已打开会话设置" in response["userPrivateData"]["cardParamMap"]["status"]
        assert len(transport.records) == delivered_count + 1
        assert transport.records[-1].card_data["view"] == "console"
    finally:
        if model_override_existed:
            setattr(
                channel_selection_service,
                "_available_models",
                model_override,
            )
        else:
            delattr(channel_selection_service, "_available_models")
        if device_override_existed:
            setattr(device_service, "get_all_devices", device_override)
        else:
            delattr(device_service, "get_all_devices")

        cleanup_db = SessionLocal()
        try:
            cleanup_task = cleanup_db.get(TaskResource, task_id)
            if cleanup_task is not None:
                cleanup_db.delete(cleanup_task)
                cleanup_db.commit()
        finally:
            cleanup_db.close()

        for record in transport.records:
            await cache_manager.delete(f"{CARD_STATE_PREFIX}{record.out_track_id}")
        await cache_manager.delete(f"{CARD_STATE_PREFIX}{answer_card_id}")
        for out_track_id, token in action_tokens:
            await cache_manager.delete(f"{CARD_ACTION_PREFIX}{out_track_id}:{token}")
        await cache_manager.delete(f"{ACTIVE_CARD_PREFIX}{user_id}:model")
        await cache_manager.delete(f"{ACTIVE_CARD_PREFIX}{user_id}:device")
        await cache_manager.delete(f"{ACTIVE_CARD_PREFIX}{session_key}:task")
        await cache_manager.delete(f"{PRIVATE_SESSION_KEY_PREFIX}{session_key}")
        await cache_manager.delete(
            f"{CHANNEL_CONV_TASK_PREFIX}dingtalk:{conversation_id}:{user_id}"
        )
        cache_client = await cache_manager._get_client()
        try:
            await cache_client.zrem(
                f"{USER_PRIVATE_SESSIONS_PREFIX}{user_id}", session_key
            )
        finally:
            await cache_client.aclose()
        await _restore_cache_snapshot(model_key, model_snapshot)
        await _restore_cache_snapshot(device_key, device_snapshot)


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
    previous_device_selection = await cache_manager.get(device_selection_key)
    cache_client = await cache_manager._get_client()
    try:
        previous_device_selection_ttl = await cache_client.ttl(device_selection_key)
    finally:
        await cache_client.aclose()
    original_card_class = dingtalk_stream.AIMarkdownCardInstance
    original_get_channel_manager = channel_manager_module.get_channel_manager
    dingtalk_stream.AIMarkdownCardInstance = FakeAICardInstance
    channel_manager_module.get_channel_manager = lambda: SimpleNamespace(
        get_channel=lambda channel_id: (
            SimpleNamespace(_client=handler._dingtalk_client)
            if channel_id == CHANNEL_ID
            else None
        )
    )

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

        await _run_selection_card_flow(user_id)
    finally:
        dingtalk_stream.AIMarkdownCardInstance = original_card_class
        channel_manager_module.get_channel_manager = original_get_channel_manager
        await _cleanup(
            user_id=user_id,
            session_key=session_key,
            conversation_cache_key=conversation_cache_key,
            callback_keys=handler.callback_keys,
            previous_device_selection=previous_device_selection,
            previous_device_selection_ttl=previous_device_selection_ttl,
        )


if __name__ == "__main__":
    asyncio.run(run())
    print("DingTalk private-chat card E2E passed")
