# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Request correlation starts at the DingTalk Stream callback boundary."""

import asyncio
import logging
import re
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest
from dingtalk_stream import AckMessage, CallbackMessage

from app.core.logging import RequestIdFilter
from app.services.channels.dingtalk.handler import WegentChatbotHandler
from shared.telemetry.context import span
from shared.utils.http_client import traced_async_client


@pytest.fixture(autouse=True)
def isolated_request_context(monkeypatch, caplog):
    token = span._request_id_var.set(None)
    request_filter = RequestIdFilter()
    caplog.handler.addFilter(request_filter)
    caplog.set_level(logging.INFO)
    monkeypatch.setattr(
        "app.services.channels.dingtalk.handler.cache_manager.setnx",
        AsyncMock(return_value=True),
    )
    try:
        yield
    finally:
        caplog.handler.removeFilter(request_filter)
        span._request_id_var.reset(token)


def _callback(message_id: str = "message-1", headers=None) -> CallbackMessage:
    callback = CallbackMessage()
    callback.headers.extensions = headers or {}
    callback.data = {
        "msgId": message_id,
        "msgtype": "text",
        "text": {"content": "hello"},
        "senderNick": "Alice",
    }
    return callback


@pytest.mark.asyncio
@pytest.mark.parametrize("custom_callback", [False, True])
@pytest.mark.parametrize("incoming_id", [None, "upstream-request-1"])
async def test_ingress_logs_and_outbound_request_share_id(
    custom_callback, incoming_id, monkeypatch, caplog
):
    observed = {}

    async def receive(*args):
        observed["id"] = span.get_request_id()
        observed["thread_id"] = await asyncio.to_thread(span.get_request_id)

        def respond(request: httpx.Request) -> httpx.Response:
            observed["header"] = request.headers["X-Request-ID"]
            return httpx.Response(200)

        async with traced_async_client(
            transport=httpx.MockTransport(respond)
        ) as client:
            await client.get("http://backend/api/internal/chat/history/task-1")

    handler = WegentChatbotHandler(on_message=receive if custom_callback else None)
    if not custom_callback:
        monkeypatch.setattr(handler, "_process_with_channel_handler", receive)
    headers = {"x-ReQuEsT-Id": f" {incoming_id} "} if incoming_id else {}

    # Stream tasks can inherit the request that started the channel.
    span.set_request_context("channel-start-request")
    result = await handler.process(_callback(headers=headers))

    assert result == (AckMessage.STATUS_OK, "OK")
    request_id = observed["id"]
    if incoming_id:
        assert request_id == incoming_id
    else:
        assert re.fullmatch(r"[0-9a-f]{8}", request_id)
    assert observed["header"] == observed["thread_id"] == request_id
    received = next(r for r in caplog.records if "Received message:" in r.getMessage())
    assert received.request_id == request_id
    assert span.get_request_id() == "channel-start-request"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "unsafe_id",
    ["req\ninjected", "req\rinjected", "req\tinjected", "req\x00", "req\x7f"],
)
async def test_callback_rejects_request_ids_with_control_characters(unsafe_id):
    observed = []

    async def receive(context):
        observed.append(span.get_request_id())

    handler = WegentChatbotHandler(on_message=receive)
    result = await handler.process(_callback(headers={"X-Request-ID": unsafe_id}))

    assert result == (AckMessage.STATUS_OK, "OK")
    assert re.fullmatch(r"[0-9a-f]{8}", observed[0])


@pytest.mark.asyncio
async def test_generated_id_reaches_execution_request(monkeypatch):
    from app.services.chat.trigger import unified
    from shared.models import ExecutionRequest

    builder = MagicMock()
    builder.build.return_value = ExecutionRequest(task_id=1, subtask_id=2)
    monkeypatch.setattr(unified, "SessionLocal", MagicMock())
    monkeypatch.setattr("app.services.execution.TaskRequestBuilder", lambda db: builder)
    observed = {}

    async def receive(context):
        observed["id"] = span.get_request_id()
        observed["request"] = await unified.build_execution_request(
            task=MagicMock(id=1, json={}),
            assistant_subtask=MagicMock(id=2),
            team=MagicMock(),
            user=MagicMock(id=7),
            message=context["content"],
        )

    result = await WegentChatbotHandler(on_message=receive).process(_callback())

    assert result == (AckMessage.STATUS_OK, "OK")
    assert observed["request"].request_id == observed["id"]
    assert observed["id"] != "req_2"
    assert span.get_request_id() is None


@pytest.mark.asyncio
async def test_concurrent_and_sequential_messages_have_independent_ids():
    observed = {}
    ready = asyncio.Event()

    async def receive(context):
        message_id = context["callback_data"]["msgId"]
        request_id = span.get_request_id()
        observed[message_id] = request_id
        if len(observed) >= 2:
            ready.set()
        await ready.wait()
        assert span.get_request_id() == request_id

    handler = WegentChatbotHandler(on_message=receive)
    await asyncio.wait_for(
        asyncio.gather(
            handler.process(_callback("a")), handler.process(_callback("b"))
        ),
        timeout=2,
    )
    await handler.process(_callback("c", {"X-Request-ID": " "}))

    assert len(set(observed.values())) == 3
    assert all(re.fullmatch(r"[0-9a-f]{8}", value) for value in observed.values())
    assert span.get_request_id() is None


@pytest.mark.asyncio
@pytest.mark.parametrize("outcome", ["duplicate", "error", "parse_error", "cancel"])
async def test_context_is_restored_on_early_exit(outcome, monkeypatch, caplog):
    callback = _callback(headers={"X-Request-ID": "message-request"})
    handler = WegentChatbotHandler(on_message=AsyncMock())
    if outcome == "duplicate":
        monkeypatch.setattr(
            "app.services.channels.dingtalk.handler.cache_manager.setnx",
            AsyncMock(return_value=False),
        )
    elif outcome == "parse_error":
        callback.data = None
    else:
        handler._on_message.side_effect = (
            asyncio.CancelledError() if outcome == "cancel" else RuntimeError("failed")
        )

    if outcome == "cancel":
        with pytest.raises(asyncio.CancelledError):
            await handler.process(callback)
    else:
        result = await handler.process(callback)
        expected = (
            AckMessage.STATUS_OK
            if outcome == "duplicate"
            else AckMessage.STATUS_SYSTEM_EXCEPTION
        )
        assert result[0] == expected
    records = [r for r in caplog.records if "[DingTalkHandler]" in r.getMessage()]
    assert records
    assert all(r.request_id == "message-request" for r in records)
    assert span.get_request_id() is None


@pytest.mark.asyncio
async def test_background_work_retains_message_id_after_callback_returns():
    release = asyncio.Event()
    tasks = []
    observed = {}

    async def background():
        await release.wait()
        return span.get_request_id()

    async def receive(context):
        observed["id"] = span.get_request_id()
        tasks.append(asyncio.create_task(background()))

    try:
        result = await WegentChatbotHandler(on_message=receive).process(_callback())
        assert result == (AckMessage.STATUS_OK, "OK")
        assert span.get_request_id() is None
    finally:
        release.set()
        results = await asyncio.gather(*tasks)
    assert results == [observed["id"]]
