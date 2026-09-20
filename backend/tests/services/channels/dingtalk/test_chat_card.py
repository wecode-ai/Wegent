# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

import json
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import httpx
import pytest
from dingtalk_stream import AckMessage, ChatbotMessage
from fastapi import HTTPException
from pydantic import ValidationError

from app.schemas.dingtalk_card import DingTalkChatCardConfig
from app.schemas.im_channel import IMChannelCreate, IMChannelUpdate
from app.services.channels.dingtalk import (
    card_binding,
    card_follow_up,
    card_quotes,
    card_transport,
)
from app.services.channels.dingtalk.callback import (
    DingTalkCallbackInfo,
    DingTalkCallbackService,
)
from app.services.channels.dingtalk.card_adapter import (
    BuiltinChatCardAdapter,
    TemplateChatCardAdapter,
)
from app.services.channels.dingtalk.card_binding import CardBinding, reply_address
from app.services.channels.dingtalk.card_follow_up import (
    DingTalkCardCallbackHandler,
    parse_follow_up,
)
from app.services.channels.dingtalk.card_inbox import CardActionRecord
from app.services.channels.dingtalk.handler import DingTalkChannelHandler

IMAGE_URL = "https://static.dingtalk.com/media/image.png"
IMAGE = {"mime_type": "image/png", "base64_data": "aW1hZ2U="}


@pytest.fixture
def config():
    return DingTalkChatCardConfig(template_id="test.schema", content_key="answer")


@pytest.fixture
def binding(config):
    return CardBinding(
        channel_id=77,
        user_id=9,
        task_id=101,
        subtask_id=202,
        config=config,
        incoming_data={
            "senderId": "encrypted-sender",
            "senderStaffId": "staff-a",
            "senderCorpId": "corp-a",
            "senderNick": "Alice",
            "conversationId": "group-a",
            "conversationType": "2",
        },
        ready=True,
    )


def action(binding, **overrides):
    data = {
        "outTrackId": "card-a",
        "type": "actionCallback",
        "userId": "staff-a",
        "userIdType": 1,
        "spaceType": "im",
        "spaceId": binding.incoming_data["conversationId"],
        "corpId": "corp-a",
        "content": json.dumps(
            {
                "cardPrivateData": {
                    "actionIds": [binding.config.follow_up_action],
                    "params": {
                        binding.config.follow_up_text_key: "  continue  ",
                        "taskId": 999,
                    },
                }
            }
        ),
    }
    return {**data, **overrides}


class MemoryCache:
    def __init__(self):
        self.data = {}

    async def get(self, key):
        return self.data.get(key)

    async def set(self, key, value, expire=None):
        self.data[key] = value
        return True

    async def setnx(self, key, value, expire=None):
        if key in self.data:
            return False
        return await self.set(key, value, expire)


class MemoryInbox:
    def __init__(self):
        self.records = {}
        self.receipts = {}
        self.claimed = set()

    async def enqueue(self, record):
        if record.event_id in self.receipts:
            return False
        self.receipts[record.event_id] = "pending"
        await self.save(record)
        return True

    async def save(self, record):
        self.records[record.event_id] = record.model_copy(deep=True)

    async def load(self, event_id):
        record = self.records.get(event_id)
        return record.model_copy(deep=True) if record else None

    async def settle(self, record):
        self.receipts[record.event_id] = record.state
        self.records.pop(record.event_id, None)

    @asynccontextmanager
    async def claim(self, event_id):
        if event_id in self.claimed:
            yield False
            return
        self.claimed.add(event_id)
        try:
            yield True
        finally:
            self.claimed.remove(event_id)


@pytest.fixture
def cache(monkeypatch):
    cache = MemoryCache()
    monkeypatch.setattr(card_binding, "cache_manager", cache)
    monkeypatch.setattr(card_follow_up, "cache_manager", cache)
    monkeypatch.setattr(card_quotes, "cache_manager", cache)
    return cache


def test_optional_config_and_explicit_removal():
    legacy = {"card_template_id": "notification.schema", "use_ai_card": False}
    assert (
        IMChannelCreate(name="bot", channel_type="dingtalk", config=legacy).config
        == legacy
    )
    assert IMChannelUpdate(config={"chat_card": None}).config == {"chat_card": None}
    custom = IMChannelUpdate(config={"chat_card": {"template_id": " chat.schema "}})
    assert custom.config["chat_card"]["template_id"] == "chat.schema"
    assert custom.config["chat_card"]["content_key"] == "content"


@pytest.mark.parametrize(
    "value",
    [
        {},
        {"template_id": " "},
        {"template_id": "a", "content_key": "flowStatus"},
        {"template_id": "a", "content_key": " "},
        {"template_id": "a", "follow_up_images_key": "followUpText"},
    ],
)
def test_bad_config_rejected_before_saving(value):
    with pytest.raises(ValidationError):
        IMChannelUpdate(config={"chat_card": value})


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "custom,enabled,expected",
    [
        (False, True, BuiltinChatCardAdapter),
        (True, True, TemplateChatCardAdapter),
        (True, False, None),
    ],
)
async def test_optional_adapter_selection(config, binding, custom, enabled, expected):
    handler = DingTalkChannelHandler(
        channel_id=77,
        dingtalk_client=Mock(),
        use_ai_card=enabled,
        get_chat_card_config=lambda: config.model_dump() if custom else None,
    )
    context = handler.parse_message(ChatbotMessage.from_dict(binding.incoming_data))
    emitter = await handler.create_streaming_emitter(context)
    if expected is None:
        assert emitter is None
    else:
        assert isinstance(emitter._card, expected)


@pytest.mark.asyncio
@pytest.mark.parametrize("conversation_type", ["1", "2"])
async def test_http_stream_full_prefixes_same_card_and_binding_ready(
    monkeypatch, cache, config, binding, conversation_type
):
    requests = []

    async def respond(request):
        requests.append((request.url.path, json.loads(request.content)))
        return httpx.Response(200, json={"success": True})

    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        card_transport.httpx,
        "AsyncClient",
        lambda **kwargs: real_client(transport=httpx.MockTransport(respond), **kwargs),
    )
    client = SimpleNamespace(
        _access_token={"accessToken": "test-token", "expireTime": float("inf")},
        credential=SimpleNamespace(client_id="robot-a"),
    )
    message = ChatbotMessage.from_dict(
        {**binding.incoming_data, "conversationType": conversation_type}
    )
    adapter = TemplateChatCardAdapter(client, message, config, 77)
    await adapter.start()
    binding.ready = False
    await card_binding.save_binding(adapter.card_instance_id, binding)
    await adapter.update("one")
    await adapter.update("one two")
    assert not (await card_binding.load_binding(77, adapter.card_instance_id)).ready
    await adapter.finish("one two")
    assert (await card_binding.load_binding(77, adapter.card_instance_id)).ready
    assert requests[0][1]["cardTemplateId"] == "test.schema"
    assert requests[0][1]["cardData"]["cardParamMap"] == {
        "answer": "",
        "flowStatus": "1",
    }
    assert requests[0][1]["callbackType"] == "STREAM"
    assert requests[1][1]["openSpaceId"] == (
        "dtv1.card//IM_ROBOT.staff-a"
        if conversation_type == "1"
        else "dtv1.card//IM_GROUP.group-a"
    )
    writes = [body for path, body in requests if path.endswith("streaming")]
    assert [body["content"] for body in writes] == ["one", "one two", "one two"]
    assert [body["isFinalize"] for body in writes] == [False, False, True]
    assert all(body["key"] == "answer" and body["isFull"] for body in writes)
    assert len({body["outTrackId"] for _, body in requests}) == 1
    assert len({body["guid"] for body in writes}) == 3


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(429, json={"secret": "hidden"}),
        httpx.Response(200, json={"success": False}),
    ],
)
async def test_api_rejection_stops_before_delivery(
    monkeypatch, config, binding, response
):
    calls = []

    def respond(request):
        calls.append(request)
        return response

    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        card_transport.httpx,
        "AsyncClient",
        lambda **kwargs: real_client(transport=httpx.MockTransport(respond), **kwargs),
    )
    adapter = TemplateChatCardAdapter(
        SimpleNamespace(
            _access_token={"accessToken": "test-token", "expireTime": float("inf")},
            credential=SimpleNamespace(client_id="r"),
        ),
        ChatbotMessage.from_dict(binding.incoming_data),
        config,
        77,
    )
    with pytest.raises(RuntimeError) as error:
        await adapter.start()
    assert "hidden" not in str(error.value)
    assert len(calls) == 1
    assert adapter.card_instance_id is None


@pytest.mark.parametrize(
    "override",
    [
        {"userId": ""},
        {"userIdType": 2},
        {"spaceId": "other-group"},
        {"corpId": "other"},
        {"type": "other"},
        {"content": "{}"},
        {"content": "invalid"},
    ],
)
def test_reject_wrong_actor_or_action(binding, override):
    with pytest.raises(ValueError):
        parse_follow_up(action(binding, **override), binding)


def test_custom_actions_and_text_only(binding):
    binding.config.follow_up_action = "askAgain"
    binding.config.follow_up_text_key = "question"
    follow_up = parse_follow_up(action(binding), binding)
    assert follow_up.text == "continue"
    assert follow_up.image_urls == []
    binding.ready = False
    with pytest.raises(ValueError, match="生成"):
        parse_follow_up(action(binding), binding)


@pytest.mark.parametrize("text", ["解释图片", "", None])
def test_optional_images_use_the_configured_parameter(binding, text):
    binding.config.follow_up_images_key = "photos"
    params = {"photos": [IMAGE_URL]}
    if text is not None:
        params["followUpText"] = text
    data = action(
        binding,
        content={
            "cardPrivateData": {
                "actionIds": ["follow_up"],
                "params": params,
            }
        },
    )
    follow_up = parse_follow_up(data, binding)
    assert follow_up.text == (text or "")
    assert follow_up.image_urls == [IMAGE_URL]


@pytest.mark.parametrize(
    "params",
    [
        {},
        {"followUpText": "  ", "followUpImages": []},
        {"followUpText": 123},
        {"followUpText": "next", "followUpImages": IMAGE_URL},
    ],
)
def test_empty_or_malformed_follow_up_rejected(binding, params):
    data = action(
        binding,
        content={
            "cardPrivateData": {
                "actionIds": ["follow_up"],
                "params": params,
            }
        },
    )
    with pytest.raises(ValueError):
        parse_follow_up(data, binding)


@pytest.mark.asyncio
@pytest.mark.parametrize("with_images", [False, True])
async def test_callback_deduplicates_and_never_trusts_client_task_id(
    monkeypatch, cache, binding, with_images
):
    await card_binding.save_binding("card-a", binding)
    handler = SimpleNamespace(
        channel_id=77, chat_card_config=binding.config, _use_ai_card=True
    )
    receiver = DingTalkCardCallbackHandler(handler)
    receiver.inbox = MemoryInbox()
    run = AsyncMock(return_value=True)
    monkeypatch.setattr(receiver, "_run", run)
    data = action(binding)
    if with_images:
        content = json.loads(data["content"])
        content["cardPrivateData"]["params"]["followUpImages"] = [IMAGE_URL]
        data["content"] = json.dumps(content)
    callback = SimpleNamespace(data=data, headers=SimpleNamespace(message_id="event-1"))
    assert await receiver.process(callback) == (AckMessage.STATUS_OK, "{}")
    assert await receiver.process(callback) == (AckMessage.STATUS_OK, "{}")
    await receiver.drain()
    assert run.await_count == 1
    assert run.call_args.args[0].task_id == 101
    assert run.call_args.args[1].text == "continue"
    assert run.call_args.args[1].image_urls == ([IMAGE_URL] if with_images else [])
    handler.channel_id = 78
    assert (await receiver.process(callback))[0] == AckMessage.STATUS_BAD_REQUEST


@pytest.mark.asyncio
async def test_expired_and_disabled_cards_are_not_dispatched(cache, binding):
    handler = SimpleNamespace(channel_id=77, chat_card_config=None, _use_ai_card=True)
    receiver = DingTalkCardCallbackHandler(handler)
    callback = SimpleNamespace(
        data=action(binding), headers=SimpleNamespace(message_id="event-1")
    )
    assert (await receiver.process(callback))[0] == AckMessage.STATUS_BAD_REQUEST
    handler.chat_card_config = binding.config
    assert (await receiver.process(callback))[0] == AckMessage.STATUS_BAD_REQUEST
    assert not receiver._jobs


def test_saved_address_excludes_webhooks_and_attachment_credentials(binding):
    data = {
        **binding.incoming_data,
        "text": "private prompt",
        "sessionWebhook": "secret",
        "downloadCode": "secret",
    }
    assert reply_address(data) == binding.incoming_data


@pytest.mark.asyncio
async def test_old_round_cannot_finish_new_card(monkeypatch, binding):
    service = DingTalkCallbackService()
    info = DingTalkCallbackInfo(
        channel_id=77,
        conversation_id="a",
        chat_card=binding.config.model_dump(),
        card_subtask_id=203,
        card_instance_id="card-b",
    )
    monkeypatch.setattr(service, "get_callback_info", AsyncMock(return_value=info))
    emitter = SimpleNamespace(card_instance_id="card-b", emit_done=AsyncMock())
    service._active_emitters[101] = emitter
    assert await service._get_or_create_emitter(101, 202) is None
    assert not await service.send_task_result(101, 202, "late answer")
    assert service._active_emitters[101] is emitter
    emitter.emit_done.assert_not_called()


@pytest.fixture
def task_round(monkeypatch, binding):
    from app.services.chat.storage import task_manager
    from app.services.im import task_continuation_service

    handler = DingTalkChannelHandler(channel_id=77)
    handler._trigger_private_im_task_response = AsyncMock()
    handler._get_selected_or_default_team = Mock(
        side_effect=AssertionError("must not change agent")
    )
    receiver = DingTalkCardCallbackHandler(handler)
    context = receiver._context(binding, "next question", "event-1")
    original = SimpleNamespace(id=101, client_origin="web", is_group_chat=False)
    team = object()
    params = SimpleNamespace(
        client_origin="web", is_group_chat=False, device_id="original-device"
    )
    result = SimpleNamespace(
        task=original,
        assistant_subtask=SimpleNamespace(id=203),
        user_subtask=SimpleNamespace(id=204),
    )
    monkeypatch.setattr(
        task_manager, "get_task_with_access_check", Mock(return_value=(original, 9))
    )
    monkeypatch.setattr(task_manager, "check_task_status", Mock())
    monkeypatch.setattr(
        "app.services.channels.dingtalk.card_collaboration.join_card_task",
        Mock(return_value=(original, False)),
    )
    monkeypatch.setattr(
        task_continuation_service, "get_task_team", Mock(return_value=team)
    )
    monkeypatch.setattr(
        task_continuation_service,
        "build_existing_task_params",
        Mock(return_value=params),
    )
    create = AsyncMock(return_value=result)
    monkeypatch.setattr(task_manager, "create_task_and_subtasks", create)
    return SimpleNamespace(
        handler=handler,
        receiver=receiver,
        context=context,
        db=Mock(),
        user=SimpleNamespace(id=9),
        create=create,
        result=result,
        team=team,
    )


@pytest.mark.asyncio
async def test_continue_uses_original_task_team_and_parameters(task_round, binding):
    r = task_round
    execution = await r.receiver._continue_task(r.db, r.user, binding, r.context)
    assert r.create.call_args.kwargs["task_id"] == 101
    assert r.create.call_args.kwargs["team"] is r.team
    assert execution.params.device_id == "original-device"
    assert r.create.call_args.kwargs["commit"] is False
    r.db.commit.assert_called_once()
    r.handler._trigger_private_im_task_response.assert_not_awaited()
    assert r.context.extra_data["chat_card"]["content_key"] == "answer"


@pytest.mark.asyncio
async def test_collaborator_turn_uses_actual_user_and_existing_group_ui(
    monkeypatch, task_round, binding
):
    from app.services.channels.dingtalk import card_collaboration

    r = task_round
    actor = SimpleNamespace(id=10, user_name="Bob")
    r.result.task.is_group_chat = True
    monkeypatch.setattr(
        card_collaboration,
        "join_card_task",
        Mock(return_value=(r.result.task, True)),
    )
    notify = AsyncMock()
    monkeypatch.setattr(card_collaboration, "notify_card_task_joined", notify)

    execution = await r.receiver._continue_task(r.db, actor, binding, r.context)

    assert r.create.call_args.kwargs["user"] is actor
    assert r.create.call_args.kwargs["task_id"] == binding.task_id
    assert r.create.call_args.kwargs["params"].is_group_chat is True
    notify.assert_awaited_once_with(r.db, r.result.task, 10, 9)
    assert execution.user_id == actor.id
    r.handler._trigger_private_im_task_response.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("text", ["解释图片", ""])
async def test_images_saved_for_current_user_message_before_trigger(
    monkeypatch, task_round, binding, text, caplog
):
    from app.services.context.context_service import ContextService

    r = task_round
    r.context.content = text
    r.context.extra_data["card_image_urls"] = [IMAGE_URL]
    download = AsyncMock(return_value=[IMAGE])
    monkeypatch.setattr(card_follow_up, "download_card_images", download)
    upload = Mock(return_value=(SimpleNamespace(id=301), None))
    monkeypatch.setattr(ContextService, "upload_attachment", upload)

    with caplog.at_level("INFO"):
        execution = await r.receiver._continue_task(r.db, r.user, binding, r.context)
    upload.assert_called_once_with(
        db=r.db,
        user_id=9,
        filename="im_image_1.png",
        binary_data=b"image",
        subtask_id=204,
        commit=False,
    )
    r.db.commit.assert_called_once()
    assert execution.user_subtask_id == 204
    assert execution.context.images == [IMAGE]
    download.assert_awaited_once_with([IMAGE_URL])
    assert r.create.call_args.kwargs["message"] == (text or "请查看图片")
    r.handler._trigger_private_im_task_response.assert_not_awaited()
    assert '"attachment_ids": [301]' in caplog.text


@pytest.mark.asyncio
async def test_download_failure_does_not_append_or_trigger(
    monkeypatch, task_round, binding
):
    r = task_round
    r.context.extra_data["card_image_urls"] = [IMAGE_URL]
    monkeypatch.setattr(
        card_follow_up,
        "download_card_images",
        AsyncMock(
            side_effect=ValueError("图片下载失败"),
        ),
    )
    with pytest.raises(ValueError, match="图片下载失败"):
        await r.receiver._continue_task(r.db, r.user, binding, r.context)
    r.create.assert_not_awaited()
    r.handler._trigger_private_im_task_response.assert_not_awaited()


@pytest.mark.asyncio
async def test_partial_save_failure_rolls_back_entire_submission(
    monkeypatch, task_round, binding
):
    from app.services.context.context_service import ContextService

    r = task_round
    monkeypatch.setattr(
        card_follow_up, "download_card_images", AsyncMock(return_value=[IMAGE, IMAGE])
    )
    upload = Mock(
        side_effect=[(SimpleNamespace(id=301), None), RuntimeError("storage failed")]
    )
    monkeypatch.setattr(ContextService, "upload_attachment", upload)
    mark_failed = Mock()
    monkeypatch.setattr(r.handler, "_mark_private_im_task_response_failed", mark_failed)
    with pytest.raises(ValueError, match="保存失败"):
        await r.receiver._continue_task(r.db, r.user, binding, r.context)
    assert upload.call_count == 2
    assert all(call.kwargs["commit"] is False for call in upload.call_args_list)
    r.db.rollback.assert_called()
    r.db.commit.assert_not_called()
    mark_failed.assert_not_called()
    r.handler._trigger_private_im_task_response.assert_not_awaited()


@pytest.mark.asyncio
async def test_running_task_is_rejected_before_appending(monkeypatch, binding):
    from app.services.chat.storage import task_manager

    handler = DingTalkChannelHandler(channel_id=77)
    receiver = DingTalkCardCallbackHandler(handler)
    context = receiver._context(binding, "next", "event-1")
    monkeypatch.setattr(
        task_manager, "get_task_with_access_check", Mock(return_value=(Mock(), 9))
    )
    monkeypatch.setattr(
        task_manager,
        "check_task_status",
        Mock(side_effect=HTTPException(400, "Task is still running")),
    )
    create = AsyncMock()
    monkeypatch.setattr(task_manager, "create_task_and_subtasks", create)
    with pytest.raises(HTTPException):
        await receiver._continue_task(Mock(), SimpleNamespace(id=9), binding, context)
    create.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", [False, True])
@pytest.mark.parametrize("with_images", [False, True])
async def test_runtime_follow_up_uses_original_address_without_switching_session(
    monkeypatch, binding, failure, with_images
):
    from app.services import runtime_work_service
    from app.services.im.session_service import im_session_service

    handler = DingTalkChannelHandler(channel_id=77)
    receiver = DingTalkCardCallbackHandler(handler)
    binding.runtime_task = {
        "deviceId": "original-device",
        "localTaskId": "original-task",
    }
    binding.task_id = "runtime:original-device:original-task"
    binding.incoming_data["conversationType"] = "1"
    context = receiver._context(binding, "next", "event-1")
    if with_images:
        from app.services.context.context_service import ContextService

        context.extra_data["card_image_urls"] = [IMAGE_URL]
        monkeypatch.setattr(
            card_follow_up, "download_card_images", AsyncMock(return_value=[IMAGE])
        )
        upload = Mock(return_value=(SimpleNamespace(id=301), None))
        monkeypatch.setattr(ContextService, "upload_attachment", upload)
    session = SimpleNamespace(
        session_key="session-a",
        channel_type="dingtalk",
        channel_id=77,
        conversation_id="group-a",
        sender_id="encrypted-sender",
        active_runtime_task={"deviceId": "new-device", "localTaskId": "new-task"},
    )
    monkeypatch.setattr(
        im_session_service,
        "get_or_create_private_session",
        AsyncMock(return_value=session),
    )
    clear = AsyncMock()
    monkeypatch.setattr(im_session_service, "clear_active_task", clear)
    monkeypatch.setattr(
        handler,
        "_create_private_im_runtime_streaming_emitter",
        AsyncMock(return_value=Mock()),
    )
    monkeypatch.setattr(handler, "_register_private_im_runtime_callback", AsyncMock())
    monkeypatch.setattr(handler, "_delete_private_im_runtime_callback", AsyncMock())
    monkeypatch.setattr(handler, "_emit_private_im_runtime_stream_error", AsyncMock())
    send = AsyncMock(return_value=SimpleNamespace(accepted=True))
    if failure:
        send.side_effect = HTTPException(404, "Unavailable")
    canonicalize = Mock(side_effect=lambda db, *, user_id, address: address)
    monkeypatch.setattr(
        runtime_work_service, "canonical_runtime_event_address", canonicalize
    )
    monkeypatch.setattr(runtime_work_service, "send_runtime_message", send)
    await receiver._continue_runtime(Mock(), SimpleNamespace(id=9), binding, context)
    canonicalize.assert_called_once()
    request = send.call_args.kwargs["request"]
    assert request.address.device_id == "original-device"
    assert request.address.local_task_id == "original-task"
    assert request.source.message_id == "event-1"
    assert request.attachment_ids == ([301] if with_images else [])
    if with_images:
        assert upload.call_args.kwargs["subtask_id"] == 0
        assert upload.call_args.kwargs["user_id"] == 9
    assert context.extra_data["card_runtime_task"] == binding.runtime_task
    clear.assert_not_called()
    assert session.active_runtime_task["localTaskId"] == "new-task"


@pytest.mark.asyncio
async def test_receipt_survives_ack_and_is_recovered_once(monkeypatch, cache, binding):
    await card_binding.save_binding("card-a", binding)
    handler = SimpleNamespace(
        channel_id=77, chat_card_config=binding.config, _use_ai_card=True
    )
    receiver = DingTalkCardCallbackHandler(handler)
    receiver.inbox = MemoryInbox()
    monkeypatch.setattr(receiver, "_schedule", Mock())
    callback = SimpleNamespace(
        data=action(binding), headers=SimpleNamespace(message_id="event-1")
    )
    assert await receiver.process(callback) == (AckMessage.STATUS_OK, "{}")
    assert receiver.inbox.records["event-1"].state == "pending"

    restarted = DingTalkCardCallbackHandler(handler)
    restarted.inbox = receiver.inbox
    restarted._run = AsyncMock(return_value=True)
    await restarted._run_record("event-1")
    await restarted._run_record("event-1")
    assert restarted._run.await_count == 1
    assert restarted.inbox.receipts["event-1"] == "completed"


@pytest.mark.asyncio
async def test_receipt_storage_failure_is_not_acknowledged(monkeypatch, cache, binding):
    await card_binding.save_binding("card-a", binding)
    handler = SimpleNamespace(
        channel_id=77, chat_card_config=binding.config, _use_ai_card=True
    )
    receiver = DingTalkCardCallbackHandler(handler)
    receiver.inbox.enqueue = AsyncMock(side_effect=RuntimeError("Redis unavailable"))
    receiver._schedule = Mock()
    callback = SimpleNamespace(
        data=action(binding), headers=SimpleNamespace(message_id="event-1")
    )
    assert (await receiver.process(callback))[0] == AckMessage.STATUS_SYSTEM_EXCEPTION
    receiver._schedule.assert_not_called()


@pytest.mark.asyncio
async def test_interrupted_dispatch_is_reported_without_reexecution(binding):
    receiver = DingTalkCardCallbackHandler(SimpleNamespace(channel_id=77))
    receiver.inbox = MemoryInbox()
    await receiver.inbox.enqueue(
        CardActionRecord(
            binding=binding,
            track_id="card-a",
            event_id="event-1",
            text="next",
            image_urls=[],
            state="running",
        )
    )
    receiver._run = AsyncMock()
    receiver._report_error = AsyncMock()
    receiver._recover_submission = Mock(return_value=None)
    await receiver._run_record("event-1")
    receiver._run.assert_not_called()
    receiver._report_error.assert_awaited_once()
    assert receiver.inbox.receipts["event-1"] == "uncertain"


@pytest.mark.asyncio
async def test_failed_status_update_retries_ui_only(binding):
    handler = SimpleNamespace(
        channel_id=77, chat_card_config=binding.config, _use_ai_card=True
    )
    receiver = DingTalkCardCallbackHandler(handler)
    receiver.inbox = MemoryInbox()
    await receiver.inbox.enqueue(
        CardActionRecord(
            binding=binding,
            track_id="card-a",
            event_id="event-1",
            text="next",
            image_urls=[],
        )
    )
    receiver._run = AsyncMock(return_value=True)
    receiver._recover_submission = Mock(return_value=None)
    receiver._update_status = AsyncMock(
        side_effect=[None, RuntimeError("HTTP timeout"), None]
    )
    await receiver._run_record("event-1")
    assert receiver.inbox.records["event-1"].state == "completed"
    await receiver._run_record("event-1")
    receiver._run.assert_awaited_once()
    assert receiver.inbox.receipts["event-1"] == "completed"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "source,expected",
    [
        ({"channel_id": 77, "message_id": "new"}, True),
        ({"channel_id": 77, "message_id": "old"}, False),
        ({"channel_id": 78, "message_id": "new"}, False),
        ({"channel_id": 77}, False),
    ],
)
async def test_runtime_card_round_checks_original_message(
    monkeypatch, binding, source, expected
):
    service = DingTalkCallbackService()
    info = DingTalkCallbackInfo(
        channel_id=77,
        conversation_id="a",
        chat_card=binding.config.model_dump(),
        card_subtask_id=0,
        incoming_message_data={"msgId": "new"},
    )
    monkeypatch.setattr(service, "get_callback_info", AsyncMock(return_value=info))
    assert (
        await service.accepts_runtime_source("runtime:device:task", source) is expected
    )


@pytest.mark.asyncio
async def test_status_update_preserves_answer_and_other_fields(config, httpx_mock):
    config.follow_up_status_key = "sendState"
    client = SimpleNamespace(
        _access_token={"accessToken": "test-token", "expireTime": float("inf")}
    )
    adapter = TemplateChatCardAdapter(client, None, config, 77, "card-a")
    httpx_mock.add_response(json={"success": True})
    await adapter.set_follow_up_status("sending")
    body = json.loads(httpx_mock.get_request().content)
    assert body["cardData"]["cardParamMap"] == {"sendState": "sending"}
    assert body["cardUpdateOptions"]["updateCardDataByKey"] is True


@pytest.mark.parametrize(
    "key", ["flowStatus", "content", "followUpText", "followUpImages"]
)
def test_status_cannot_overwrite_answer_or_inputs(key):
    with pytest.raises(ValidationError):
        DingTalkChatCardConfig(template_id="test.schema", follow_up_status_key=key)


@pytest.mark.asyncio
async def test_stream_retry_reuses_guid_and_full_body(config, httpx_mock, monkeypatch):
    httpx_mock.add_response(status_code=503, json={})
    httpx_mock.add_response(json={"success": True})
    adapter = TemplateChatCardAdapter(
        SimpleNamespace(
            _access_token={"accessToken": "test-token", "expireTime": float("inf")}
        ),
        None,
        config,
        77,
        "card-a",
    )
    await adapter.update("complete prefix")
    requests = httpx_mock.get_requests()
    assert len(requests) == 2
    assert requests[0].content == requests[1].content


@pytest.mark.asyncio
@pytest.mark.parametrize("terminal", [False, True])
async def test_late_runtime_event_never_reaches_new_card(monkeypatch, terminal):
    from app.api.ws import local_task_responses
    from shared.models import EventType, ExecutionEvent

    service = DingTalkCallbackService()
    service.get_callback_info = AsyncMock(
        return_value=DingTalkCallbackInfo(
            channel_id=77,
            conversation_id="a",
            incoming_message_data={"msgId": "new"},
            chat_card={"template_id": "test.schema"},
            card_subtask_id=0,
        )
    )
    registry = SimpleNamespace(
        get_service_by_name=Mock(return_value=service),
        handle_task_completed=AsyncMock(),
    )
    forward = AsyncMock()
    monkeypatch.setattr(local_task_responses, "get_callback_registry", lambda: registry)
    monkeypatch.setattr(
        local_task_responses, "forward_event_to_channel_callbacks", forward
    )
    receiver = local_task_responses.LocalTaskResponsesHandler(Mock())
    await receiver.forward_channel_callbacks(
        device_id="device",
        local_task_id="task",
        source={
            "source": "im",
            "channel_type": "dingtalk",
            "channel_id": 77,
            "message_id": "old",
        },
        event=ExecutionEvent(
            type=EventType.DONE if terminal else EventType.CHUNK, subtask_id=12
        ),
    )
    registry.handle_task_completed.assert_not_called()
    forward.assert_not_called()


@pytest.mark.asyncio
async def test_failed_terminal_delivery_keeps_callback_for_retry(monkeypatch, binding):
    service = DingTalkCallbackService()
    info = DingTalkCallbackInfo(
        channel_id=77,
        conversation_id="a",
        chat_card=binding.config.model_dump(),
        card_subtask_id=202,
        card_instance_id="card-a",
    )
    service.get_callback_info = AsyncMock(return_value=info)
    emitter = SimpleNamespace(
        card_instance_id="card-a",
        close=AsyncMock(),
        emit_done=AsyncMock(side_effect=RuntimeError("delivery failed")),
    )
    service._active_emitters[101] = emitter
    service.delete_callback_info = AsyncMock()
    monkeypatch.setattr(
        "app.services.channels.callback.cache_manager.delete", AsyncMock()
    )
    assert not await service.send_task_result(101, 202, "answer")
    service.delete_callback_info.assert_not_called()


def test_each_custom_card_has_separate_shared_content(config, binding):
    from app.services.channels.dingtalk.emitter import StreamingResponseEmitter

    message = ChatbotMessage.from_dict(binding.incoming_data)
    a = StreamingResponseEmitter(Mock(), message, chat_card=config, channel_id=77)
    b = StreamingResponseEmitter(Mock(), message, chat_card=config, channel_id=77)
    a.set_shared_content_key("channel:streaming_content:101")
    b.set_shared_content_key("channel:streaming_content:101")
    assert a._shared_content_key != b._shared_content_key
