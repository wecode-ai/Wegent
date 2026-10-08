# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.api.endpoints.openapi_responses import (
    _create_streaming_response_unified,
    _iter_callback_events,
)
from app.api.ws import device_namespace
from app.schemas.openapi_response import ResponseCreateInput
from app.services.chat.storage import session_manager
from app.services.chat.trigger import unified
from app.services.execution import execution_dispatcher
from app.services.openapi import chat_session


@pytest.fixture
def device_callback_stream(monkeypatch):
    """Keep event parsing and callback serialization real; isolate external I/O."""
    messages = asyncio.Queue()

    async def publish(channel, payload):
        assert channel == "callback:channel:2"
        messages.put_nowait({"type": "message", "data": payload.encode()})
        return 1

    redis_client = SimpleNamespace(publish=publish, aclose=AsyncMock())
    monkeypatch.setattr(
        session_manager._cache, "_get_client", AsyncMock(return_value=redis_client)
    )

    async def get_message(**kwargs):
        return await messages.get()

    pubsub = SimpleNamespace(get_message=get_message, aclose=AsyncMock())
    namespace = device_namespace.DeviceNamespace()
    monkeypatch.setattr(
        namespace,
        "get_session",
        AsyncMock(return_value={"user_id": 7, "device_id": "device-test"}),
    )
    monkeypatch.setattr(device_namespace, "run_sync_in_executor", AsyncMock())
    monkeypatch.setattr(device_namespace, "emit_response_api_event", AsyncMock())
    emitter = SimpleNamespace(emit=AsyncMock(), close=AsyncMock())
    monkeypatch.setattr(
        device_namespace, "WebSocketResultEmitter", lambda **kwargs: object()
    )
    monkeypatch.setattr(
        device_namespace, "StatusUpdatingEmitter", lambda **kwargs: emitter
    )
    monkeypatch.setattr(
        device_namespace, "forward_event_to_channel_callbacks", AsyncMock()
    )
    monkeypatch.setattr(namespace, "_publish_task_completed_event", AsyncMock())
    return SimpleNamespace(
        namespace=namespace, pubsub=pubsub, messages=messages, redis_client=redis_client
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("terminal_event", "terminal_data", "expected_type"),
    [
        ("response.completed", {"response": {"output": []}}, "done"),
        ("error", {"message": "runtime failed", "code": "runtime_error"}, "error"),
        ("response.incomplete", {"response": {"status": "incomplete"}}, "cancelled"),
    ],
)
async def test_device_events_reach_openapi_callback_stream(
    device_callback_stream, terminal_event, terminal_data, expected_type
):
    stream = device_callback_stream
    for event_type, data in [
        ("response.output_text.delta", {"delta": "hello"}),
        (terminal_event, terminal_data),
    ]:
        result = await stream.namespace._handle_responses_api_event(
            "sid-test",
            event_type,
            {"task_id": 1, "subtask_id": 2, "message_id": 3, "data": data},
        )
        assert result == {"success": True}

    assert stream.messages.qsize() == 2, "Device events must reach the callback channel"

    async def collect():
        return [
            event
            async for event in _iter_callback_events(stream.pubsub, asyncio.Event())
        ]

    events = await asyncio.wait_for(collect(), timeout=1)
    assert [event.type for event in events] == ["chunk", expected_type]
    assert events[0].content == "hello"
    assert all(event.message_id == 3 for event in events)
    if expected_type == "error":
        assert events[-1].error == "runtime failed"
    assert 2 not in stream.namespace._subtask_locks


@pytest.mark.asyncio
async def test_device_lifecycle_event_does_not_publish_callback(device_callback_stream):
    stream = device_callback_stream
    result = await stream.namespace._handle_responses_api_event(
        "sid-test",
        "response.in_progress",
        {"task_id": 1, "subtask_id": 2, "data": {}},
    )

    assert result == {"success": True}
    assert stream.messages.empty()


@pytest.mark.asyncio
@pytest.mark.parametrize("shell_type", ["Chat", "ClaudeCode"])
async def test_device_follow_up_stream_returns_text_and_completes(
    device_callback_stream, monkeypatch, shell_type
):
    """Consume the actual OpenAPI SSE body using events from the device handler."""
    stream = device_callback_stream
    setup = SimpleNamespace(
        task=SimpleNamespace(id=1, json={"spec": {"device_id": "device-test"}}),
        task_id=1,
        user_subtask=SimpleNamespace(id=3),
        assistant_subtask=SimpleNamespace(id=2),
    )
    execution_request = SimpleNamespace(
        task_id=1,
        subtask_id=2,
        user={"id": 7},
        bot=[{"shell_type": shell_type}],
        model_config={"modelType": "llm"},
    )
    monkeypatch.setattr(chat_session, "setup_chat_session", lambda *a, **kw: setup)
    monkeypatch.setattr(
        unified, "build_execution_request", AsyncMock(return_value=execution_request)
    )

    async def subscribe(channel):
        assert channel == "callback:channel:2"
        return stream.redis_client, stream.pubsub

    monkeypatch.setattr(session_manager._cache, "subscribe", subscribe)
    for method in [
        "register_stream",
        "is_cancelled",
        "unregister_stream",
        "delete_streaming_content",
    ]:
        return_value = asyncio.Event() if method == "register_stream" else False
        monkeypatch.setattr(
            session_manager, method, AsyncMock(return_value=return_value)
        )

    async def dispatch(request, *, device_id, emitter):
        assert device_id == "device-test"
        assert emitter is None
        for event_type, data in [
            ("response.output_text.delta", {"delta": "hello"}),
            ("response.completed", {"response": {"output": []}}),
        ]:
            await stream.namespace._handle_responses_api_event(
                "sid-test",
                event_type,
                {"task_id": 1, "subtask_id": 2, "message_id": 3, "data": data},
            )

    monkeypatch.setattr(execution_dispatcher, "dispatch", dispatch)
    response = await _create_streaming_response_unified(
        db=SimpleNamespace(rollback=lambda: None, close=lambda: None),
        user=SimpleNamespace(id=7, user_name="test-user"),
        team=SimpleNamespace(user_id=7),
        model_info={"namespace": "default", "team_name": "test-team"},
        request_body=ResponseCreateInput(
            model="default#test-team",
            input="follow-up",
            stream=True,
            previous_response_id="resp_1",
        ),
        input_text="follow-up",
        tool_settings={},
        task_id=1,
        device_id="device-test",
    )

    async def collect():
        return "".join([chunk async for chunk in response.body_iterator])

    body = await asyncio.wait_for(collect(), timeout=1)
    events = [
        json.loads(line.removeprefix("data: "))
        for line in body.splitlines()
        if line.startswith("data: {")
    ]
    text_events = [
        event for event in events if event["type"] == "response.output_text.delta"
    ]
    assert [event["delta"] for event in text_events] == ["hello"]
    assert events[-1]["type"] == "response.completed"
    assert events[-1]["response"]["previous_response_id"] == "resp_1"
    stream.pubsub.aclose.assert_awaited_once()
