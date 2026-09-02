# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the isolated Pod-local channel process."""

from __future__ import annotations

import asyncio
import os
import stat
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest

from app import channel_worker as channel_worker_module
from app.channel_worker import LocalChannelServer
from app.services.channels.worker_client import (
    ChannelWorkerClient,
    ChannelWorkerError,
    read_channel_frame,
    write_channel_frame,
)
from shared.models import ExecutionEvent


def _socket_path() -> Path:
    return Path(tempfile.gettempdir()) / (
        f"wegent-channel-worker-{os.getpid()}-{uuid4().hex[:6]}.sock"
    )


async def _wait_for_socket(socket_path: Path) -> None:
    for _ in range(100):
        if socket_path.exists():
            return
        await asyncio.sleep(0.01)
    raise TimeoutError(f"Socket was not created: {socket_path}")


@dataclass(frozen=True)
class FakeChannel:
    id: int
    name: str = "test"
    channel_type: str = "telegram"
    is_enabled: bool = True
    config: dict[str, Any] | None = None
    default_team_id: int = 1
    default_model_name: str = "model"


class FakeManager:
    def __init__(self) -> None:
        self.running: set[int] = set()
        self.started: list[int] = []
        self.restarted: list[int] = []
        self.stopped: list[int] = []
        self.start_all_calls = 0
        self.stop_all_calls = 0

    async def start_all_enabled(self) -> int:
        self.start_all_calls += 1
        return 2

    async def start_channel(self, channel: FakeChannel) -> bool:
        self.started.append(channel.id)
        self.running.add(channel.id)
        return True

    async def restart_channel(self, channel: FakeChannel) -> bool:
        self.restarted.append(channel.id)
        self.running.add(channel.id)
        return True

    async def stop_channel(self, channel_id: int) -> None:
        self.stopped.append(channel_id)
        self.running.discard(channel_id)

    async def stop_all(self) -> int:
        self.stop_all_calls += 1
        count = len(self.running)
        self.running.clear()
        return count

    def is_channel_running(self, channel_id: int) -> bool:
        return channel_id in self.running

    def get_status(self, channel_id: int) -> dict[str, Any] | None:
        if channel_id not in self.running:
            return None
        return {"id": channel_id, "is_connected": True}


@pytest.mark.asyncio
async def test_server_supports_ping_lifecycle_and_status_round_trips() -> None:
    socket_path = _socket_path()
    stop_event = asyncio.Event()
    manager = FakeManager()
    channels = {
        1: FakeChannel(1),
        2: FakeChannel(2),
    }

    async def load(channel_id: int):
        return channels.get(channel_id)

    server = LocalChannelServer(socket_path, manager, channel_loader=load)
    server_task = asyncio.create_task(server.run(stop_event))
    await _wait_for_socket(socket_path)
    client = ChannelWorkerClient(socket_path)
    try:
        await client.ping()
        assert await client.reconcile(1) is True
        assert await client.status(1) == {"id": 1, "is_connected": True}
        assert await client.reconcile(2, force_restart=True) is True
        await client.stop(1)
        assert await client.status(1) is None
    finally:
        stop_event.set()
        await server_task

    assert manager.started == [1]
    assert manager.restarted == [2]
    assert manager.stopped == [1]
    assert not socket_path.exists()


@pytest.mark.asyncio
async def test_reconcile_stops_missing_and_disabled_channels() -> None:
    socket_path = _socket_path()
    stop_event = asyncio.Event()
    manager = FakeManager()
    manager.running.update({11, 12})
    channels = {12: FakeChannel(12, is_enabled=False)}

    async def load(channel_id: int):
        return channels.get(channel_id)

    server_task = asyncio.create_task(
        LocalChannelServer(socket_path, manager, channel_loader=load).run(stop_event)
    )
    await _wait_for_socket(socket_path)
    client = ChannelWorkerClient(socket_path)
    try:
        assert await client.reconcile(11) is False
        assert await client.reconcile(12) is False
    finally:
        stop_event.set()
        await server_task

    assert manager.stopped == [11, 12]


@pytest.mark.asyncio
async def test_callback_events_and_completion_execute_in_request_order() -> None:
    socket_path = _socket_path()
    stop_event = asyncio.Event()
    manager = FakeManager()
    operations: list[tuple[str, int]] = []

    async def unused_loader(channel_id: int):
        raise AssertionError(channel_id)

    async def forwarder(*, task_id, subtask_id, event, source) -> None:
        assert subtask_id == 6
        assert event.content == "part"
        assert source == "Callback"
        operations.append(("event", task_id))

    async def completion_handler(
        *, task_id, subtask_id, status, content, error
    ) -> bool:
        assert subtask_id == 6
        assert status == "COMPLETED"
        assert content == "final"
        assert error is None
        operations.append(("completed", task_id))
        return True

    server_task = asyncio.create_task(
        LocalChannelServer(
            socket_path,
            manager,
            channel_loader=unused_loader,
            event_forwarder=forwarder,
            task_completion_handler=completion_handler,
        ).run(stop_event)
    )
    await _wait_for_socket(socket_path)
    client = ChannelWorkerClient(socket_path)
    event = ExecutionEvent(
        type="chunk",
        task_id=5,
        subtask_id=6,
        content="part",
    )
    try:
        await client.forward_event(
            task_id=5,
            subtask_id=6,
            event=event,
            source="Callback",
        )
        assert (
            await client.task_completed(
                task_id=5,
                subtask_id=6,
                status="COMPLETED",
                content="final",
                error=None,
            )
            is True
        )
    finally:
        stop_event.set()
        await server_task

    assert operations == [("event", 5), ("completed", 5)]


@pytest.mark.asyncio
async def test_runtime_local_events_use_string_key_and_preserve_order() -> None:
    socket_path = _socket_path()
    stop_event = asyncio.Event()
    manager = FakeManager()
    operations: list[tuple[str, str, str]] = []

    async def unused_loader(channel_id: int):
        raise AssertionError(channel_id)

    async def forwarder(*, task_id, subtask_id, event, source) -> None:
        assert subtask_id == 16
        assert event.content == "part"
        assert source == "Device WS local task"
        operations.append(("event", task_id, event.content))

    async def completion_handler(
        *, task_id, subtask_id, status, content, error
    ) -> bool:
        assert subtask_id == 16
        assert status == "COMPLETED"
        assert error is None
        operations.append(("completed", task_id, content))
        return True

    server_task = asyncio.create_task(
        LocalChannelServer(
            socket_path,
            manager,
            channel_loader=unused_loader,
            event_forwarder=forwarder,
            task_completion_handler=completion_handler,
        ).run(stop_event)
    )
    await _wait_for_socket(socket_path)
    client = ChannelWorkerClient(socket_path)
    try:
        await client.runtime_local_event(
            device_id="device-a",
            local_task_id="local-a",
            source={"source": "im"},
            event=ExecutionEvent(type="chunk", subtask_id=16, content="part"),
        )
        await client.runtime_local_event(
            device_id="device-a",
            local_task_id="local-a",
            source={"source": "im"},
            event=ExecutionEvent(
                type="done",
                subtask_id=16,
                result={"value": "final"},
            ),
        )
    finally:
        stop_event.set()
        await server_task

    assert operations == [
        ("event", "runtime:device-a:local-a", "part"),
        ("completed", "runtime:device-a:local-a", "final"),
    ]


@pytest.mark.asyncio
async def test_runtime_local_event_ignores_non_im_source() -> None:
    socket_path = _socket_path()
    stop_event = asyncio.Event()
    manager = FakeManager()
    forwarder = AsyncMock()
    completion_handler = AsyncMock(return_value=True)

    async def unused_loader(channel_id: int):
        raise AssertionError(channel_id)

    server_task = asyncio.create_task(
        LocalChannelServer(
            socket_path,
            manager,
            channel_loader=unused_loader,
            event_forwarder=forwarder,
            task_completion_handler=completion_handler,
        ).run(stop_event)
    )
    await _wait_for_socket(socket_path)
    try:
        await ChannelWorkerClient(socket_path).runtime_local_event(
            device_id="device-a",
            local_task_id="local-a",
            source={"source": "web"},
            event=ExecutionEvent(type="done", subtask_id=16),
        )
    finally:
        stop_event.set()
        await server_task

    forwarder.assert_not_awaited()
    completion_handler.assert_not_awaited()


@pytest.mark.asyncio
async def test_runtime_local_event_failure_is_structured() -> None:
    socket_path = _socket_path()
    stop_event = asyncio.Event()
    manager = FakeManager()

    async def unused_loader(channel_id: int):
        raise AssertionError(channel_id)

    async def failing_forwarder(**_kwargs) -> None:
        raise RuntimeError("provider failed")

    server_task = asyncio.create_task(
        LocalChannelServer(
            socket_path,
            manager,
            channel_loader=unused_loader,
            event_forwarder=failing_forwarder,
        ).run(stop_event)
    )
    await _wait_for_socket(socket_path)
    try:
        with pytest.raises(ChannelWorkerError, match="operation failed") as raised:
            await ChannelWorkerClient(socket_path).runtime_local_event(
                device_id="device-a",
                local_task_id="local-a",
                source={"source": "im"},
                event=ExecutionEvent(type="chunk", subtask_id=16),
            )
    finally:
        stop_event.set()
        await server_task

    assert raised.value.error_code == "channel_worker_internal_error"


@pytest.mark.asyncio
async def test_device_notification_executes_in_worker_server() -> None:
    socket_path = _socket_path()
    stop_event = asyncio.Event()
    manager = FakeManager()
    handler = AsyncMock(return_value={"success": True, "sent": 1})

    async def unused_loader(channel_id: int):
        raise AssertionError(channel_id)

    server_task = asyncio.create_task(
        LocalChannelServer(
            socket_path,
            manager,
            channel_loader=unused_loader,
            device_notification_handler=handler,
        ).run(stop_event)
    )
    await _wait_for_socket(socket_path)
    try:
        result = await ChannelWorkerClient(socket_path).send_device_notification(
            user_id=11,
            target_type="device",
            device_name="Mac mini",
        )
    finally:
        stop_event.set()
        await server_task

    assert result == {"success": True, "sent": 1}
    handler.assert_awaited_once_with(
        user_id=11,
        target_type="device",
        device_name="Mac mini",
    )


@pytest.mark.asyncio
async def test_callback_event_decode_runs_in_named_executor(monkeypatch) -> None:
    socket_path = _socket_path()
    stop_event = asyncio.Event()
    manager = FakeManager()
    decode_threads: list[str] = []
    real_decode = channel_worker_module._decode_execution_event

    def tracked_decode(payload):
        decode_threads.append(threading.current_thread().name)
        return real_decode(payload)

    async def unused_loader(channel_id: int):
        raise AssertionError(channel_id)

    async def forwarder(**_kwargs) -> None:
        return None

    monkeypatch.setattr(
        channel_worker_module,
        "_decode_execution_event",
        tracked_decode,
    )
    server_task = asyncio.create_task(
        LocalChannelServer(
            socket_path,
            manager,
            channel_loader=unused_loader,
            event_forwarder=forwarder,
        ).run(stop_event)
    )
    await _wait_for_socket(socket_path)
    try:
        await ChannelWorkerClient(socket_path).forward_event(
            task_id=5,
            subtask_id=6,
            event=ExecutionEvent(task_id=5, subtask_id=6),
            source="test",
        )
    finally:
        stop_event.set()
        await server_task

    assert decode_threads
    assert all(name.startswith("wegent-channel-event") for name in decode_threads)


@pytest.mark.asyncio
async def test_callback_failure_is_structured_and_never_falls_back() -> None:
    socket_path = _socket_path()
    stop_event = asyncio.Event()
    manager = FakeManager()

    async def unused_loader(channel_id: int):
        raise AssertionError(channel_id)

    async def failing_forwarder(**_kwargs) -> None:
        raise RuntimeError("provider failed")

    server_task = asyncio.create_task(
        LocalChannelServer(
            socket_path,
            manager,
            channel_loader=unused_loader,
            event_forwarder=failing_forwarder,
        ).run(stop_event)
    )
    await _wait_for_socket(socket_path)
    try:
        with pytest.raises(ChannelWorkerError, match="operation failed") as raised:
            await ChannelWorkerClient(socket_path).forward_event(
                task_id=5,
                subtask_id=6,
                event=ExecutionEvent(task_id=5, subtask_id=6),
                source="test",
            )
    finally:
        stop_event.set()
        await server_task

    assert raised.value.error_code == "channel_worker_internal_error"
    assert manager.started == []
    assert manager.restarted == []


@pytest.mark.asyncio
async def test_server_rejects_unknown_or_extra_request_fields() -> None:
    socket_path = _socket_path()
    stop_event = asyncio.Event()
    manager = FakeManager()

    async def unused_loader(channel_id: int):
        raise AssertionError(channel_id)

    server_task = asyncio.create_task(
        LocalChannelServer(
            socket_path,
            manager,
            channel_loader=unused_loader,
        ).run(stop_event)
    )
    await _wait_for_socket(socket_path)
    reader, writer = await asyncio.open_unix_connection(socket_path)
    try:
        await write_channel_frame(writer, {"type": "ping", "extra": True})
        response = await read_channel_frame(reader)
    finally:
        writer.close()
        await writer.wait_closed()
        stop_event.set()
        await server_task

    assert response["type"] == "error"
    assert response["error_code"] == "channel_worker_invalid_request"


@pytest.mark.asyncio
async def test_server_enforces_operation_timeout() -> None:
    socket_path = _socket_path()
    stop_event = asyncio.Event()
    manager = FakeManager()

    async def blocked_loader(channel_id: int):
        del channel_id
        await asyncio.Future()

    server_task = asyncio.create_task(
        LocalChannelServer(
            socket_path,
            manager,
            channel_loader=blocked_loader,
            operation_timeout_seconds=0.02,
        ).run(stop_event)
    )
    await _wait_for_socket(socket_path)
    try:
        with pytest.raises(ChannelWorkerError, match="timed out") as raised:
            await ChannelWorkerClient(
                socket_path,
                response_timeout_seconds=0.2,
            ).reconcile(1)
    finally:
        stop_event.set()
        await server_task

    assert raised.value.error_code == "channel_worker_timeout"


@pytest.mark.asyncio
async def test_server_enforces_connection_limit() -> None:
    socket_path = _socket_path()
    stop_event = asyncio.Event()
    manager = FakeManager()

    async def unused_loader(channel_id: int):
        raise AssertionError(channel_id)

    server = LocalChannelServer(
        socket_path,
        manager,
        channel_loader=unused_loader,
        max_connections=1,
        first_frame_timeout_seconds=1,
    )
    server_task = asyncio.create_task(server.run(stop_event))
    await _wait_for_socket(socket_path)
    held_reader, held_writer = await asyncio.open_unix_connection(socket_path)
    del held_reader
    for _ in range(100):
        if len(server._active) == 1:
            break
        await asyncio.sleep(0.001)
    try:
        with pytest.raises(ChannelWorkerError, match="capacity") as raised:
            await ChannelWorkerClient(socket_path).ping()
    finally:
        held_writer.close()
        await held_writer.wait_closed()
        stop_event.set()
        await server_task

    assert raised.value.error_code == "channel_worker_overloaded"


@pytest.mark.asyncio
async def test_server_socket_is_owner_only_and_removed_on_shutdown() -> None:
    socket_path = _socket_path()
    stop_event = asyncio.Event()
    manager = FakeManager()

    async def unused_loader(channel_id: int):
        raise AssertionError(channel_id)

    server_task = asyncio.create_task(
        LocalChannelServer(
            socket_path,
            manager,
            channel_loader=unused_loader,
        ).run(stop_event)
    )
    await _wait_for_socket(socket_path)

    assert stat.S_IMODE(socket_path.stat().st_mode) == 0o600
    stop_event.set()
    await server_task
    assert not socket_path.exists()


@pytest.mark.asyncio
async def test_database_loader_runs_in_named_bounded_executor(monkeypatch) -> None:
    monkeypatch.setattr(
        channel_worker_module,
        "_load_channel_sync",
        lambda _channel_id: threading.current_thread().name,
    )

    thread_name = await channel_worker_module.load_channel_nonblocking(1)

    assert isinstance(thread_name, str)
    assert thread_name.startswith("wegent-channel-db")


@pytest.mark.asyncio
async def test_worker_starts_channels_before_listening_and_stops_on_exit(
    monkeypatch,
) -> None:
    manager = FakeManager()
    events: list[str] = []
    loop = asyncio.get_running_loop()
    monkeypatch.setattr(loop, "add_signal_handler", lambda *_args: None)
    monkeypatch.setattr(
        channel_worker_module.ChannelManager,
        "get_instance",
        lambda: manager,
    )

    async def tracked_start_all() -> int:
        events.append("start-all")
        return 2

    async def tracked_stop_all() -> int:
        events.append("stop-all")
        return 2

    manager.start_all_enabled = tracked_start_all  # type: ignore[method-assign]
    manager.stop_all = tracked_stop_all  # type: ignore[method-assign]

    class FakeServer:
        def __init__(self, socket_path, worker_manager) -> None:
            del socket_path
            assert worker_manager is manager

        async def run(self, stop_event: asyncio.Event) -> None:
            del stop_event
            events.append("listen")

    monkeypatch.setattr(channel_worker_module, "LocalChannelServer", FakeServer)
    monkeypatch.setattr(channel_worker_module, "setup_logging", lambda: None)

    await channel_worker_module.run_worker()

    assert events == ["start-all", "listen", "stop-all"]
