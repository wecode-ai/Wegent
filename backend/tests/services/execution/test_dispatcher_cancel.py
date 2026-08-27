# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.execution.dispatcher import ExecutionDispatcher
from app.services.execution.router import CommunicationMode, ExecutionTarget
from shared.models import EventType, ExecutionRequest


class _BlockingCreate:
    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.cancelled = asyncio.Event()

    async def wait(self) -> None:
        self.started.set()
        try:
            await asyncio.Future()
        except asyncio.CancelledError:
            self.cancelled.set()
            raise


class _CancellationResistantCreate(_BlockingCreate):
    async def wait(self) -> None:
        self.started.set()
        try:
            await asyncio.Future()
        except asyncio.CancelledError:
            self.cancelled.set()


class _BlockingStream:
    def __init__(self) -> None:
        self.iteration_started = asyncio.Event()
        self.iteration_cancelled = asyncio.Event()
        self.closed = asyncio.Event()

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        await self.close()
        return False

    async def close(self) -> None:
        self.closed.set()

    def __aiter__(self):
        return self

    async def __anext__(self):
        self.iteration_started.set()
        try:
            await asyncio.Future()
        except asyncio.CancelledError:
            self.iteration_cancelled.set()
            raise


def _build_fake_openai_module(
    stream: _BlockingStream,
    create_blocker: _BlockingCreate | None = None,
):
    class _FakeResponses:
        async def create(self, **kwargs):
            if create_blocker:
                await create_blocker.wait()
            return stream

    class _FakeAsyncOpenAI:
        def __init__(self, **kwargs):
            self.responses = _FakeResponses()

    return SimpleNamespace(AsyncOpenAI=_FakeAsyncOpenAI)


def _make_sse_request(subtask_id: int):
    return SimpleNamespace(
        task_id=101,
        subtask_id=subtask_id,
        message_id=201,
        bot=[],
        model_config={},
        request_id="request-id",
    )


def _sse_target() -> ExecutionTarget:
    return ExecutionTarget(
        mode=CommunicationMode.SSE,
        url="http://chat-shell",
        namespace=None,
        event="task:execute",
        room=None,
    )


@pytest.mark.asyncio
async def test_cancel_http_targets_known_executor() -> None:
    http_client = AsyncMock()
    http_client.post.return_value = MagicMock(status_code=200)

    with patch(
        "app.services.execution.dispatcher.traced_async_client",
        return_value=http_client,
    ):
        dispatcher = ExecutionDispatcher()

    request = ExecutionRequest(
        task_id=101,
        subtask_id=55,
        executor_name="wegent-task-test",
    )
    target = ExecutionTarget(
        mode=CommunicationMode.HTTP_CALLBACK,
        url="http://executor-manager/executor-manager",
    )

    result = await dispatcher._cancel_http(request, target)

    assert result is True
    http_client.post.assert_awaited_once_with(
        "http://executor-manager/executor-manager/v1/cancel",
        json={
            "task_id": 101,
            "subtask_id": 55,
            "executor_name": "wegent-task-test",
        },
    )


@pytest.mark.asyncio
async def test_cancel_http_omits_empty_executor_name_for_discovery() -> None:
    http_client = AsyncMock()
    http_client.post.return_value = MagicMock(status_code=200)

    with patch(
        "app.services.execution.dispatcher.traced_async_client",
        return_value=http_client,
    ):
        dispatcher = ExecutionDispatcher()

    request = ExecutionRequest(task_id=101, subtask_id=55, executor_name="")
    target = ExecutionTarget(
        mode=CommunicationMode.HTTP_CALLBACK,
        url="http://executor-manager/executor-manager",
    )

    result = await dispatcher._cancel_http(request, target)

    assert result is True
    http_client.post.assert_awaited_once_with(
        "http://executor-manager/executor-manager/v1/cancel",
        json={"task_id": 101, "subtask_id": 55},
    )


@pytest.mark.asyncio
async def test_dispatch_sse_cancels_while_opening_stream() -> None:
    dispatcher = ExecutionDispatcher()
    request = _make_sse_request(subtask_id=56)
    emitter = AsyncMock()
    stream = _BlockingStream()
    create_blocker = _BlockingCreate()
    cancel_event = asyncio.Event()
    session_manager = AsyncMock()
    session_manager.register_stream.return_value = cancel_event
    session_manager.is_cancelled.return_value = False

    with (
        patch.dict(
            "sys.modules",
            {
                "openai": _build_fake_openai_module(
                    stream,
                    create_blocker=create_blocker,
                )
            },
        ),
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
        dispatch_task = asyncio.create_task(
            dispatcher._dispatch_sse(request, _sse_target(), emitter)
        )
        await asyncio.wait_for(create_blocker.started.wait(), timeout=1)
        cancel_event.set()
        await asyncio.wait_for(dispatch_task, timeout=1)

    assert create_blocker.cancelled.is_set()
    emitted_events = [call.args[0] for call in emitter.emit.call_args_list]
    assert [event.type for event in emitted_events] == [EventType.CANCELLED.value]
    session_manager.unregister_stream.assert_awaited_once_with(request.subtask_id)


@pytest.mark.asyncio
async def test_dispatch_sse_closes_stream_opened_during_cancellation() -> None:
    dispatcher = ExecutionDispatcher()
    request = _make_sse_request(subtask_id=58)
    emitter = AsyncMock()
    stream = _BlockingStream()
    create_blocker = _CancellationResistantCreate()
    cancel_event = asyncio.Event()
    session_manager = AsyncMock()
    session_manager.register_stream.return_value = cancel_event
    session_manager.is_cancelled.return_value = False

    with (
        patch.dict(
            "sys.modules",
            {
                "openai": _build_fake_openai_module(
                    stream,
                    create_blocker=create_blocker,
                )
            },
        ),
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
        dispatch_task = asyncio.create_task(
            dispatcher._dispatch_sse(request, _sse_target(), emitter)
        )
        await asyncio.wait_for(create_blocker.started.wait(), timeout=1)
        cancel_event.set()
        await asyncio.wait_for(dispatch_task, timeout=1)

    assert create_blocker.cancelled.is_set()
    assert stream.closed.is_set()
    emitted_events = [call.args[0] for call in emitter.emit.call_args_list]
    assert [event.type for event in emitted_events] == [EventType.CANCELLED.value]
    session_manager.unregister_stream.assert_awaited_once_with(request.subtask_id)


@pytest.mark.asyncio
async def test_dispatch_sse_cancels_while_waiting_for_event() -> None:
    dispatcher = ExecutionDispatcher()
    request = _make_sse_request(subtask_id=59)
    emitter = AsyncMock()
    stream = _BlockingStream()
    redis_cancelled = asyncio.Event()
    session_manager = AsyncMock()
    session_manager.register_stream.return_value = asyncio.Event()
    session_manager.is_cancelled.side_effect = (
        lambda subtask_id: redis_cancelled.is_set()
    )

    with (
        patch.dict("sys.modules", {"openai": _build_fake_openai_module(stream)}),
        patch(
            "app.services.execution.dispatcher.OpenAIRequestConverter.from_execution_request",
            return_value={
                "model": "test-model",
                "input": "hello",
                "metadata": {},
                "model_config": {},
            },
        ),
        patch(
            "app.services.execution.dispatcher._SSE_CANCEL_POLL_INTERVAL_SECONDS",
            0.01,
        ),
        patch("app.services.chat.storage.session.session_manager", session_manager),
    ):
        dispatch_task = asyncio.create_task(
            dispatcher._dispatch_sse(request, _sse_target(), emitter)
        )
        await asyncio.wait_for(stream.iteration_started.wait(), timeout=1)
        redis_cancelled.set()
        await asyncio.wait_for(dispatch_task, timeout=1)

    assert stream.iteration_cancelled.is_set()
    emitted_events = [call.args[0] for call in emitter.emit.call_args_list]
    assert [event.type for event in emitted_events] == [EventType.CANCELLED.value]
    session_manager.unregister_stream.assert_awaited_once_with(request.subtask_id)
