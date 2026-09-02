# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for Pod-local stream-worker IPC."""

import asyncio
import os
import stat
import tempfile
import threading
from pathlib import Path
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import orjson
import pytest

from app.core.shutdown import StreamAdmissionClosedError
from app.services.execution import stream_client as stream_client_module
from app.services.execution.dispatcher import ExecutionDispatcher
from app.services.execution.router import CommunicationMode, ExecutionTarget
from app.services.execution.stream_client import (
    StreamExecutionClient,
    StreamWorkerExecutionError,
    StreamWorkerUnavailableError,
    read_frame,
    write_frame,
)
from app.stream_worker import (
    LocalStreamServer,
    StatusOwningSSEDispatcher,
    _WorkerProjectionEmitter,
)
from shared.models import EventType, ExecutionEvent, ExecutionRequest


def _short_socket_path() -> Path:
    return Path(tempfile.gettempdir()) / (
        f"wegent-{os.getpid()}-{uuid4().hex[:8]}.sock"
    )


async def _wait_for_socket(socket_path: Path) -> None:
    for _ in range(100):
        if socket_path.exists():
            return
        await asyncio.sleep(0.01)
    raise TimeoutError(f"Socket was not created: {socket_path}")


def _encoded_frame(payload: dict) -> bytes:
    encoded = orjson.dumps(payload)
    return len(encoded).to_bytes(4, "big") + encoded


@pytest.mark.asyncio
async def test_dispatch_rejects_unavailable_local_worker() -> None:
    client = StreamExecutionClient(_short_socket_path())

    with pytest.raises(StreamWorkerUnavailableError):
        await client.dispatch(
            ExecutionRequest(task_id=10, subtask_id=11),
            AsyncMock(),
        )


@pytest.mark.asyncio
async def test_dispatch_times_out_while_connecting() -> None:
    async def never_connect(*args, **kwargs):
        del args, kwargs
        await asyncio.Future()

    client = StreamExecutionClient(
        _short_socket_path(),
        connect_timeout_seconds=0.01,
    )
    with (
        patch(
            "app.services.execution.stream_client.asyncio.open_unix_connection",
            never_connect,
        ),
        pytest.raises(StreamWorkerUnavailableError, match="Timed out connecting"),
    ):
        await client.dispatch(
            ExecutionRequest(task_id=10, subtask_id=11),
            AsyncMock(),
        )


@pytest.mark.asyncio
async def test_web_stream_admission_rejects_before_opening_a_socket() -> None:
    admission = stream_client_module._RPCAdmission(
        1,
        message="Web stream connection capacity exhausted",
        error_code="web_stream_overloaded",
    )
    admission.acquire()
    try:
        with pytest.raises(StreamWorkerExecutionError) as raised:
            await StreamExecutionClient(
                _short_socket_path(),
                stream_admission=admission,
            ).dispatch(
                ExecutionRequest(task_id=10, subtask_id=11),
                AsyncMock(),
            )
    finally:
        admission.release()

    assert raised.value.error_code == "web_stream_overloaded"


@pytest.mark.asyncio
async def test_web_stream_admission_is_released_after_connect_failure() -> None:
    admission = stream_client_module._RPCAdmission(
        1,
        message="Web stream connection capacity exhausted",
        error_code="web_stream_overloaded",
    )
    client = StreamExecutionClient(
        _short_socket_path(),
        stream_admission=admission,
    )

    for _ in range(2):
        with pytest.raises(StreamWorkerUnavailableError):
            await client.dispatch(
                ExecutionRequest(task_id=10, subtask_id=11),
                AsyncMock(),
            )


@pytest.mark.asyncio
async def test_ping_completes_real_worker_round_trip() -> None:
    socket_path = _short_socket_path()
    stop_event = asyncio.Event()

    class UnusedDispatcher:
        async def dispatch_worker_owned(self, request, emitter) -> None:
            raise AssertionError("ping must not dispatch a stream")

    server_task = asyncio.create_task(
        LocalStreamServer(socket_path, UnusedDispatcher()).run(stop_event)
    )
    await _wait_for_socket(socket_path)
    try:
        await StreamExecutionClient(socket_path).ping()
    finally:
        stop_event.set()
        await server_task


@pytest.mark.asyncio
async def test_server_socket_is_owner_only_and_removed_on_shutdown() -> None:
    socket_path = _short_socket_path()
    stop_event = asyncio.Event()

    class UnusedDispatcher:
        async def dispatch_worker_owned(self, request, emitter) -> None:
            raise AssertionError((request, emitter))

    server_task = asyncio.create_task(
        LocalStreamServer(socket_path, UnusedDispatcher()).run(stop_event)
    )
    await _wait_for_socket(socket_path)

    assert stat.S_IMODE(socket_path.stat().st_mode) == 0o600
    stop_event.set()
    await server_task
    assert not socket_path.exists()


@pytest.mark.asyncio
async def test_server_refuses_to_replace_non_socket_path() -> None:
    socket_path = _short_socket_path()
    socket_path.write_text("must-not-be-replaced", encoding="utf-8")

    class UnusedDispatcher:
        async def dispatch_worker_owned(self, request, emitter) -> None:
            raise AssertionError((request, emitter))

    with pytest.raises(RuntimeError, match="is not a socket"):
        await LocalStreamServer(socket_path, UnusedDispatcher()).run(asyncio.Event())

    assert socket_path.read_text(encoding="utf-8") == "must-not-be-replaced"
    socket_path.unlink()


@pytest.mark.asyncio
async def test_ping_times_out_when_socket_cannot_process_frames() -> None:
    socket_path = _short_socket_path()
    handler_finished = asyncio.Event()

    async def handle(reader, writer) -> None:
        assert await read_frame(reader) == {"type": "ping"}
        await reader.read()
        writer.close()
        await writer.wait_closed()
        handler_finished.set()

    server = await asyncio.start_unix_server(handle, path=socket_path)
    try:
        with pytest.raises(
            StreamWorkerExecutionError,
            match="ping timed out",
        ) as raised:
            await StreamExecutionClient(
                socket_path,
                first_frame_timeout_seconds=0.05,
            ).ping()
        await asyncio.wait_for(handler_finished.wait(), timeout=1)
    finally:
        server.close()
        await server.wait_closed()
        socket_path.unlink(missing_ok=True)

    assert raised.value.error_code == "stream_worker_timeout"


@pytest.mark.asyncio
async def test_ping_surfaces_worker_error() -> None:
    socket_path = _short_socket_path()

    async def handle(reader, writer) -> None:
        assert await read_frame(reader) == {"type": "ping"}
        await write_frame(
            writer,
            {
                "type": "error",
                "message": "worker is unhealthy",
                "error_code": "stream_worker_unhealthy",
            },
        )
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_unix_server(handle, path=socket_path)
    try:
        with pytest.raises(
            StreamWorkerExecutionError,
            match="worker is unhealthy",
        ) as raised:
            await StreamExecutionClient(socket_path).ping()
    finally:
        server.close()
        await server.wait_closed()
        socket_path.unlink(missing_ok=True)

    assert raised.value.error_code == "stream_worker_unhealthy"


@pytest.mark.asyncio
async def test_point_event_has_hard_response_timeout() -> None:
    socket_path = _short_socket_path()
    handler_finished = asyncio.Event()

    async def handle(reader, writer) -> None:
        envelope = await read_frame(reader)
        assert envelope["type"] == "point_callback"
        size = int.from_bytes(await reader.readexactly(4), "big")
        await reader.readexactly(size)
        await reader.read()
        writer.close()
        await writer.wait_closed()
        handler_finished.set()

    server = await asyncio.start_unix_server(handle, path=socket_path)
    try:
        with pytest.raises(StreamWorkerExecutionError) as raised:
            await StreamExecutionClient(
                socket_path,
                point_response_timeout_seconds=0.02,
            ).dispatch_callback_body(b"{}", batch=False)
        await asyncio.wait_for(handler_finished.wait(), timeout=1)
    finally:
        server.close()
        await server.wait_closed()
        socket_path.unlink(missing_ok=True)

    assert raised.value.error_code == "point_projection_timeout"


@pytest.mark.asyncio
async def test_dispatch_bridges_existing_request_and_event_models() -> None:
    socket_path = _short_socket_path()
    received_request: dict | None = None

    async def handle(reader, writer) -> None:
        nonlocal received_request
        received_request = await read_frame(reader)
        await write_frame(
            writer,
            {
                "type": "event",
                "event": ExecutionEvent(
                    type="chunk",
                    task_id=10,
                    subtask_id=11,
                    content="hello",
                ).to_dict(),
            },
        )
        await write_frame(
            writer,
            {
                "type": "terminal",
                "event": ExecutionEvent(
                    type="done",
                    task_id=10,
                    subtask_id=11,
                ).to_dict(),
            },
        )
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_unix_server(handle, path=socket_path)
    emitter = AsyncMock()
    request = ExecutionRequest(
        task_id=10,
        subtask_id=11,
        auth_token="local-secret",
    )
    try:
        await StreamExecutionClient(socket_path).dispatch(request, emitter)
    finally:
        server.close()
        await server.wait_closed()
        socket_path.unlink(missing_ok=True)

    assert received_request == {
        "type": "execute",
        "request": request.to_dict(),
        "project_to_web": True,
    }
    emitted = [call.args[0] for call in emitter.emit.await_args_list]
    assert [event.type for event in emitted] == ["chunk", "done"]
    assert emitted[0].content == "hello"
    emitter.close.assert_not_awaited()


@pytest.mark.asyncio
async def test_dispatch_encodes_request_before_opening_worker_socket(
    monkeypatch,
) -> None:
    socket_path = _short_socket_path()
    stop_event = asyncio.Event()

    class SlowCodecExecutor:
        def __init__(self) -> None:
            self._first_call = True

        async def run(self, func, *args):
            if self._first_call:
                self._first_call = False
                await asyncio.sleep(0.05)
            return func(*args)

    class CompletingDispatcher:
        async def dispatch_worker_owned(self, request, emitter) -> None:
            del request, emitter

    monkeypatch.setattr(
        stream_client_module,
        "_CODEC_EXECUTOR",
        SlowCodecExecutor(),
    )
    server_task = asyncio.create_task(
        LocalStreamServer(
            socket_path,
            CompletingDispatcher(),
            first_frame_timeout_seconds=0.02,
        ).run(stop_event)
    )
    await _wait_for_socket(socket_path)
    try:
        await StreamExecutionClient(socket_path).dispatch(
            ExecutionRequest(task_id=10, subtask_id=11),
            AsyncMock(),
        )
    finally:
        stop_event.set()
        await server_task


@pytest.mark.asyncio
async def test_worker_dispatch_completion_does_not_require_terminal_event() -> None:
    socket_path = _short_socket_path()
    stop_event = asyncio.Event()

    class CallbackDispatcher:
        async def dispatch_worker_owned(self, request, emitter) -> None:
            del request, emitter

    server_task = asyncio.create_task(
        LocalStreamServer(socket_path, CallbackDispatcher()).run(stop_event)
    )
    await _wait_for_socket(socket_path)
    emitter = AsyncMock()
    try:
        await StreamExecutionClient(socket_path).dispatch(
            ExecutionRequest(task_id=10, subtask_id=11),
            emitter,
        )
    finally:
        stop_event.set()
        await server_task

    emitter.emit.assert_not_awaited()


@pytest.mark.asyncio
async def test_worker_projection_survives_local_relay_disconnect() -> None:
    relay = AsyncMock()
    relay.emit.side_effect = BrokenPipeError("relay disconnected")
    websocket = AsyncMock()
    emitter = _WorkerProjectionEmitter(
        relay,
        websocket,
        task_id=10,
        subtask_id=11,
    )
    chunk = ExecutionEvent(type="chunk", task_id=10, subtask_id=11)
    done = ExecutionEvent(type="done", task_id=10, subtask_id=11)

    await emitter.emit(chunk)
    await emitter.emit(done)
    await emitter.close()

    assert [item.args[0] for item in websocket.emit.await_args_list] == [chunk, done]
    websocket.close.assert_awaited_once()
    relay.emit.assert_awaited_once_with(chunk)
    relay.close.assert_not_awaited()


@pytest.mark.asyncio
async def test_dispatch_surfaces_worker_failure() -> None:
    socket_path = _short_socket_path()

    async def handle(reader, writer) -> None:
        await read_frame(reader)
        await write_frame(
            writer,
            {
                "type": "error",
                "message": "upstream failed",
                "error_code": "rate_limit",
            },
        )
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_unix_server(handle, path=socket_path)
    try:
        with pytest.raises(
            StreamWorkerExecutionError,
            match="upstream failed",
        ) as raised:
            await StreamExecutionClient(socket_path).dispatch(
                ExecutionRequest(task_id=10, subtask_id=11),
                AsyncMock(),
            )
    finally:
        server.close()
        await server.wait_closed()
        socket_path.unlink(missing_ok=True)

    assert raised.value.error_code == "rate_limit"


@pytest.mark.asyncio
async def test_dispatcher_delegates_non_websocket_execution_to_local_worker() -> None:
    dispatcher = ExecutionDispatcher()
    request = ExecutionRequest(task_id=10, subtask_id=11)
    emitter = AsyncMock()
    local_dispatch = AsyncMock()

    try:
        with patch(
            "app.services.execution.stream_client.stream_execution_client.dispatch",
            local_dispatch,
        ):
            await dispatcher._dispatch_via_stream_worker(request, emitter)
    finally:
        await dispatcher.close()

    local_dispatch.assert_awaited_once_with(
        request,
        emitter,
        project_to_web=True,
    )


@pytest.mark.asyncio
async def test_dispatcher_sse_does_not_run_status_side_effects_in_web() -> None:
    dispatcher = ExecutionDispatcher()
    request = ExecutionRequest(task_id=10, subtask_id=11)
    emitter = AsyncMock()
    target = ExecutionTarget(mode=CommunicationMode.SSE, url="http://chat-shell")

    with (
        patch.object(dispatcher, "_recover_executor_if_needed", AsyncMock()),
        patch.object(dispatcher.router, "route", return_value=target),
        patch.object(dispatcher, "_update_subtask_to_running", AsyncMock()),
        patch(
            "app.services.execution.stream_client.stream_execution_client.dispatch",
            AsyncMock(),
        ) as local_dispatch,
    ):
        await dispatcher.dispatch(request, emitter=emitter)

    local_dispatch.assert_awaited_once()
    assert local_dispatch.await_args.args[0] is request
    assert local_dispatch.await_args.args[1] is emitter
    assert local_dispatch.await_args.kwargs == {"project_to_web": False}
    emitter.close.assert_awaited_once()


@pytest.mark.asyncio
async def test_dispatcher_registers_worker_execution_for_web_graceful_shutdown() -> (
    None
):
    dispatcher = ExecutionDispatcher()
    request = ExecutionRequest(task_id=10, subtask_id=11)
    emitter = AsyncMock()
    shutdown_manager = AsyncMock()

    with (
        patch("app.core.shutdown.shutdown_manager", shutdown_manager),
        patch(
            "app.services.execution.stream_client.stream_execution_client.dispatch",
            AsyncMock(side_effect=RuntimeError("IPC failed")),
        ),
        pytest.raises(RuntimeError, match="IPC failed"),
    ):
        await dispatcher._dispatch_via_stream_worker(request, emitter)

    shutdown_manager.register_stream.assert_awaited_once_with(request.subtask_id)
    shutdown_manager.unregister_stream.assert_awaited_once_with(request.subtask_id)


@pytest.mark.asyncio
async def test_dispatcher_rejects_worker_execution_after_shutdown_without_ipc() -> None:
    dispatcher = ExecutionDispatcher()
    request = ExecutionRequest(task_id=10, subtask_id=11)
    emitter = AsyncMock()
    shutdown_manager = AsyncMock()
    shutdown_manager.register_stream.side_effect = StreamAdmissionClosedError(
        request.subtask_id
    )
    local_dispatch = AsyncMock()

    try:
        with (
            patch("app.core.shutdown.shutdown_manager", shutdown_manager),
            patch(
                "app.services.execution.stream_client."
                "stream_execution_client.dispatch",
                local_dispatch,
            ),
            pytest.raises(StreamAdmissionClosedError) as raised,
        ):
            await dispatcher._dispatch_via_stream_worker(request, emitter)
    finally:
        await dispatcher.close()

    assert raised.value.error_code == "server_shutting_down"
    local_dispatch.assert_not_awaited()
    shutdown_manager.unregister_stream.assert_not_awaited()


@pytest.mark.asyncio
async def test_dispatcher_rejects_inprocess_before_any_execution_side_effect() -> None:
    dispatcher = ExecutionDispatcher()
    request = ExecutionRequest(task_id=10, subtask_id=11)
    emitter = AsyncMock()
    target = ExecutionTarget(mode=CommunicationMode.INPROCESS)
    shutdown_manager = AsyncMock()
    shutdown_manager.register_stream.side_effect = StreamAdmissionClosedError(
        request.subtask_id
    )
    admitted_dispatch = AsyncMock()

    try:
        with (
            patch("app.core.shutdown.shutdown_manager", shutdown_manager),
            patch.object(
                dispatcher,
                "_dispatch_inprocess_admitted",
                admitted_dispatch,
            ),
            pytest.raises(StreamAdmissionClosedError) as raised,
        ):
            await dispatcher._dispatch_inprocess(request, target, emitter)
    finally:
        await dispatcher.close()

    assert raised.value.error_code == "server_shutting_down"
    admitted_dispatch.assert_not_awaited()
    shutdown_manager.unregister_stream.assert_not_awaited()
    emitter.emit_start.assert_not_awaited()
    emitter.emit.assert_not_awaited()


@pytest.mark.asyncio
async def test_stream_dispatcher_owns_status_processing_and_terminal_event() -> None:
    request = ExecutionRequest(task_id=10, subtask_id=11)
    raw_emitter = AsyncMock()
    status_instances = []

    class Upstream:
        async def dispatch_sse_upstream(self, received_request, emitter) -> None:
            assert received_request is request
            await emitter.emit(
                ExecutionEvent(
                    type=EventType.DONE,
                    task_id=request.task_id,
                    subtask_id=request.subtask_id,
                )
            )

    class FakeStatusEmitter:
        def __init__(
            self,
            *,
            wrapped,
            task_id,
            subtask_id,
            publish_completion_events,
        ) -> None:
            assert (task_id, subtask_id) == (10, 11)
            assert publish_completion_events is True
            self.wrapped = wrapped
            self.closed = False
            status_instances.append(self)

        async def emit(self, event) -> None:
            await self.wrapped.emit(event)

        async def close(self) -> None:
            self.closed = True
            await self.wrapped.close()

    with patch("app.stream_worker.StatusUpdatingEmitter", FakeStatusEmitter):
        await StatusOwningSSEDispatcher(Upstream()).dispatch_sse_upstream(
            request,
            raw_emitter,
        )

    assert len(status_instances) == 1
    assert status_instances[0].closed is True
    terminal = raw_emitter.emit.await_args.args[0]
    assert terminal.type == EventType.DONE.value
    raw_emitter.close.assert_awaited_once()


@pytest.mark.asyncio
async def test_explicit_emitter_does_not_add_websocket_projection() -> None:
    request = ExecutionRequest(task_id=10, subtask_id=11)
    raw_emitter = AsyncMock()

    class Upstream:
        async def dispatch_worker_owned(self, received_request, emitter) -> None:
            assert received_request is request
            await emitter.emit(
                ExecutionEvent(
                    type=EventType.DONE,
                    task_id=request.task_id,
                    subtask_id=request.subtask_id,
                )
            )

    class FakeStatusEmitter:
        def __init__(self, *, wrapped, **kwargs) -> None:
            del kwargs
            self.wrapped = wrapped

        async def emit(self, event) -> None:
            await self.wrapped.emit(event)

        async def close(self) -> None:
            await self.wrapped.close()

    with (
        patch("app.stream_worker.StatusUpdatingEmitter", FakeStatusEmitter),
        patch(
            "app.stream_worker.WebSocketResultEmitter",
            side_effect=AssertionError(
                "explicit emitter must not project to WebSocket"
            ),
        ),
    ):
        await StatusOwningSSEDispatcher(Upstream()).dispatch_worker_owned(
            request,
            raw_emitter,
            project_to_web=False,
        )

    terminal = raw_emitter.emit.await_args.args[0]
    assert terminal.type == EventType.DONE.value
    raw_emitter.close.assert_awaited_once()


@pytest.mark.asyncio
async def test_stream_dispatcher_converts_upstream_failure_to_terminal_error() -> None:
    request = ExecutionRequest(task_id=10, subtask_id=11)
    raw_emitter = AsyncMock()

    class FailingUpstream:
        async def dispatch_sse_upstream(self, received_request, emitter) -> None:
            del received_request, emitter
            raise RuntimeError("upstream failed")

    class FakeStatusEmitter:
        def __init__(
            self,
            *,
            wrapped,
            task_id,
            subtask_id,
            publish_completion_events,
        ) -> None:
            del task_id, subtask_id
            assert publish_completion_events is True
            self.wrapped = wrapped

        async def emit_error(self, task_id, subtask_id, error, **kwargs) -> None:
            await self.wrapped.emit(
                ExecutionEvent(
                    type=EventType.ERROR,
                    task_id=task_id,
                    subtask_id=subtask_id,
                    error=error,
                    error_code=kwargs.get("error_code"),
                )
            )

        async def close(self) -> None:
            await self.wrapped.close()

    with patch("app.stream_worker.StatusUpdatingEmitter", FakeStatusEmitter):
        await StatusOwningSSEDispatcher(FailingUpstream()).dispatch_sse_upstream(
            request,
            raw_emitter,
        )

    terminal = raw_emitter.emit.await_args.args[0]
    assert terminal.type == EventType.ERROR.value
    assert terminal.error == "upstream failed"


@pytest.mark.asyncio
async def test_stream_dispatcher_persists_cancelled_before_unwinding() -> None:
    request = ExecutionRequest(task_id=10, subtask_id=11)
    raw_emitter = AsyncMock()
    cancellation_persisted = asyncio.Event()

    class BlockingUpstream:
        async def dispatch_sse_upstream(self, received_request, emitter) -> None:
            del received_request, emitter
            await asyncio.Future()

    class FakeStatusEmitter:
        def __init__(
            self,
            *,
            wrapped,
            task_id,
            subtask_id,
            publish_completion_events,
        ) -> None:
            assert (task_id, subtask_id) == (10, 11)
            assert publish_completion_events is True
            self.wrapped = wrapped

        async def emit_cancelled(self, task_id, subtask_id) -> None:
            cancellation_persisted.set()
            await self.wrapped.emit(
                ExecutionEvent(
                    type=EventType.CANCELLED,
                    task_id=task_id,
                    subtask_id=subtask_id,
                )
            )

        async def close(self) -> None:
            await self.wrapped.close()

    with patch("app.stream_worker.StatusUpdatingEmitter", FakeStatusEmitter):
        dispatch_task = asyncio.create_task(
            StatusOwningSSEDispatcher(BlockingUpstream()).dispatch_sse_upstream(
                request,
                raw_emitter,
            )
        )
        await asyncio.sleep(0)
        dispatch_task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await dispatch_task

    assert cancellation_persisted.is_set()
    terminal = raw_emitter.emit.await_args.args[0]
    assert terminal.type == EventType.CANCELLED.value
    raw_emitter.close.assert_awaited_once()


@pytest.mark.asyncio
async def test_client_cancellation_does_not_cancel_worker_execution() -> None:
    socket_path = _short_socket_path()
    stop_event = asyncio.Event()

    class BlockingDispatcher:
        def __init__(self) -> None:
            self.started = asyncio.Event()
            self.release = asyncio.Event()
            self.completed = asyncio.Event()

        async def dispatch_worker_owned(self, request, emitter) -> None:
            del request, emitter
            self.started.set()
            await self.release.wait()
            self.completed.set()

    dispatcher = BlockingDispatcher()
    server_task = asyncio.create_task(
        LocalStreamServer(socket_path, dispatcher).run(stop_event)
    )
    await _wait_for_socket(socket_path)
    dispatch_task = asyncio.create_task(
        StreamExecutionClient(socket_path).dispatch(
            ExecutionRequest(task_id=10, subtask_id=11),
            AsyncMock(),
        )
    )

    try:
        await asyncio.wait_for(dispatcher.started.wait(), timeout=1)
        dispatch_task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await dispatch_task
        dispatcher.release.set()
        await asyncio.wait_for(dispatcher.completed.wait(), timeout=1)
    finally:
        stop_event.set()
        await server_task


@pytest.mark.asyncio
async def test_worker_heartbeats_keep_silent_execution_alive() -> None:
    socket_path = _short_socket_path()
    stop_event = asyncio.Event()

    class DelayedDispatcher:
        async def dispatch_worker_owned(self, request, emitter) -> None:
            await asyncio.sleep(0.7)
            await emitter.emit(
                ExecutionEvent(
                    type="done",
                    task_id=request.task_id,
                    subtask_id=request.subtask_id,
                )
            )

    server_task = asyncio.create_task(
        LocalStreamServer(
            socket_path,
            DelayedDispatcher(),
            heartbeat_interval_seconds=0.05,
        ).run(stop_event)
    )
    await _wait_for_socket(socket_path)
    emitter = AsyncMock()
    try:
        await StreamExecutionClient(
            socket_path,
            first_frame_timeout_seconds=0.3,
            heartbeat_timeout_seconds=0.3,
        ).dispatch(
            ExecutionRequest(task_id=10, subtask_id=11),
            emitter,
        )
    finally:
        stop_event.set()
        await server_task

    assert emitter.emit.await_args.args[0].type == "done"


@pytest.mark.asyncio
@pytest.mark.parametrize("send_initial_heartbeat", [False, True])
async def test_dispatch_detects_missing_initial_or_followup_heartbeat(
    send_initial_heartbeat: bool,
) -> None:
    socket_path = _short_socket_path()
    handler_finished = asyncio.Event()

    async def handle(reader, writer) -> None:
        await read_frame(reader)
        if send_initial_heartbeat:
            await write_frame(writer, {"type": "heartbeat"})
        await reader.read()
        writer.close()
        await writer.wait_closed()
        handler_finished.set()

    server = await asyncio.start_unix_server(handle, path=socket_path)
    try:
        with pytest.raises(
            StreamWorkerExecutionError,
            match=(
                "stopped responding"
                if send_initial_heartbeat
                else "did not send an initial response"
            ),
        ) as raised:
            await StreamExecutionClient(
                socket_path,
                first_frame_timeout_seconds=0.03,
                heartbeat_timeout_seconds=0.03,
            ).dispatch(
                ExecutionRequest(task_id=10, subtask_id=11),
                AsyncMock(),
            )
        await asyncio.wait_for(handler_finished.wait(), timeout=1)
    finally:
        server.close()
        await server.wait_closed()
        socket_path.unlink(missing_ok=True)

    assert raised.value.error_code == "stream_worker_timeout"


@pytest.mark.asyncio
async def test_runtime_task_update_uses_bounded_point_envelope() -> None:
    socket_path = _short_socket_path()
    received: list[dict] = []

    async def handle(reader, writer) -> None:
        received.append(await read_frame(reader))
        await write_frame(
            writer,
            {
                "type": "point_result",
                "result": {"success": True, "notified": 1},
            },
        )
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_unix_server(handle, path=socket_path)
    try:
        result = await StreamExecutionClient(socket_path).dispatch_runtime_task_updated(
            user_id=7,
            device_id="device-1",
            data={"localTaskId": "runtime-1", "status": "done"},
        )
    finally:
        server.close()
        await server.wait_closed()
        socket_path.unlink(missing_ok=True)

    assert result == {"success": True, "notified": 1}
    assert received == [
        {
            "type": "point_runtime_task_updated",
            "user_id": 7,
            "device_id": "device-1",
            "data": {"localTaskId": "runtime-1", "status": "done"},
        }
    ]


@pytest.mark.asyncio
async def test_worker_rejects_connection_that_never_sends_first_frame() -> None:
    socket_path = _short_socket_path()
    stop_event = asyncio.Event()

    class UnusedDispatcher:
        async def dispatch_sse_upstream(self, request, emitter) -> None:
            raise AssertionError("dispatcher must not run")

    server_task = asyncio.create_task(
        LocalStreamServer(
            socket_path,
            UnusedDispatcher(),
            first_frame_timeout_seconds=0.02,
        ).run(stop_event)
    )
    await _wait_for_socket(socket_path)
    reader, writer = await asyncio.open_unix_connection(socket_path)
    try:
        frame = await asyncio.wait_for(read_frame(reader), timeout=1)
    finally:
        writer.close()
        await writer.wait_closed()
        stop_event.set()
        await server_task

    assert frame["type"] == "error"
    assert frame["error_code"] == "stream_worker_first_frame_timeout"


@pytest.mark.asyncio
async def test_worker_rejects_connections_above_capacity() -> None:
    socket_path = _short_socket_path()
    stop_event = asyncio.Event()

    class UnusedDispatcher:
        async def dispatch_sse_upstream(self, request, emitter) -> None:
            raise AssertionError("dispatcher must not run")

    server = LocalStreamServer(
        socket_path,
        UnusedDispatcher(),
        max_connections=1,
        first_frame_timeout_seconds=1,
    )
    server_task = asyncio.create_task(server.run(stop_event))
    await _wait_for_socket(socket_path)
    first_reader, first_writer = await asyncio.open_unix_connection(socket_path)
    del first_reader
    for _ in range(100):
        if len(server._active) == 1:
            break
        await asyncio.sleep(0.001)
    assert len(server._active) == 1

    async def dispatch_rejected_request(subtask_id: int) -> str | None:
        try:
            await StreamExecutionClient(socket_path).dispatch(
                ExecutionRequest(task_id=10, subtask_id=subtask_id),
                AsyncMock(),
            )
        except StreamWorkerExecutionError as error:
            return error.error_code
        pytest.fail("over-capacity request unexpectedly reached the worker")

    try:
        # Repeat sequentially so the assertion targets protocol delivery, not
        # the deliberately one-entry kernel accept backlog in this test.
        error_codes = [
            await dispatch_rejected_request(index) for index in range(20, 36)
        ]
    finally:
        first_writer.close()
        await first_writer.wait_closed()
        stop_event.set()
        await server_task

    assert error_codes == ["stream_worker_overloaded"] * 16


@pytest.mark.asyncio
async def test_downstream_emitter_failure_does_not_cancel_worker_execution() -> None:
    socket_path = _short_socket_path()
    stop_event = asyncio.Event()

    class BlockingAfterEventDispatcher:
        def __init__(self) -> None:
            self.release = asyncio.Event()
            self.completed = asyncio.Event()

        async def dispatch_worker_owned(self, request, emitter) -> None:
            await emitter.emit(
                ExecutionEvent(
                    type="chunk",
                    task_id=request.task_id,
                    subtask_id=request.subtask_id,
                    content="hello",
                )
            )
            await self.release.wait()
            self.completed.set()

    class FailingEmitter:
        async def emit(self, event) -> None:
            del event
            raise RuntimeError("downstream failed")

    dispatcher = BlockingAfterEventDispatcher()
    server_task = asyncio.create_task(
        LocalStreamServer(socket_path, dispatcher).run(stop_event)
    )
    await _wait_for_socket(socket_path)
    try:
        with pytest.raises(RuntimeError, match="downstream failed"):
            await StreamExecutionClient(socket_path).dispatch(
                ExecutionRequest(task_id=10, subtask_id=11),
                FailingEmitter(),
            )
        dispatcher.release.set()
        await asyncio.wait_for(dispatcher.completed.wait(), timeout=1)
    finally:
        stop_event.set()
        await server_task


@pytest.mark.asyncio
async def test_receive_loop_applies_bounded_relay_backpressure() -> None:
    reader = asyncio.StreamReader()
    for content in ("one", "two"):
        reader.feed_data(
            _encoded_frame(
                {
                    "type": "event",
                    "event": ExecutionEvent(
                        type="chunk",
                        task_id=10,
                        subtask_id=11,
                        content=content,
                    ).to_dict(),
                }
            )
        )
    reader.feed_data(
        _encoded_frame(
            {
                "type": "terminal",
                "event": ExecutionEvent(
                    type="done",
                    task_id=10,
                    subtask_id=11,
                ).to_dict(),
            }
        )
    )
    relay: asyncio.Queue[stream_client_module._RelayedEvent | object] = asyncio.Queue(
        maxsize=1
    )
    client = StreamExecutionClient(
        first_frame_timeout_seconds=1,
        heartbeat_timeout_seconds=1,
    )

    receive_task = asyncio.create_task(client._receive_frames(reader, relay))
    for _ in range(100):
        if relay.qsize() == 1:
            break
        await asyncio.sleep(0.001)
    assert relay.qsize() == 1
    assert not receive_task.done()

    first_item = await relay.get()
    assert isinstance(first_item, stream_client_module._RelayedEvent)
    assert first_item.event.content == "one"
    await first_item.lease.release()
    for _ in range(100):
        if relay.qsize() == 1:
            break
        await asyncio.sleep(0.001)
    assert relay.qsize() == 1
    assert not receive_task.done()

    second_item = await relay.get()
    assert isinstance(second_item, stream_client_module._RelayedEvent)
    assert second_item.event.content == "two"
    await second_item.lease.release()

    terminal_item = await relay.get()
    assert isinstance(terminal_item, stream_client_module._RelayedEvent)
    assert terminal_item.event.type == "done"
    await terminal_item.lease.release()
    assert await asyncio.wait_for(receive_task, timeout=1) is None


@pytest.mark.asyncio
async def test_receive_loop_rate_limits_events_before_projection_and_skips_heartbeat(
    monkeypatch,
) -> None:
    trace: list[str] = []

    class RecordingAdmission:
        async def acquire(self) -> None:
            trace.append("admit")

    original_projection = stream_client_module._execution_event_from_dict
    original_loads = stream_client_module.orjson.loads

    def tracked_loads(payload):
        trace.append("decode")
        return original_loads(payload)

    async def tracked_projection(raw_event):
        trace.append("project")
        return await original_projection(raw_event)

    monkeypatch.setattr(
        stream_client_module,
        "_execution_event_from_dict",
        tracked_projection,
    )
    monkeypatch.setattr(stream_client_module.orjson, "loads", tracked_loads)
    reader = asyncio.StreamReader()
    reader.feed_data(_encoded_frame({"type": "heartbeat"}))
    reader.feed_data(
        _encoded_frame(
            {
                "type": "event",
                "event": ExecutionEvent(
                    type="chunk",
                    task_id=10,
                    subtask_id=11,
                    content="one",
                ).to_dict(),
            }
        )
    )
    reader.feed_data(
        _encoded_frame(
            {
                "type": "terminal",
                "event": ExecutionEvent(
                    type="done",
                    task_id=10,
                    subtask_id=11,
                ).to_dict(),
            }
        )
    )
    relay: asyncio.Queue[stream_client_module._RelayedEvent | object] = asyncio.Queue()
    client = StreamExecutionClient(
        first_frame_timeout_seconds=1,
        heartbeat_timeout_seconds=1,
        event_admission=RecordingAdmission(),
    )

    assert await client._receive_frames(reader, relay) is None

    assert trace == [
        "admit",
        "decode",
        "project",
        "admit",
        "decode",
        "project",
    ]
    while True:
        item = relay.get_nowait()
        if item is stream_client_module._RELAY_COMPLETE:
            break
        assert isinstance(item, stream_client_module._RelayedEvent)
        await item.lease.release()


@pytest.mark.asyncio
async def test_process_relay_byte_admission_backpressures_before_frame_read() -> None:
    admission = stream_client_module.StreamRelayByteAdmission(max_bytes=4)
    first = await admission.acquire(4)

    waiting = asyncio.create_task(admission.acquire(1))
    await asyncio.sleep(0)
    assert not waiting.done()

    await first.release()
    second = await asyncio.wait_for(waiting, timeout=1)
    await second.release()


@pytest.mark.asyncio
async def test_relay_failure_releases_current_and_queued_byte_leases() -> None:
    admission = stream_client_module.StreamRelayByteAdmission(max_bytes=10)
    first = await admission.acquire(5)
    second = await admission.acquire(5)
    relay: asyncio.Queue[stream_client_module._RelayedEvent | object] = asyncio.Queue()
    await relay.put(
        stream_client_module._RelayedEvent(
            event=ExecutionEvent(type="chunk", task_id=1, subtask_id=2),
            lease=first,
        )
    )
    await relay.put(
        stream_client_module._RelayedEvent(
            event=ExecutionEvent(type="chunk", task_id=1, subtask_id=2),
            lease=second,
        )
    )
    emitter = AsyncMock()
    emitter.emit.side_effect = RuntimeError("client failed")

    with pytest.raises(RuntimeError, match="client failed"):
        await StreamExecutionClient._drain_events(relay, emitter)

    full_budget = await asyncio.wait_for(admission.acquire(10), timeout=1)
    await full_budget.release()


@pytest.mark.asyncio
async def test_dispatch_accepts_transport_completion_without_terminal_event() -> None:
    socket_path = _short_socket_path()

    async def handle(reader, writer) -> None:
        await read_frame(reader)
        await write_frame(writer, {"type": "complete"})
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_unix_server(handle, path=socket_path)
    try:
        emitter = AsyncMock()
        await StreamExecutionClient(socket_path).dispatch(
            ExecutionRequest(task_id=10, subtask_id=11),
            emitter,
        )
        emitter.emit.assert_not_awaited()
    finally:
        server.close()
        await server.wait_closed()
        socket_path.unlink(missing_ok=True)


@pytest.mark.asyncio
async def test_read_frame_rejects_oversized_payload_before_allocation() -> None:
    reader = asyncio.StreamReader()
    reader.feed_data((stream_client_module._MAX_FRAME_BYTES + 1).to_bytes(4, "big"))

    with pytest.raises(
        StreamWorkerExecutionError, match="Invalid local IPC frame size"
    ):
        await read_frame(reader)


@pytest.mark.asyncio
async def test_write_frame_serialization_runs_off_event_loop(monkeypatch) -> None:
    event_loop_thread = threading.get_ident()
    serializer_threads = []
    original_dumps = orjson.dumps

    def tracked_dumps(payload):
        serializer_threads.append(threading.get_ident())
        return original_dumps(payload)

    class Writer:
        def __init__(self) -> None:
            self.data = b""

        def write(self, data: bytes) -> None:
            self.data += data

        async def drain(self) -> None:
            return None

    monkeypatch.setattr(stream_client_module.orjson, "dumps", tracked_dumps)
    writer = Writer()

    await write_frame(writer, {"type": "ping"})

    assert serializer_threads
    assert serializer_threads[0] != event_loop_thread
    assert writer.data == _encoded_frame({"type": "ping"})


@pytest.mark.asyncio
async def test_small_frame_deserialization_runs_off_event_loop(monkeypatch) -> None:
    event_loop_thread = threading.get_ident()
    decoder_threads = []
    original_loads = orjson.loads
    encoded = orjson.dumps(
        {
            "type": "event",
            "content": "x",
        }
    )

    def tracked_loads(payload):
        decoder_threads.append(threading.get_ident())
        return original_loads(payload)

    reader = asyncio.StreamReader()
    reader.feed_data(len(encoded).to_bytes(4, "big") + encoded)
    monkeypatch.setattr(stream_client_module.orjson, "loads", tracked_loads)

    frame = await read_frame(reader)

    assert frame["type"] == "event"
    assert decoder_threads
    assert decoder_threads[0] != event_loop_thread


@pytest.mark.asyncio
async def test_small_execution_event_conversion_runs_off_event_loop(
    monkeypatch,
) -> None:
    event_loop_thread = threading.get_ident()
    conversion_threads = []
    original_from_dict = ExecutionEvent.from_dict

    def tracked_from_dict(payload):
        conversion_threads.append(threading.get_ident())
        return original_from_dict(payload)

    monkeypatch.setattr(
        stream_client_module.ExecutionEvent,
        "from_dict",
        tracked_from_dict,
    )

    event = await stream_client_module._execution_event_from_dict(
        {"type": EventType.CHUNK.value, "content": "x"},
    )

    assert event.content == "x"
    assert conversion_threads
    assert conversion_threads[0] != event_loop_thread
