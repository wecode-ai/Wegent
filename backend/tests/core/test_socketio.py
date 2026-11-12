# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Exercise cross-worker acknowledgements without external services."""

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from typing import Any

import pytest
import socketio
from engineio.async_socket import AsyncSocket
from fastapi import Response
from socketio.async_pubsub_manager import AsyncPubSubManager

from app.api.endpoints.health import shutdown_status
from app.core import socketio as socketio_core
from app.core import socketio_redis


@pytest.mark.parametrize("requested_interval,expected_interval", [(30, 15), (1, 1)])
async def test_ack_probe_runs_before_idle_subscription_expires(
    monkeypatch: pytest.MonkeyPatch,
    requested_interval: float,
    expected_interval: float,
) -> None:
    manager = socketio_redis.ObservedRedisManager(
        "redis://localhost", redis_options={"socket_timeout": 30}
    )
    probes = []
    intervals = []

    async def check_ack() -> None:
        probes.append(True)

    async def sleep(interval: float) -> None:
        intervals.append(interval)
        raise asyncio.CancelledError

    monkeypatch.setattr(manager, "check_ack", check_ack)
    monkeypatch.setattr(asyncio, "sleep", sleep)

    with pytest.raises(asyncio.CancelledError):
        await manager.run_ack_probe(requested_interval)

    assert probes == [True]
    assert intervals == [expected_interval]


class MemoryPubSubManager(AsyncPubSubManager):
    """Replace the broker transport while using the real Socket.IO callbacks."""

    def __init__(self) -> None:
        super().__init__()
        self.published: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self.incoming: asyncio.Queue[str] = asyncio.Queue()

    async def _publish(self, data: dict[str, Any]) -> None:
        await self.published.put(data)

    async def _listen(self) -> AsyncIterator[str]:
        while True:
            yield await self.incoming.get()


async def test_connect_handler_joins_local_user_room_before_notifications() -> None:
    manager = MemoryPubSubManager()
    server = socketio.AsyncServer(async_mode="asgi", client_manager=manager)
    eio_sid = "engineio-sid"
    client = AsyncSocket(server.eio, eio_sid)
    server.eio.sockets[eio_sid] = client

    @server.on("connect", namespace="/chat")
    async def on_connect(sid: str, environ: dict, auth: dict) -> None:
        await server.enter_room(sid, "user:7", namespace="/chat")

    await server._handle_eio_connect(eio_sid, {})
    listener = manager.thread
    try:
        await server._handle_connect(eio_sid, "/chat", {"token": "test-token"})
        sid = manager.sid_from_eio_sid(eio_sid, "/chat")

        assert list(manager.get_participants("/chat", "user:7")) == [(sid, eio_sid)]
        assert manager.published.empty()
        await asyncio.wait_for(client.queue.get(), timeout=2)

        await server.emit(
            "task:status",
            {"status": "COMPLETED"},
            room="user:7",
            namespace="/chat",
            ignore_queue=True,
        )
        notification = await asyncio.wait_for(client.queue.get(), timeout=2)

        assert notification.data == '2/chat,["task:status",{"status":"COMPLETED"}]'
    finally:
        listener.cancel()
        await asyncio.gather(listener, return_exceptions=True)


async def test_startup_receives_cross_worker_ack_without_local_connection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = MemoryPubSubManager()
    server = socketio.AsyncServer(async_mode="asgi", client_manager=manager)
    monkeypatch.setattr(socketio_core, "_sio_instance", server)
    result = {"success": True, "stdout": "project/\n", "exit_code": 0}

    assert socketio_core.initialize_socketio_server() is server
    listener = manager.thread
    call = asyncio.create_task(
        server.call(
            "device:execute_command",
            {"command": "ls -a -p"},
            to="device-sid",
            namespace="/local-executor",
            timeout=2,
        )
    )
    try:
        message = await asyncio.wait_for(manager.published.get(), timeout=2)
        sid, namespace, callback_id = message["callback"]
        await manager.incoming.put(
            json.dumps(
                {
                    "method": "callback",
                    "host_id": message["host_id"],
                    "sid": sid,
                    "namespace": namespace,
                    "id": callback_id,
                    "args": [result],
                }
            )
        )

        assert await call == result
        assert server.environ == {}
    finally:
        call.cancel()
        listener.cancel()
        await asyncio.gather(call, listener, return_exceptions=True)


async def test_repeated_startup_and_first_connection_keep_one_listener(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = MemoryPubSubManager()
    server = socketio.AsyncServer(async_mode="asgi", client_manager=manager)
    monkeypatch.setattr(socketio_core, "_sio_instance", server)

    socketio_core.initialize_socketio_server()
    listener = manager.thread
    try:
        socketio_core.initialize_socketio_server()
        await server._handle_eio_connect("engineio-sid", {})

        assert manager.thread is listener
    finally:
        listener.cancel()
        await asyncio.gather(listener, return_exceptions=True)


async def test_ack_probe_drives_readiness_through_the_callback_listener(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    incoming: asyncio.Queue[str] = asyncio.Queue()
    published: list[dict[str, Any]] = []
    deliver = True

    async def publish(
        _manager: socketio.AsyncRedisManager, data: dict[str, Any]
    ) -> int:
        published.append(data)
        if deliver:
            await incoming.put(json.dumps(data))
        return 1

    async def listen(_manager: socketio.AsyncRedisManager) -> AsyncIterator[str]:
        while True:
            yield await incoming.get()

    monkeypatch.setattr(socketio.AsyncRedisManager, "_publish", publish)
    monkeypatch.setattr(socketio.AsyncRedisManager, "_listen", listen)
    monkeypatch.setattr(socketio_redis, "ACK_PROBE_TIMEOUT_SECONDS", 0.05)
    caplog.set_level(logging.DEBUG, logger=socketio_redis.__name__)
    server = socketio_core.create_socketio_server()
    manager = server.manager
    monkeypatch.setattr(socketio_core, "_sio_instance", server)
    socketio_core.initialize_socketio_server()
    try:
        await manager.check_ack()
        first_probe = published[-1]
        correlation = (
            f"host_id={first_probe['host_id']} sid={first_probe['sid']} "
            f"callback_id={first_probe['id']}"
        )
        assert f"stage=publish {correlation} outcome=published" in caplog.text
        assert f"stage=receive {correlation} outcome=received" in caplog.text
        assert f"stage=match {correlation} outcome=matched" in caplog.text

        deliver = False
        for _ in range(socketio_redis.ACK_PROBE_FAILURE_THRESHOLD - 1):
            await manager.check_ack()
        assert shutdown_status(Response()) == {"is_shutting_down": False}

        await manager.check_ack()
        late_probe = published[-1]
        assert set(manager.callbacks[late_probe["sid"]]) == {0}
        response = Response()
        assert shutdown_status(response)["status"] == "socketio_ack_unavailable"
        assert response.status_code == 503
        assert "ACK probe unhealthy" in caplog.text

        await incoming.put(json.dumps(late_probe))
        deliver = True
        await manager.check_ack()
        assert published[-1]["id"] > late_probe["id"]
        assert "outcome=missing" in caplog.text
        assert shutdown_status(Response()) == {"is_shutting_down": False}
        assert "ACK probe recovered" in caplog.text
    finally:
        manager.thread.cancel()
        await asyncio.gather(manager.thread, return_exceptions=True)
