# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Contract tests for terminal-aware Socket.IO Redis instrumentation."""

import asyncio
import importlib.metadata
import inspect
import time
from unittest.mock import Mock

import pytest
import socketio

from app.core import terminal_socketio_manager
from app.core.config import settings
from app.core.terminal_socketio_manager import TerminalDiagnosticAsyncRedisManager
from app.services.device.terminal_diagnostics import (
    TERMINAL_TRACE_METADATA_KEY,
    TerminalTrace,
    bind_terminal_trace,
    create_terminal_trace,
)


@pytest.fixture
def trace(monkeypatch) -> TerminalTrace:
    monkeypatch.setattr(settings, "TERMINAL_BACKEND_DIAGNOSTICS_DEVICE_IDS", "device-1")
    monkeypatch.setattr(settings, "TERMINAL_BACKEND_DIAGNOSTICS_SAMPLE_RATE", 1.0)
    created = create_terminal_trace(
        device_id="device-1",
        session_id="terminal-secret",
        event="terminal:output",
        direction="device_to_browser",
        byte_count=6,
    )
    assert created is not None
    return created


def test_python_socketio_private_contract_is_pinned():
    assert importlib.metadata.version("python-socketio") == "5.15.1"
    assert tuple(inspect.signature(socketio.AsyncRedisManager._publish).parameters) == (
        "self",
        "data",
    )
    assert tuple(
        inspect.signature(socketio.AsyncRedisManager._handle_emit).parameters
    ) == ("self", "message")


@pytest.mark.asyncio
@pytest.mark.parametrize("publish_result", [3, 0, None])
async def test_publish_preserves_result_and_adds_safe_metadata(
    trace, monkeypatch, publish_result
):
    received = []

    async def fake_publish(_manager, message):
        received.append(message)
        return publish_result

    monkeypatch.setattr(socketio.AsyncRedisManager, "_publish", fake_publish)
    manager = TerminalDiagnosticAsyncRedisManager("redis://localhost:6379/0")
    envelope = {
        "method": "emit",
        "event": "terminal:output",
        "data": {"data": "secret-output"},
        "namespace": "/terminal",
        "room": "terminal:secret-session",
    }

    with bind_terminal_trace(trace):
        result = await manager._publish(envelope)

    assert result is publish_result or result == publish_result
    assert received[0] is not envelope
    metadata = received[0][TERMINAL_TRACE_METADATA_KEY]
    assert metadata["session_hash"] == trace.session_hash
    assert "secret-output" not in str(metadata)
    assert "secret-session" not in str(metadata)


@pytest.mark.asyncio
async def test_publish_without_trace_passes_original_envelope(monkeypatch):
    received = []

    async def fake_publish(_manager, message):
        received.append(message)
        return 1

    monkeypatch.setattr(socketio.AsyncRedisManager, "_publish", fake_publish)
    manager = TerminalDiagnosticAsyncRedisManager("redis://localhost:6379/0")
    envelope = {"method": "emit", "event": "other", "data": {}}

    assert await manager._publish(envelope) == 1
    assert received == [envelope]
    assert received[0] is envelope


@pytest.mark.asyncio
async def test_metadata_preparation_failure_is_fail_open(trace, monkeypatch):
    received = []

    async def fake_publish(_manager, message):
        received.append(message)
        return 1

    def broken_metadata(*_args, **_kwargs):
        raise RuntimeError("diagnostic failure")

    monkeypatch.setattr(socketio.AsyncRedisManager, "_publish", fake_publish)
    monkeypatch.setattr(TerminalTrace, "metadata", broken_metadata)
    manager = TerminalDiagnosticAsyncRedisManager("redis://localhost:6379/0")
    envelope = {"method": "emit", "event": "terminal:output", "data": {}}

    with bind_terminal_trace(trace):
        result = await manager._publish(envelope)

    assert result == 1
    assert received[0] is envelope


@pytest.mark.asyncio
async def test_publish_preserves_cancellation(trace, monkeypatch):
    async def cancelled(_manager, _message):
        raise asyncio.CancelledError

    monkeypatch.setattr(socketio.AsyncRedisManager, "_publish", cancelled)
    manager = TerminalDiagnosticAsyncRedisManager("redis://localhost:6379/0")

    with bind_terminal_trace(trace), pytest.raises(asyncio.CancelledError):
        await manager._publish({"method": "emit", "event": "terminal:output"})


@pytest.mark.asyncio
async def test_publish_preserves_exception(trace, monkeypatch):
    async def failed(_manager, _message):
        raise RuntimeError("redis unavailable")

    monkeypatch.setattr(socketio.AsyncRedisManager, "_publish", failed)
    manager = TerminalDiagnosticAsyncRedisManager("redis://localhost:6379/0")

    with (
        bind_terminal_trace(trace),
        pytest.raises(RuntimeError, match="redis unavailable"),
    ):
        await manager._publish({"method": "emit", "event": "terminal:output"})


@pytest.mark.asyncio
async def test_source_local_enqueue_uses_context_before_publish(trace, monkeypatch):
    handled = []
    records = Mock()

    expected = object()

    async def fake_handle(_manager, message):
        handled.append(message)
        return expected

    monkeypatch.setattr(socketio.AsyncRedisManager, "_handle_emit", fake_handle)
    monkeypatch.setattr(terminal_socketio_manager, "record_terminal_trace", records)
    monkeypatch.setattr(
        terminal_socketio_manager, "_participant_count", lambda *_args: (1, False)
    )
    manager = TerminalDiagnosticAsyncRedisManager("redis://localhost:6379/0")
    message = {
        "method": "emit",
        "event": "terminal:output",
        "namespace": "/terminal",
        "room": "terminal:secret-session",
    }

    with bind_terminal_trace(trace):
        result = await manager._handle_emit(message)

    assert result is expected
    assert handled == [message]
    assert records.call_args.kwargs["stage"] == "socketio.local_enqueue"
    assert records.call_args.kwargs["target_namespace"] == "/terminal"


@pytest.mark.asyncio
async def test_remote_enqueue_uses_envelope_metadata_and_actual_room(
    trace, monkeypatch
):
    records = Mock()

    async def fake_handle(_manager, _message):
        return None

    monkeypatch.setattr(socketio.AsyncRedisManager, "_handle_emit", fake_handle)
    monkeypatch.setattr(terminal_socketio_manager, "record_terminal_trace", records)
    monkeypatch.setattr(
        terminal_socketio_manager, "_participant_count", lambda *_args: (1, False)
    )
    manager = TerminalDiagnosticAsyncRedisManager("redis://localhost:6379/0")
    message = {
        "method": "emit",
        "event": "terminal:output",
        "namespace": "/terminal",
        "room": "terminal:actual-session",
        TERMINAL_TRACE_METADATA_KEY: trace.metadata(
            published_wall_ns=time.time_ns() - 1_000_000
        ),
    }

    await manager._handle_emit(message)

    assert records.call_args.kwargs["stage"] == "redis.consume_enqueue"
    assert records.call_args.kwargs["target_namespace"] == "/terminal"
    assert records.call_args.kwargs["approx_queue_ms"] >= 0


@pytest.mark.asyncio
async def test_handle_emit_preserves_cancellation(trace, monkeypatch):
    async def cancelled(_manager, _message):
        raise asyncio.CancelledError

    monkeypatch.setattr(socketio.AsyncRedisManager, "_handle_emit", cancelled)
    manager = TerminalDiagnosticAsyncRedisManager("redis://localhost:6379/0")

    with bind_terminal_trace(trace), pytest.raises(asyncio.CancelledError):
        await manager._handle_emit(
            {
                "method": "emit",
                "event": "terminal:output",
                "namespace": "/terminal",
                "room": "terminal:actual-session",
            }
        )


@pytest.mark.asyncio
async def test_handle_emit_preserves_exception(trace, monkeypatch):
    calls = 0

    async def failed(_manager, _message):
        nonlocal calls
        calls += 1
        raise RuntimeError("local enqueue failed")

    monkeypatch.setattr(socketio.AsyncRedisManager, "_handle_emit", failed)
    manager = TerminalDiagnosticAsyncRedisManager("redis://localhost:6379/0")

    with (
        bind_terminal_trace(trace),
        pytest.raises(RuntimeError, match="local enqueue failed"),
    ):
        await manager._handle_emit(
            {
                "method": "emit",
                "event": "terminal:output",
                "namespace": "/terminal",
                "room": "terminal:actual-session",
            }
        )

    assert calls == 1


@pytest.mark.asyncio
async def test_malformed_remote_metadata_is_fail_open(monkeypatch):
    handled = []

    async def fake_handle(_manager, message):
        handled.append(message)

    monkeypatch.setattr(socketio.AsyncRedisManager, "_handle_emit", fake_handle)
    manager = TerminalDiagnosticAsyncRedisManager("redis://localhost:6379/0")
    message = {
        "method": "emit",
        "event": "terminal:output",
        TERMINAL_TRACE_METADATA_KEY: {"version": 1, "trace_id": "invalid"},
    }

    await manager._handle_emit(message)

    assert handled == [message]


@pytest.mark.asyncio
async def test_remote_manager_without_participant_does_not_log_normal_consume(
    trace, monkeypatch
):
    records = Mock()

    async def fake_handle(_manager, _message):
        return None

    monkeypatch.setattr(socketio.AsyncRedisManager, "_handle_emit", fake_handle)
    monkeypatch.setattr(terminal_socketio_manager, "record_terminal_trace", records)
    monkeypatch.setattr(
        terminal_socketio_manager, "_participant_count", lambda *_args: (0, False)
    )
    manager = TerminalDiagnosticAsyncRedisManager("redis://localhost:6379/0")

    await manager._handle_emit(
        {
            "method": "emit",
            "event": "terminal:output",
            "namespace": "/terminal",
            "room": "terminal:actual-session",
            TERMINAL_TRACE_METADATA_KEY: trace.metadata(
                published_wall_ns=time.time_ns()
            ),
        }
    )

    records.assert_not_called()


@pytest.mark.asyncio
async def test_participant_query_failure_is_logged_and_emit_continues(
    trace, monkeypatch
):
    handled = []
    records = Mock()

    async def fake_handle(_manager, message):
        handled.append(message)

    monkeypatch.setattr(socketio.AsyncRedisManager, "_handle_emit", fake_handle)
    monkeypatch.setattr(terminal_socketio_manager, "record_terminal_trace", records)
    monkeypatch.setattr(
        terminal_socketio_manager, "_participant_count", lambda *_args: (None, True)
    )
    manager = TerminalDiagnosticAsyncRedisManager("redis://localhost:6379/0")

    with bind_terminal_trace(trace):
        await manager._handle_emit(
            {
                "method": "emit",
                "event": "terminal:output",
                "namespace": "/terminal",
                "room": "terminal:actual-session",
            }
        )

    assert len(handled) == 1
    assert records.call_args.kwargs["result"] == "diagnostic_error"
    assert records.call_args.kwargs["target_location"] == "unknown"
    assert records.call_args.kwargs["reason_code"] == "participant_query_failed"


@pytest.mark.asyncio
async def test_enqueue_diagnostic_failure_does_not_change_emit(trace, monkeypatch):
    handled = []

    async def fake_handle(_manager, message):
        handled.append(message)

    monkeypatch.setattr(socketio.AsyncRedisManager, "_handle_emit", fake_handle)
    monkeypatch.setattr(
        terminal_socketio_manager, "_participant_count", lambda *_args: (1, False)
    )
    monkeypatch.setattr(
        terminal_socketio_manager,
        "_safe_elapsed_ms",
        Mock(side_effect=RuntimeError("timer failed")),
    )
    manager = TerminalDiagnosticAsyncRedisManager("redis://localhost:6379/0")

    with bind_terminal_trace(trace):
        result = await manager._handle_emit(
            {
                "method": "emit",
                "event": "terminal:output",
                "namespace": "/terminal",
                "room": "terminal:actual-session",
            }
        )

    assert result is None
    assert len(handled) == 1


@pytest.mark.asyncio
async def test_diagnostic_log_helper_failure_does_not_change_publish(
    trace, monkeypatch
):
    calls = []

    async def fake_publish(_manager, message):
        calls.append(message)
        return 2

    monkeypatch.setattr(socketio.AsyncRedisManager, "_publish", fake_publish)
    monkeypatch.setattr(
        terminal_socketio_manager,
        "record_terminal_trace",
        Mock(side_effect=RuntimeError("logging failed")),
    )
    manager = TerminalDiagnosticAsyncRedisManager("redis://localhost:6379/0")

    with bind_terminal_trace(trace):
        result = await manager._publish(
            {"method": "emit", "event": "terminal:output", "data": {}}
        )

    assert result == 2
    assert len(calls) == 1
