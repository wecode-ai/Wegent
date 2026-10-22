# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Exercise cross-worker acknowledgements without external services."""

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any

import pytest
import socketio
from socketio.async_pubsub_manager import AsyncPubSubManager

from app.core import socketio as socketio_core


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
