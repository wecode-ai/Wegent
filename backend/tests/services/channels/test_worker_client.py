# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the bounded channel-worker client and frame protocol."""

from __future__ import annotations

import asyncio
import os
import tempfile
import threading
from pathlib import Path
from uuid import uuid4

import pytest

from app.services.channels import worker_client as worker_client_module
from app.services.channels.worker_client import (
    CHANNEL_COMPLETION_CONTENT_MAX_CHARS,
    CHANNEL_WORKER_MAX_FRAME_BYTES,
    ChannelWorkerClient,
    ChannelWorkerError,
    ChannelWorkerUnavailableError,
    read_channel_frame,
    write_channel_frame,
)
from shared.models import ExecutionEvent


def _socket_path() -> Path:
    return Path(tempfile.gettempdir()) / (
        f"wegent-channel-client-{os.getpid()}-{uuid4().hex[:6]}.sock"
    )


@pytest.mark.asyncio
async def test_client_rejects_unavailable_worker() -> None:
    with pytest.raises(ChannelWorkerUnavailableError, match="unavailable"):
        await ChannelWorkerClient(_socket_path()).ping()


@pytest.mark.asyncio
async def test_client_times_out_waiting_for_response() -> None:
    socket_path = _socket_path()

    async def handle(reader, writer) -> None:
        await read_channel_frame(reader)
        await reader.read()
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_unix_server(handle, path=socket_path)
    try:
        with pytest.raises(ChannelWorkerError, match="timed out") as raised:
            await ChannelWorkerClient(
                socket_path,
                response_timeout_seconds=0.02,
            ).ping()
    finally:
        server.close()
        await server.wait_closed()
        socket_path.unlink(missing_ok=True)

    assert raised.value.error_code == "channel_worker_timeout"


@pytest.mark.asyncio
async def test_client_surfaces_structured_worker_error() -> None:
    socket_path = _socket_path()

    async def handle(reader, writer) -> None:
        assert await read_channel_frame(reader) == {"type": "ping"}
        await write_channel_frame(
            writer,
            {
                "type": "error",
                "message": "at capacity",
                "error_code": "channel_worker_overloaded",
            },
        )
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_unix_server(handle, path=socket_path)
    try:
        with pytest.raises(ChannelWorkerError, match="at capacity") as raised:
            await ChannelWorkerClient(socket_path).ping()
    finally:
        server.close()
        await server.wait_closed()
        socket_path.unlink(missing_ok=True)

    assert raised.value.error_code == "channel_worker_overloaded"


@pytest.mark.asyncio
async def test_client_methods_emit_strict_protocol_frames() -> None:
    socket_path = _socket_path()
    requests: list[dict] = []
    responses = iter(
        [
            {"type": "result", "result": True},
            {"type": "result", "result": None},
            {"type": "result", "result": {"is_connected": True}},
            {"type": "result", "result": None},
            {"type": "result", "result": True},
            {"type": "result", "result": None},
            {"type": "result", "result": {"success": True, "sent": 1}},
        ]
    )

    async def handle(reader, writer) -> None:
        requests.append(await read_channel_frame(reader))
        await write_channel_frame(writer, next(responses))
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_unix_server(handle, path=socket_path)
    client = ChannelWorkerClient(socket_path)
    try:
        assert await client.reconcile(17, force_restart=True) is True
        await client.stop(17)
        assert await client.status(17) == {"is_connected": True}
        event = ExecutionEvent(
            type="chunk",
            task_id=7,
            subtask_id=8,
            content="hello",
        )
        await client.forward_event(
            task_id=7,
            subtask_id=8,
            event=event,
            source="Callback",
        )
        assert (
            await client.task_completed(
                task_id=7,
                subtask_id=8,
                status="COMPLETED",
                content="done",
                error=None,
            )
            is True
        )
        runtime_event = ExecutionEvent(
            type="chunk",
            subtask_id=9,
            content="local",
        )
        await client.runtime_local_event(
            device_id="device-a",
            local_task_id="local-a",
            source={"source": "im", "channel": "dingtalk"},
            event=runtime_event,
        )
        assert await client.send_device_notification(
            user_id=11,
            target_type="device",
            device_name="Mac mini",
        ) == {"success": True, "sent": 1}
    finally:
        server.close()
        await server.wait_closed()
        socket_path.unlink(missing_ok=True)

    assert requests == [
        {"type": "reconcile", "channel_id": 17, "force_restart": True},
        {"type": "stop", "channel_id": 17},
        {"type": "status", "channel_id": 17},
        {
            "type": "forward_event",
            "task_id": 7,
            "subtask_id": 8,
            "event": event.to_dict(),
            "source": "Callback",
        },
        {
            "type": "task_completed",
            "task_id": 7,
            "subtask_id": 8,
            "status": "COMPLETED",
            "content": "done",
            "error": None,
        },
        {
            "type": "runtime_local_event",
            "device_id": "device-a",
            "local_task_id": "local-a",
            "source": {"source": "im", "channel": "dingtalk"},
            "event": runtime_event.to_dict(),
        },
        {
            "type": "device_notification",
            "user_id": 11,
            "target_type": "device",
            "device_name": "Mac mini",
        },
    ]


@pytest.mark.asyncio
async def test_event_projection_runs_in_named_codec_executor(monkeypatch) -> None:
    socket_path = _socket_path()
    projection_threads: list[str] = []
    real_to_dict = ExecutionEvent.to_dict

    def tracked_to_dict(event: ExecutionEvent):
        projection_threads.append(threading.current_thread().name)
        return real_to_dict(event)

    monkeypatch.setattr(ExecutionEvent, "to_dict", tracked_to_dict)

    async def handle(reader, writer) -> None:
        request = await read_channel_frame(reader)
        assert request["type"] == "forward_event"
        await write_channel_frame(writer, {"type": "result", "result": None})
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_unix_server(handle, path=socket_path)
    try:
        await ChannelWorkerClient(socket_path).forward_event(
            task_id=1,
            subtask_id=2,
            event=ExecutionEvent(task_id=1, subtask_id=2),
            source="test",
        )
    finally:
        server.close()
        await server.wait_closed()
        socket_path.unlink(missing_ok=True)

    assert projection_threads
    assert all(
        name.startswith("wegent-channel-ipc-codec") for name in projection_threads
    )


@pytest.mark.asyncio
async def test_frame_codec_never_runs_on_event_loop_thread(monkeypatch) -> None:
    dump_threads: list[str] = []
    load_threads: list[str] = []
    real_dumps = worker_client_module.orjson.dumps
    real_loads = worker_client_module.orjson.loads

    def tracked_dumps(payload):
        dump_threads.append(threading.current_thread().name)
        return real_dumps(payload)

    def tracked_loads(payload):
        load_threads.append(threading.current_thread().name)
        return real_loads(payload)

    monkeypatch.setattr(worker_client_module.orjson, "dumps", tracked_dumps)
    monkeypatch.setattr(worker_client_module.orjson, "loads", tracked_loads)
    reader = asyncio.StreamReader()

    class Writer:
        def __init__(self) -> None:
            self.data = bytearray()

        def write(self, data: bytes) -> None:
            self.data.extend(data)

        async def drain(self) -> None:
            return None

    writer = Writer()
    await write_channel_frame(writer, {"type": "ping"})  # type: ignore[arg-type]
    reader.feed_data(bytes(writer.data))
    reader.feed_eof()

    assert await read_channel_frame(reader) == {"type": "ping"}
    assert dump_threads and load_threads
    assert all(name.startswith("wegent-channel-ipc-codec") for name in dump_threads)
    assert all(name.startswith("wegent-channel-ipc-codec") for name in load_threads)


@pytest.mark.asyncio
async def test_read_frame_rejects_declared_oversize_without_buffering_body() -> None:
    reader = asyncio.StreamReader()
    reader.feed_data((CHANNEL_WORKER_MAX_FRAME_BYTES + 1).to_bytes(4, "big"))

    with pytest.raises(ChannelWorkerError) as raised:
        await read_channel_frame(reader)

    assert raised.value.error_code == "channel_worker_invalid_frame"


@pytest.mark.parametrize("channel_id", [0, -1, True, "1"])
def test_client_rejects_invalid_channel_id(channel_id) -> None:
    client = ChannelWorkerClient(_socket_path())

    with pytest.raises(ValueError, match="positive integer"):
        asyncio.run(client.status(channel_id))


def test_client_rejects_oversized_completion_content_before_connecting() -> None:
    client = ChannelWorkerClient(_socket_path())

    with pytest.raises(ValueError, match="at most"):
        asyncio.run(
            client.task_completed(
                task_id=1,
                subtask_id=2,
                status="COMPLETED",
                content="x" * (CHANNEL_COMPLETION_CONTENT_MAX_CHARS + 1),
                error=None,
            )
        )
