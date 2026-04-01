# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for SSE request_id propagation from backend to chat_shell."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from app.services.execution.dispatcher import ExecutionDispatcher
from app.services.execution.router import CommunicationMode, ExecutionTarget


class _FakeEvent:
    def __init__(self, event_type: str):
        self.type = event_type

    def model_dump(self):
        return {
            "type": self.type,
            "response": {"output": []},
        }


class _FakeStream:
    def __init__(self, events):
        self._events = list(events)

    def __aiter__(self):
        return self

    async def __anext__(self):
        if not self._events:
            raise StopAsyncIteration
        return self._events.pop(0)


def _build_fake_openai_module(calls: dict):
    class _FakeResponses:
        async def create(
            self,
            model,
            input,
            instructions,
            tools,
            stream,
            extra_body,
        ):
            calls["model"] = model
            calls["input"] = input
            calls["instructions"] = instructions
            calls["tools"] = tools
            calls["stream"] = stream
            calls["extra_body"] = extra_body
            return _FakeStream([_FakeEvent("response.completed")])

    class _FakeAsyncOpenAI:
        def __init__(self, **kwargs):
            calls["client_kwargs"] = kwargs
            self.responses = _FakeResponses()

    return SimpleNamespace(AsyncOpenAI=_FakeAsyncOpenAI)


def _make_request(subtask_id: int, request_id: str = ""):
    return SimpleNamespace(
        task_id=1001,
        subtask_id=subtask_id,
        message_id=2002,
        bot=[],
        model_config={},
        request_id=request_id,
    )


@pytest.mark.asyncio
async def test_dispatch_sse_keeps_existing_metadata_request_id():
    dispatcher = ExecutionDispatcher()
    request = _make_request(subtask_id=99, request_id="backend-request-id")
    target = ExecutionTarget(
        mode=CommunicationMode.SSE,
        url="http://chat-shell",
        namespace=None,
        event="task:execute",
        room=None,
    )
    emitter = AsyncMock()
    calls = {}
    session_manager = AsyncMock()
    session_manager.register_stream.return_value = asyncio.Event()
    session_manager.is_cancelled.return_value = False

    with (
        patch.dict("sys.modules", {"openai": _build_fake_openai_module(calls)}),
        patch(
            "app.services.execution.dispatcher.OpenAIRequestConverter.from_execution_request",
            return_value={
                "model": "test-model",
                "input": "hello",
                "metadata": {"request_id": "metadata-request-id"},
                "model_config": {},
            },
        ),
        patch("app.services.chat.storage.session.session_manager", session_manager),
    ):
        await dispatcher._dispatch_sse(request, target, emitter)

    assert calls["extra_body"]["metadata"]["request_id"] == "metadata-request-id"


@pytest.mark.asyncio
async def test_dispatch_sse_uses_request_request_id_when_metadata_missing():
    dispatcher = ExecutionDispatcher()
    request = _make_request(subtask_id=99, request_id="backend-request-id")
    target = ExecutionTarget(
        mode=CommunicationMode.SSE,
        url="http://chat-shell",
        namespace=None,
        event="task:execute",
        room=None,
    )
    emitter = AsyncMock()
    calls = {}
    session_manager = AsyncMock()
    session_manager.register_stream.return_value = asyncio.Event()
    session_manager.is_cancelled.return_value = False

    with (
        patch.dict("sys.modules", {"openai": _build_fake_openai_module(calls)}),
        patch(
            "app.services.execution.dispatcher.OpenAIRequestConverter.from_execution_request",
            return_value={
                "model": "test-model",
                "input": "hello",
                "metadata": {},
                "model_config": {},
            },
        ),
        patch("app.services.chat.storage.session.session_manager", session_manager),
    ):
        await dispatcher._dispatch_sse(request, target, emitter)

    assert calls["extra_body"]["metadata"]["request_id"] == "backend-request-id"


@pytest.mark.asyncio
async def test_dispatch_sse_generates_request_id_when_missing():
    dispatcher = ExecutionDispatcher()
    request = _make_request(subtask_id=77, request_id="")
    target = ExecutionTarget(
        mode=CommunicationMode.SSE,
        url="http://chat-shell",
        namespace=None,
        event="task:execute",
        room=None,
    )
    emitter = AsyncMock()
    calls = {}
    session_manager = AsyncMock()
    session_manager.register_stream.return_value = asyncio.Event()
    session_manager.is_cancelled.return_value = False

    with (
        patch.dict("sys.modules", {"openai": _build_fake_openai_module(calls)}),
        patch(
            "app.services.execution.dispatcher.OpenAIRequestConverter.from_execution_request",
            return_value={
                "model": "test-model",
                "input": "hello",
                "metadata": {},
                "model_config": {},
            },
        ),
        patch("app.services.chat.storage.session.session_manager", session_manager),
    ):
        await dispatcher._dispatch_sse(request, target, emitter)

    assert calls["extra_body"]["metadata"]["request_id"] == "req_77"
