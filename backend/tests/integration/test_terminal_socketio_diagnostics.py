# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Two-Backend terminal diagnostics contracts over an isolated Redis."""

import asyncio
import logging
import shutil
import socket
import subprocess
import time
from contextlib import suppress
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
import pytest_asyncio
import redis
import socketio

from app.api.ws import device_namespace, terminal_namespace
from app.api.ws.device_namespace import DeviceNamespace
from app.api.ws.terminal_namespace import TerminalNamespace
from app.core.config import settings
from app.core.terminal_socketio_manager import TerminalDiagnosticAsyncRedisManager
from app.services.device.terminal_diagnostics import (
    bind_terminal_trace,
    create_terminal_trace,
)
from app.services.device.terminal_session_service import TerminalSessionRecord


@pytest.fixture
def isolated_redis_url(tmp_path):
    executable = shutil.which("redis-server")
    if executable is None:
        pytest.fail("redis-server is required for terminal integration tests")
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    process = subprocess.Popen(
        [
            executable,
            "--bind",
            "127.0.0.1",
            "--port",
            str(port),
            "--save",
            "",
            "--appendonly",
            "no",
            "--dir",
            str(tmp_path),
            "--loglevel",
            "warning",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    url = f"redis://127.0.0.1:{port}/0"
    client = redis.Redis.from_url(url)
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        try:
            if client.ping():
                break
        except redis.RedisError:
            time.sleep(0.02)
    else:
        process.terminate()
        pytest.fail("isolated redis-server did not start")
    try:
        yield url
    finally:
        client.close()
        process.terminate()
        with suppress(subprocess.TimeoutExpired):
            process.wait(timeout=5)
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)


@pytest_asyncio.fixture
async def backend_pair(isolated_redis_url, monkeypatch):
    monkeypatch.setattr(settings, "TERMINAL_BACKEND_DIAGNOSTICS_DEVICE_IDS", "device-1")
    monkeypatch.setattr(settings, "TERMINAL_BACKEND_DIAGNOSTICS_SAMPLE_RATE", 1.0)
    manager_a = TerminalDiagnosticAsyncRedisManager(isolated_redis_url)
    manager_b = TerminalDiagnosticAsyncRedisManager(isolated_redis_url)
    server_a = socketio.AsyncServer(client_manager=manager_a)
    server_b = socketio.AsyncServer(client_manager=manager_b)
    server_a._send_eio_packet = AsyncMock()
    server_b._send_eio_packet = AsyncMock()
    manager_a.initialize()
    manager_b.initialize()
    await _wait_until(
        lambda: bool(
            getattr(manager_a, "pubsub", None)
            and manager_a.pubsub.subscribed
            and getattr(manager_b, "pubsub", None)
            and manager_b.pubsub.subscribed
        )
    )
    try:
        yield SimpleNamespace(
            manager_a=manager_a,
            manager_b=manager_b,
            server_a=server_a,
            server_b=server_b,
        )
    finally:
        for manager in (manager_a, manager_b):
            manager.thread.cancel()
        await asyncio.gather(
            manager_a.thread,
            manager_b.thread,
            return_exceptions=True,
        )
        for manager in (manager_a, manager_b):
            if getattr(manager, "pubsub", None) is not None:
                await manager.pubsub.aclose()
            if getattr(manager, "redis", None) is not None:
                await manager.redis.aclose()


@pytest.mark.asyncio
async def test_terminal_relay_traces_both_directions_across_backends(
    backend_pair, monkeypatch, caplog
):
    pair = backend_pair
    caplog.set_level(
        logging.INFO,
        logger="app.services.device.terminal_diagnostics",
    )
    browser_sid = await pair.manager_a.connect("browser-eio", "/terminal")
    await pair.manager_a.enter_room(
        browser_sid,
        "/terminal",
        "terminal:terminal-1",
    )
    device_sid = await pair.manager_b.connect("device-eio", "/local-executor")
    record = _record(device_sid)

    browser_namespace = TerminalNamespace()
    monkeypatch.setattr(
        browser_namespace,
        "get_session",
        AsyncMock(return_value=_attached_session(record)),
    )
    monkeypatch.setattr(
        terminal_namespace,
        "terminal_session_service",
        SimpleNamespace(
            authorize=AsyncMock(),
            is_authorization_current=Mock(return_value=True),
            is_revoked=Mock(return_value=False),
        ),
    )
    monkeypatch.setattr(terminal_namespace, "get_sio", lambda: pair.server_a)

    input_result = await browser_namespace.on_terminal_input(
        browser_sid,
        {"session_id": "terminal-1", "data": "echo integration\n"},
    )
    await _wait_until(lambda: pair.server_b._send_eio_packet.await_count == 1)

    executor_namespace = DeviceNamespace()
    monkeypatch.setattr(
        executor_namespace,
        "get_session",
        AsyncMock(return_value={"user_id": 7, "device_id": "device-1"}),
    )
    monkeypatch.setattr(
        device_namespace,
        "terminal_session_service",
        SimpleNamespace(get=AsyncMock(return_value=record)),
    )
    monkeypatch.setattr(device_namespace, "get_sio", lambda: pair.server_b)

    output_result = await executor_namespace.on_terminal_output(
        device_sid,
        {
            "session_id": "terminal-1",
            "protocol_version": 2,
            "consumer_id": "consumer-1",
            "sequence": 9,
            "data": "ready\n",
        },
    )
    await _wait_until(lambda: pair.server_a._send_eio_packet.await_count == 1)

    assert input_result == {"success": True}
    assert output_result == {"success": True}
    _assert_cross_backend_stages(caplog.messages, "terminal:input")
    _assert_cross_backend_stages(caplog.messages, "terminal:output")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("event", "data"),
    [
        ("terminal:attach", {"session_id": "terminal-1"}),
        ("terminal:ack", {"session_id": "terminal-1", "sequence": 1}),
        ("terminal:close", {"session_id": "terminal-1"}),
    ],
)
async def test_socketio_call_callback_crosses_redis_without_fake_callback_stage(
    backend_pair, event, data, caplog
):
    pair = backend_pair
    caplog.set_level(
        logging.INFO,
        logger="app.services.device.terminal_diagnostics",
    )
    device_sid = await pair.manager_b.connect("device-eio", "/local-executor")

    async def acknowledge(eio_sid, packet):
        await pair.server_b._handle_ack(
            eio_sid,
            packet.namespace,
            packet.id,
            [{"success": True}],
        )

    pair.server_b._send_packet = acknowledge
    trace = create_terminal_trace(
        device_id="device-1",
        session_id="terminal-1",
        event=event,
        direction="browser_to_device",
    )
    assert trace is not None

    with bind_terminal_trace(trace):
        result = await pair.server_a.call(
            event,
            data,
            to=device_sid,
            namespace="/local-executor",
            timeout=3,
        )
    await _wait_until(
        lambda: any(
            f"trace_id={trace.trace_id}" in message
            and "stage=redis.consume_enqueue" in message
            for message in caplog.messages
        )
    )

    traced_messages = [
        message
        for message in caplog.messages
        if f"trace_id={trace.trace_id}" in message
    ]
    assert result == {"success": True}
    assert any("stage=redis.publish" in message for message in traced_messages)
    assert any("stage=redis.consume_enqueue" in message for message in traced_messages)
    assert not any("callback" in message for message in traced_messages)


def _record(socket_id: str) -> TerminalSessionRecord:
    return TerminalSessionRecord(
        session_id="terminal-1",
        user_id=7,
        device_id="device-1",
        socket_id=socket_id,
        project_id=123,
        path="/repo",
        expires_at=datetime.now(timezone.utc) + timedelta(minutes=5),
    )


def _attached_session(record: TerminalSessionRecord) -> dict:
    return {
        "user_id": 7,
        "token_exp": 9999999999,
        "terminal_session_id": record.session_id,
        "terminal_consumer_id": "consumer-1",
        "terminal_protocol_version": 2,
        "terminal_authorization": record,
    }


async def _wait_until(predicate, timeout: float = 5) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("condition was not met before timeout")


def _assert_cross_backend_stages(messages: list[str], event: str) -> None:
    event_messages = [message for message in messages if f"event={event}" in message]
    trace_ids = {
        field.split("=", maxsplit=1)[1]
        for message in event_messages
        for field in message.split()
        if field.startswith("trace_id=")
    }
    assert len(trace_ids) == 1
    assert any("stage=namespace.relay" in message for message in event_messages)
    assert any("stage=redis.publish" in message for message in event_messages)
    assert any("stage=redis.consume_enqueue" in message for message in event_messages)
