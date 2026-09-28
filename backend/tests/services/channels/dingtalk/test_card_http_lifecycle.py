# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Card HTTP clients are reused during streaming and closed by every owner."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import httpx
import pytest

from app.schemas.dingtalk_card import DingTalkChatCardConfig
from app.services.channels.dingtalk import card_transport
from app.services.channels.dingtalk.card_binding import CardBinding
from app.services.channels.dingtalk.card_follow_up import DingTalkCardCallbackHandler
from app.services.channels.dingtalk.card_inbox import CardActionRecord
from app.services.channels.dingtalk.emitter import StreamingResponseEmitter
from app.services.channels.dingtalk.handler import DingTalkChannelHandler


@pytest.mark.asyncio
@pytest.mark.parametrize("flush_fails", [False, True])
async def test_stream_reuses_http_client_and_closes_after_flush(
    monkeypatch, httpx_mock, flush_fails
):
    """Connection reuse survives multiple updates and cleanup survives flush errors."""
    clients = []
    client_class = httpx.AsyncClient

    def create_client(**kwargs):
        client = client_class(**kwargs)
        clients.append(client)
        return client

    monkeypatch.setattr(card_transport.httpx, "AsyncClient", create_client)
    emitter = StreamingResponseEmitter(
        SimpleNamespace(
            _access_token={"accessToken": "test-token", "expireTime": float("inf")}
        ),
        None,
        existing_card_instance_id="card-a",
        chat_card=DingTalkChatCardConfig(template_id="test.schema"),
    )
    emitter.MIN_UPDATE_INTERVAL = 0
    httpx_mock.add_response(json={"success": True})
    httpx_mock.add_response(json={"success": True})
    try:
        assert await emitter._write_card("first")
        assert await emitter._write_card("first second")
        assert len(clients) == 1

        async def flush():
            assert not clients[0].is_closed
            if flush_fails:
                raise RuntimeError("flush failed")

        monkeypatch.setattr(emitter, "flush", flush)
        if flush_fails:
            with pytest.raises(RuntimeError, match="flush failed"):
                await emitter.close()
        else:
            await emitter.close()
        assert clients[0].is_closed
    finally:
        for client in clients:
            await client.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("status_code", [200, 403])
async def test_status_only_adapter_closes_http_client(
    monkeypatch, httpx_mock, status_code
):
    """Short-lived follow-up status requests release their client on failure too."""
    client = httpx.AsyncClient()
    monkeypatch.setattr(card_transport.httpx, "AsyncClient", lambda **kwargs: client)
    config = DingTalkChatCardConfig(
        template_id="test.schema", follow_up_status_key="sendState"
    )
    binding = CardBinding(
        channel_id=77,
        user_id=9,
        task_id=101,
        subtask_id=42,
        config=config,
        incoming_data={},
    )
    record = CardActionRecord(
        binding=binding,
        track_id="card-a",
        event_id="event-a",
        text="next",
        image_urls=[],
    )
    handler = SimpleNamespace(
        channel_id=77,
        _dingtalk_client=SimpleNamespace(
            _access_token={"accessToken": "test-token", "expireTime": float("inf")}
        ),
    )
    receiver = DingTalkCardCallbackHandler(handler)
    httpx_mock.add_response(
        status_code=status_code, json={"success": status_code == 200}
    )
    try:
        if status_code == 200:
            await receiver._update_status(record, "sent")
        else:
            with pytest.raises(RuntimeError, match="HTTP 403"):
                await receiver._update_status(record, "sent")
        assert client.is_closed
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_failed_card_registration_closes_emitter(monkeypatch):
    """A card that cannot be bound never enters the registry's cleanup lifecycle."""
    handler = DingTalkChannelHandler(channel_id=77)
    monkeypatch.setattr(
        handler,
        "_bind_chat_card",
        AsyncMock(side_effect=RuntimeError("binding failed")),
    )
    monkeypatch.setattr(handler, "_fail_unstarted_card_task", AsyncMock())
    monkeypatch.setattr(handler, "send_text_reply", AsyncMock())
    emitter = SimpleNamespace(chat_card=object(), subtask_id=42, close=AsyncMock())

    with pytest.raises(RuntimeError, match="binding failed"):
        await handler._register_streaming_emitter(101, emitter, object())

    emitter.close.assert_awaited_once()
