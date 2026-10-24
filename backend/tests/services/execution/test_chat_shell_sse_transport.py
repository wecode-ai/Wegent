# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Exercise the SDK and SSE dispatcher together across failures and cancellation."""

import asyncio
import logging
from contextlib import asynccontextmanager
from dataclasses import replace
from unittest.mock import AsyncMock, call, patch

import httpx
import pytest
from openai import APIConnectionError, AsyncOpenAI

from app.services.execution.chat_shell_client import ChatShellClientPool
from app.services.execution.dispatcher import ExecutionDispatcher
from app.services.execution.router import CommunicationMode, ExecutionTarget
from shared.models import EventType, ExecutionEvent, ExecutionRequest

_COMPLETED = b'data: {"type":"response.completed","response":{"output":[]}}\n\n'
_DELTA = b'data: {"type":"response.output_text.delta","delta":"partial"}\n\n'


@asynccontextmanager
async def _environment(handler):
    client = AsyncOpenAI(
        base_url="http://chat-shell/v1",
        api_key="test",
        max_retries=0,
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    pool = ChatShellClientPool()
    session_manager = AsyncMock()
    session_manager.register_stream.return_value = asyncio.Event()
    session_manager.is_cancelled.return_value = False
    request = ExecutionRequest(task_id=101, subtask_id=202, message_id=303)
    target = ExecutionTarget(mode=CommunicationMode.SSE, url="http://chat-shell")
    dispatcher = ExecutionDispatcher()
    try:
        with (
            patch("app.services.execution.chat_shell_sse.chat_shell_clients", pool),
            patch(
                "app.services.execution.chat_shell_client._build_client",
                return_value=client,
            ),
            patch("app.services.chat.storage.session.session_manager", session_manager),
            patch(
                "app.services.execution.chat_shell_sse.OpenAIRequestConverter.from_execution_request",
                return_value={"model": "test-model", "input": "hello"},
            ),
        ):
            async with pool.lifespan():
                yield dispatcher, request, target, client, session_manager
        assert client.is_closed()
    finally:
        await client.close()
        await dispatcher.http_client.aclose()


class _BrokenStream(httpx.AsyncByteStream):
    def __init__(self, emit_delta: bool):
        self.emit_delta = emit_delta
        self.closed = False

    async def __aiter__(self):
        if self.emit_delta:
            yield _DELTA
        raise httpx.ReadError("connection reset during response")

    async def aclose(self):
        self.closed = True


@pytest.mark.asyncio
@pytest.mark.parametrize("emit_delta", [False, True])
async def test_stream_read_failure_is_not_replayed(emit_delta, caplog) -> None:
    body = _BrokenStream(emit_delta)
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(
            200, headers={"content-type": "text/event-stream"}, stream=body
        )

    emitter = AsyncMock()
    caplog.set_level(logging.INFO)
    async with _environment(handler) as (dispatcher, request, target, client, session):
        with pytest.raises(httpx.ReadError, match="connection reset"):
            await dispatcher._dispatch_sse(request, target, emitter)

        assert len(calls) == 1
        assert body.closed
        assert not client.is_closed()
        emitter.emit_start.assert_awaited_once()
        session.unregister_stream.assert_awaited_once_with(request.subtask_id)
        assert '"stage": "stream"' in caplog.text
        assert f'"events_received": {int(emit_delta)}' in caplog.text
        if emit_delta:
            assert emitter.emit.await_args.args[0].content == "partial"


class _SilentStream(httpx.AsyncByteStream):
    def __init__(self):
        self.started = asyncio.Event()
        self.closed = False

    async def __aiter__(self):
        self.started.set()
        await asyncio.Future()
        yield b""

    async def aclose(self):
        self.closed = True


@pytest.mark.asyncio
async def test_cancelled_response_does_not_close_shared_client() -> None:
    body = _SilentStream()
    calls = []

    def handler(request):
        calls.append(request)
        if len(calls) == 1:
            return httpx.Response(
                200, headers={"content-type": "text/event-stream"}, stream=body
            )
        return httpx.Response(
            200, headers={"content-type": "text/event-stream"}, content=_COMPLETED
        )

    async with _environment(handler) as (dispatcher, request, target, client, session):
        task = asyncio.create_task(
            dispatcher._dispatch_sse(request, target, AsyncMock())
        )
        try:
            await asyncio.wait_for(body.started.wait(), timeout=2)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

        assert body.closed
        assert not client.is_closed()
        emitter = AsyncMock()
        await dispatcher._dispatch_sse(request, target, emitter)
        assert len(calls) == 2
        assert emitter.emit.await_args.args[0].type == EventType.DONE.value
        assert session.unregister_stream.await_count == 2


@pytest.mark.asyncio
async def test_start_event_failure_unregisters_stream() -> None:
    handler = AsyncMock()
    emitter = AsyncMock()
    emitter.emit_start.side_effect = RuntimeError("start failed")

    async with _environment(handler) as (dispatcher, request, target, client, session):
        with pytest.raises(RuntimeError, match="start failed"):
            await dispatcher._dispatch_sse(request, target, emitter)

        handler.assert_not_called()
        session.unregister_stream.assert_awaited_once_with(request.subtask_id)
        assert not client.is_closed()


@pytest.mark.asyncio
async def test_exhausted_dispatch_emits_one_classified_terminal_error() -> None:
    calls = []

    def handler(request):
        calls.append(request)
        raise httpx.ConnectError("connection refused", request=request)

    wrapped_emitter = AsyncMock()
    async with _environment(handler) as (dispatcher, request, target, _client, session):
        with (
            patch.object(dispatcher.router, "route", return_value=target),
            patch.object(dispatcher, "_recover_executor_if_needed", AsyncMock()),
            patch.object(dispatcher, "_update_subtask_to_running", AsyncMock()),
            patch(
                "app.services.execution.dispatcher.StatusUpdatingEmitter",
                return_value=wrapped_emitter,
            ),
            patch(
                "app.services.execution.chat_shell_client.random.uniform",
                return_value=0.0,
            ),
        ):
            with pytest.raises(APIConnectionError) as failure:
                await dispatcher.dispatch(request, emitter=AsyncMock())

        assert len(calls) == 3
        wrapped_emitter.emit_error.assert_awaited_once_with(
            task_id=request.task_id,
            subtask_id=request.subtask_id,
            error="Connection error.",
            error_code="network_error",
        )
        wrapped_emitter.close.assert_awaited_once()
        assert failure.value._frontend_error_emitted is True
        session.unregister_stream.assert_awaited_once_with(request.subtask_id)


class _UnfinishedTerminalStream(httpx.AsyncByteStream):
    def __init__(self, failure: str, first_byte_delay: float = 0) -> None:
        self.failure = failure
        self.first_byte_delay = first_byte_delay
        self.closed = False
        self.tail_started = asyncio.Event()

    async def __aiter__(self):
        if self.first_byte_delay:
            await asyncio.sleep(self.first_byte_delay)
        yield _COMPLETED
        self.tail_started.set()
        if self.failure == "read_error":
            raise httpx.ReadError("reset after terminal event")
        await asyncio.Future()

    async def aclose(self):
        self.closed = True


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failure,first_byte_delay",
    [("timeout", 0), ("read_error", 0), ("cancel", 0), ("cancel", 2.1)],
)
async def test_terminal_cleanup_preserves_completion(
    failure: str, first_byte_delay: float
) -> None:
    body = _UnfinishedTerminalStream(failure, first_byte_delay)
    requests = []

    def handler(request):
        requests.append(request)
        if len(requests) > 1:
            return httpx.Response(
                200, headers={"content-type": "text/event-stream"}, content=_COMPLETED
            )
        return httpx.Response(
            200, headers={"content-type": "text/event-stream"}, stream=body
        )

    terminal_delivered = asyncio.Event()

    async def record_terminal(event: ExecutionEvent) -> None:
        if event.type == EventType.DONE.value:
            terminal_delivered.set()

    emitter = AsyncMock()
    emitter.emit.side_effect = record_terminal
    async with _environment(handler) as (dispatcher, request, target, client, session):
        with patch(
            "app.services.execution.chat_shell_sse._SSE_TERMINAL_DRAIN_TIMEOUT_SECONDS",
            0.02 if failure == "timeout" else 1.0,
        ):
            task = asyncio.create_task(
                dispatcher._dispatch_sse(request, target, emitter)
            )
            try:
                # Request startup and SDK decoding precede the cleanup under test.
                # Keep the original two-second bounds on the terminal drain itself.
                await asyncio.wait_for(terminal_delivered.wait(), timeout=30)
                if failure == "cancel":
                    tail_started = asyncio.create_task(body.tail_started.wait())
                    try:
                        await asyncio.wait_for(
                            asyncio.wait(
                                {task, tail_started},
                                return_when=asyncio.FIRST_COMPLETED,
                            ),
                            timeout=2,
                        )
                        if not body.tail_started.is_set():
                            await task
                            pytest.fail(
                                "Dispatch ended before terminal cleanup started"
                            )
                    finally:
                        tail_started.cancel()
                        await asyncio.gather(tail_started, return_exceptions=True)
                    task.cancel()
                await asyncio.wait_for(task, timeout=2)
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

        assert body.closed
        assert not client.is_closed()
        assert [call.args[0].type for call in emitter.emit.await_args_list] == [
            EventType.DONE.value
        ]
        emitter.emit_error.assert_not_awaited()
        session.unregister_stream.assert_awaited_once_with(request.subtask_id)

        next_request = replace(request, subtask_id=request.subtask_id + 1)
        next_emitter = AsyncMock()
        await asyncio.wait_for(
            dispatcher._dispatch_sse(next_request, target, next_emitter), timeout=30
        )

        assert len(requests) == 2
        assert not client.is_closed()
        assert [call.args[0].type for call in next_emitter.emit.await_args_list] == [
            EventType.DONE.value
        ]
        next_emitter.emit_error.assert_not_awaited()
        session.unregister_stream.assert_has_awaits(
            [call(request.subtask_id), call(next_request.subtask_id)]
        )
