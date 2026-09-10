# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from dingtalk_stream import CardCallbackMessage

from app.services.channels.dingtalk import card_transport as transport_module
from app.services.channels.dingtalk import selection_cards as card_module
from app.services.channels.dingtalk.card_transport import (
    DingTalkCardSpace,
    DingTalkCardTransport,
)
from app.services.channels.dingtalk.selection_cards import (
    DingTalkSelectionCardService,
    DingTalkSelectionCardState,
    selection_kind_for_message,
)
from app.services.channels.selection_service import (
    SelectionApplyResult,
    SelectionKind,
    SelectionOption,
)


class FakeCache:
    def __init__(self):
        self.values = {}

    async def get(self, key):
        return self.values.get(key)

    async def set(self, key, value, expire=None):
        self.values[key] = value
        return True

    async def setnx(self, key, value, expire=None):
        if key in self.values:
            return False
        self.values[key] = value
        return True

    async def delete(self, key):
        return self.values.pop(key, None) is not None


def _service() -> DingTalkSelectionCardService:
    return DingTalkSelectionCardService(
        client=SimpleNamespace(),
        channel_id=77,
        interaction_template_id="interaction.schema",
        get_default_model_name=lambda: None,
        get_user_mapping_config=lambda: {"mode": "select_user", "config": {}},
    )


def _state(**updates) -> DingTalkSelectionCardState:
    values = {
        "card_type": "interaction",
        "channel_id": 77,
        "interaction_template_id": "interaction.schema",
        "actor_staff_id": "staff-a",
        "user_id": 7,
        "conversation_id": "conversation-1",
        "conversation_type": "private",
        "space_type": "IM_ROBOT",
        "space_id": "staff-a",
        "session_key": "session-1",
    }
    values.update(updates)
    return DingTalkSelectionCardState(**values)


@pytest.mark.parametrize(
    ("content", "expected"),
    [
        ("设置", None),
        ("/models", SelectionKind.MODEL),
        ("换设备", SelectionKind.DEVICE),
        ("切任务", SelectionKind.TASK),
        ("/models 2", False),
        ("帮我切模型", False),
    ],
)
def test_selection_kind_only_matches_exact_no_argument_intents(content, expected):
    assert selection_kind_for_message(content) == expected


def test_render_options_exposes_only_opaque_tokens():
    service = _service()
    state = _state(kind="device")
    options = [
        SelectionOption(
            value="app-record-42",
            label="MacBook",
            description="在线",
            is_current=True,
        )
    ]

    card_data = service._render_options(state, SelectionKind.DEVICE, options)

    rendered = card_data["options"][0]
    assert rendered["label"] == "MacBook"
    assert rendered["disabled"] is True
    assert "app-record-42" not in str(card_data)
    assert state.option_values[rendered["token"]] == "app-record-42"


@pytest.mark.asyncio
async def test_group_card_rejects_task_navigation():
    service = _service()
    state = _state(conversation_type="group")

    with pytest.raises(ValueError, match="群聊不支持"):
        await service._update_navigation(
            state,
            "open_kind",
            {"kind": "task"},
        )


@pytest.mark.asyncio
async def test_non_requester_gets_private_error_without_mutation(monkeypatch):
    cache = FakeCache()
    monkeypatch.setattr(card_module, "cache_manager", cache)
    await card_module._save_state("card-1", _state(), 900)
    service = _service()
    service._resolve_actor = AsyncMock()
    message = CardCallbackMessage()
    message.card_instance_id = "card-1"
    message.user_id = "staff-b"
    message.content = {"cardPrivateData": {"params": {"action": "back"}}}

    response = await service.handle_callback(message)

    assert response["cardUpdateOptions"]["updateCardDataByKey"] is False
    assert "仅发起" in response["userPrivateData"]["cardParamMap"]["status"]
    service._resolve_actor.assert_not_awaited()


@pytest.mark.asyncio
async def test_select_callback_applies_once_and_clears_option_tokens(monkeypatch):
    cache = FakeCache()
    monkeypatch.setattr(card_module, "cache_manager", cache)
    state = _state(kind="model", option_values={"opaque-token": "public\0claude"})
    await card_module._save_state("card-1", state, 900)
    service = _service()
    user = SimpleNamespace(id=7)
    apply_kind = AsyncMock(
        return_value=SelectionApplyResult(
            SelectionKind.MODEL,
            "Claude",
            True,
        )
    )
    service._resolve_actor = AsyncMock(return_value=user)
    service._load_session = AsyncMock(return_value=SimpleNamespace(user_id=7))
    service._apply_kind = apply_kind

    async def render(_db, _user, _session, current_state):
        return {"status": current_state.status}

    service._render = AsyncMock(side_effect=render)
    message = CardCallbackMessage()
    message.card_instance_id = "card-1"
    message.user_id = "staff-a"
    message.content = {
        "cardPrivateData": {"params": {"action": "select", "token": "opaque-token"}}
    }

    first = await service.handle_callback(message)
    second = await service.handle_callback(message)

    assert first["cardData"]["cardParamMap"]["status"] == "已切换到模型：Claude"
    assert "操作失败" in second["cardData"]["cardParamMap"]["status"]
    apply_kind.assert_awaited_once()
    saved = await card_module._get_state("card-1")
    assert saved is not None
    assert saved.option_values == {}


@pytest.mark.asyncio
async def test_expired_card_returns_private_recovery_guidance(monkeypatch):
    monkeypatch.setattr(card_module, "cache_manager", FakeCache())
    service = _service()
    message = CardCallbackMessage()
    message.card_instance_id = "missing"
    message.user_id = "staff-a"

    response = await service.handle_callback(message)

    assert "已过期" in response["userPrivateData"]["cardParamMap"]["status"]


@pytest.mark.asyncio
async def test_card_transport_uses_stream_callback_and_staff_id(monkeypatch):
    captured = {}

    class FakeResponse:
        def raise_for_status(self):
            return None

    class FakeHTTPClient:
        def __init__(self, timeout):
            captured["timeout"] = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, url, *, headers, json):
            captured.update({"url": url, "headers": headers, "payload": json})
            return FakeResponse()

    monkeypatch.setattr(transport_module.httpx, "AsyncClient", FakeHTTPClient)
    client = SimpleNamespace(
        get_access_token=lambda: "access-token",
        credential=SimpleNamespace(client_id="ding-app-key"),
    )
    transport = DingTalkCardTransport(client)

    created = await transport.create_and_deliver(
        out_track_id="card-1",
        template_id="settings.schema",
        space=DingTalkCardSpace("IM_GROUP", "conversation-1"),
        card_data={"showTask": False, "options": []},
    )

    assert created is True
    assert captured["url"].endswith("/v1.0/card/instances/createAndDeliver")
    assert captured["payload"]["callbackType"] == "STREAM"
    assert captured["payload"]["userIdType"] == 1
    assert captured["payload"]["openSpaceId"] == "dtv1.card//IM_GROUP.conversation-1"
    assert captured["payload"]["imGroupOpenDeliverModel"]["robotCode"] == (
        "ding-app-key"
    )
    assert captured["payload"]["cardData"]["cardParamMap"] == {
        "showTask": "false",
        "options": "[]",
    }
