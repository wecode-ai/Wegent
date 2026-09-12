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
async def test_fresh_worker_reconnects_to_persisted_dingtalk_card(
    monkeypatch: pytest.MonkeyPatch,
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
        ) -> None:
            calls["constructor"] = {
                "dingtalk_client": dingtalk_client,
                "incoming_message": incoming_message,
                "existing_card_instance_id": existing_card_instance_id,
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
        user_id=9,
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
    }
    assert calls["shared_content_key"] == f"channel:streaming_content:{task_id}"
    assert calls["emit_start"] == {"task_id": task_id, "subtask_id": 42}


def test_callback_info_preserves_selection_card_contract() -> None:
    persisted = DingTalkCallbackInfo(
        channel_id=77,
        conversation_id="conv-private",
        user_id=9,
        conversation_card_template_id="answer.schema",
        interaction_card_template_id="settings.schema",
    )

    restored = DingTalkCallbackInfo.from_dict(persisted.to_dict())

    assert restored.user_id == 9
    assert restored.conversation_card_template_id == "answer.schema"
    assert restored.interaction_card_template_id == "settings.schema"
