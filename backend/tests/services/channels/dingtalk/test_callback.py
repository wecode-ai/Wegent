# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.services.channels.callback import ChannelCallbackRegistry, ChannelType
from app.services.channels.dingtalk.callback import (
    DingTalkCallbackInfo,
    DingTalkCallbackService,
)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "chat_card", [None, {"template_id": "custom.schema", "content_key": "answer"}]
)
async def test_fresh_worker_reconnects_to_persisted_dingtalk_card(
    monkeypatch: pytest.MonkeyPatch,
    chat_card,
) -> None:
    from dingtalk_stream import ChatbotMessage

    from app.services.channels import manager as channel_manager_module
    from app.services.channels.dingtalk import emitter as emitter_module

    calls: dict[str, object] = {}
    channel = SimpleNamespace(_client=object())
    channel_manager = SimpleNamespace(get_channel=lambda channel_id: channel)
    incoming_message = object()

    class FakeStreamingResponseEmitter:
        def __init__(
            self,
            *,
            dingtalk_client,
            incoming_message,
            existing_card_instance_id,
            chat_card=None,
            channel_id=0,
        ) -> None:
            calls["constructor"] = {
                "dingtalk_client": dingtalk_client,
                "incoming_message": incoming_message,
                "existing_card_instance_id": existing_card_instance_id,
                "chat_card": chat_card.model_dump() if chat_card else None,
                "channel_id": channel_id,
            }

        def set_shared_content_key(self, key: str) -> None:
            calls["shared_content_key"] = key

        async def emit_start(self, **kwargs) -> None:
            calls["emit_start"] = kwargs

    monkeypatch.setattr(
        channel_manager_module,
        "get_channel_manager",
        lambda: channel_manager,
    )
    monkeypatch.setattr(
        ChatbotMessage,
        "from_dict",
        staticmethod(lambda data: incoming_message),
    )
    monkeypatch.setattr(
        emitter_module,
        "StreamingResponseEmitter",
        FakeStreamingResponseEmitter,
    )

    persisted = DingTalkCallbackInfo(
        channel_id=77,
        conversation_id="conv-private",
        incoming_message_data={"msgId": "dingtalk-message-1"},
        card_instance_id="card-instance-1",
        chat_card=chat_card,
    )
    restored = DingTalkCallbackInfo.from_dict(persisted.to_dict())
    service = DingTalkCallbackService()

    async def fake_get_callback_info(task_id):
        return restored

    monkeypatch.setattr(service, "get_callback_info", fake_get_callback_info)

    task_id = "runtime:device-1:codex-1"
    emitter = await service._get_or_create_emitter(task_id, 42)

    assert emitter is not None
    assert calls["constructor"] == {
        "dingtalk_client": channel._client,
        "incoming_message": incoming_message,
        "existing_card_instance_id": "card-instance-1",
        "chat_card": (
            dict(
                chat_card,
                follow_up_enabled=True,
                follow_up_action="follow_up",
                follow_up_text_key="followUpText",
                follow_up_images_key="followUpImages",
                follow_up_status_key=None,
                initial_data={},
            )
            if chat_card
            else None
        ),
        "channel_id": 77,
    }
    assert calls["shared_content_key"] == f"channel:streaming_content:{task_id}"
    assert calls["emit_start"] == {"task_id": task_id, "subtask_id": 42}


@pytest.mark.asyncio
@pytest.mark.parametrize("subtask_id", [41, 42])
async def test_existing_card_reads_callback_once_and_rejects_stale_round(
    monkeypatch, subtask_id
):
    """Each chunk uses one callback snapshot without accepting an older round."""
    service = DingTalkCallbackService()
    info = DingTalkCallbackInfo(
        channel_id=77,
        conversation_id="group-a",
        chat_card={"template_id": "custom.schema"},
        card_instance_id="card-a",
        card_subtask_id=42,
    )
    get_info = AsyncMock(return_value=info)
    monkeypatch.setattr(service, "get_callback_info", get_info)
    emitter = SimpleNamespace(card_instance_id="card-a")
    await service.register_emitter(101, emitter)

    result = await service._get_or_create_emitter(101, subtask_id)

    assert result is (emitter if subtask_id == 42 else None)
    get_info.assert_awaited_once_with(101)
    assert service._active_emitters[101] is emitter


@pytest.mark.asyncio
async def test_new_card_replaces_existing_emitter(monkeypatch):
    """Reusing callback data must still evict the preceding round's card."""
    service = DingTalkCallbackService()
    info = DingTalkCallbackInfo(
        channel_id=77,
        conversation_id="group-a",
        chat_card={"template_id": "custom.schema"},
        card_instance_id="card-new",
        card_subtask_id=42,
    )
    monkeypatch.setattr(service, "get_callback_info", AsyncMock(return_value=info))
    monkeypatch.setattr(
        "app.services.channels.callback.cache_manager.delete", AsyncMock()
    )
    old = SimpleNamespace(card_instance_id="card-old", close=AsyncMock())
    new = SimpleNamespace(card_instance_id="card-new", emit_start=AsyncMock())
    await service.register_emitter(101, old)
    monkeypatch.setattr(service, "_create_emitter", AsyncMock(return_value=new))

    assert await service._get_or_create_emitter(101, 42) is new

    old.close.assert_awaited_once()
    new.emit_start.assert_awaited_once_with(task_id=101, subtask_id=42)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "terminal_result",
    [
        {"value": "Final answer", "value_origin": "final"},
        {
            "value": "",
            "silent_exit": True,
            "silent_exit_reason": "waiting_for_user_input",
            "stop_reason": "Need confirmation",
        },
    ],
)
async def test_registry_delivers_complete_terminal_result(monkeypatch, terminal_result):
    """Registry keyword arguments and waiting metadata reach the DingTalk emitter."""
    service = DingTalkCallbackService()
    info = DingTalkCallbackInfo(channel_id=77, conversation_id="private-a")
    monkeypatch.setattr(service, "get_callback_info", AsyncMock(return_value=info))
    monkeypatch.setattr(service, "delete_callback_info", AsyncMock())
    monkeypatch.setattr(service, "_remove_emitter", AsyncMock())
    emitter = SimpleNamespace(emit_done=AsyncMock())
    task_id = "runtime:device:task"
    await service.register_emitter(task_id, emitter)
    registry = ChannelCallbackRegistry()
    monkeypatch.setattr(registry, "_services", {ChannelType.DINGTALK: service})

    sent = await registry.handle_task_completed(
        task_id=task_id,
        subtask_id=42,
        status="COMPLETED",
        result=terminal_result,
    )

    assert sent
    emitter.emit_done.assert_awaited_once_with(
        task_id=task_id, subtask_id=42, result=terminal_result
    )
    service.delete_callback_info.assert_awaited_once_with(task_id)
