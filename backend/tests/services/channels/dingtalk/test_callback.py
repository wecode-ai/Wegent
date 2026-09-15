# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace

import pytest

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
