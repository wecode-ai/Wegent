# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Exercise stalled Redis subscriptions with the real client and Socket.IO ACKs."""

import asyncio
import json
import socket
from collections.abc import AsyncIterator
from types import SimpleNamespace

import pytest
import pytest_asyncio

from app.core import socketio as socketio_core


class RedisSubscriptionServer:
    """Model a Redis connection that stops in the middle of a Pub/Sub response."""

    def __init__(self, partial_response: bool) -> None:
        self.partial_response = partial_response
        self.subscriptions = 0
        self.ready_callback: dict | None = None
        self.handlers: set[asyncio.Task] = set()
        self.subscribers: set[asyncio.StreamWriter] = set()
        self.connections_closed = asyncio.Event()
        self.connections_closed.set()

    @staticmethod
    async def read_command(reader: asyncio.StreamReader) -> list[bytes]:
        header = await reader.readline()
        if not header:
            return []
        args = []
        for _ in range(int(header[1:])):
            length = int((await reader.readline())[1:])
            args.append((await reader.readexactly(length + 2))[:-2])
        return args

    @staticmethod
    def message(channel: bytes, data: bytes) -> bytes:
        return (
            b"*3\r\n$7\r\nmessage\r\n"
            + f"${len(channel)}\r\n".encode()
            + channel
            + b"\r\n"
            + f"${len(data)}\r\n".encode()
            + data
            + b"\r\n"
        )

    async def subscribe(self, writer: asyncio.StreamWriter) -> None:
        self.subscriptions += 1
        self.subscribers.add(writer)
        writer.write(b"*3\r\n$9\r\nsubscribe\r\n$8\r\nsocketio\r\n:1\r\n")
        if self.subscriptions == 1 and self.partial_response:
            writer.write(
                b"*3\r\n$7\r\nmessage\r\n$8\r\nsocketio\r\n$86732\r\n"
                b'{"method":"emit","event":"chat:block_updated"}'
            )
        elif self.subscriptions > 1 and self.ready_callback is not None:
            writer.write(
                self.message(b"socketio", json.dumps(self.ready_callback).encode())
            )
        await writer.drain()

    async def publish_callback(self, channel: bytes, payload: bytes) -> None:
        emit = json.loads(payload)
        sid, namespace, callback_id = emit["callback"]
        callback = json.dumps(
            {
                "method": "callback",
                "host_id": emit["host_id"],
                "sid": sid,
                "namespace": namespace,
                "id": callback_id,
                "args": [{"active": 0, "limit": 10, "queued": 0}],
            }
        ).encode()
        for subscriber in tuple(self.subscribers):
            subscriber.write(self.message(channel, callback))
            await subscriber.drain()

    async def handle(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        task = asyncio.current_task()
        assert task is not None
        self.handlers.add(task)
        self.connections_closed.clear()
        try:
            while args := await self.read_command(reader):
                if args[0].upper() == b"SUBSCRIBE":
                    await self.subscribe(writer)
                elif args[0].upper() == b"PUBLISH":
                    await self.publish_callback(args[1], args[2])
                    writer.write(b":1\r\n")
                elif args[0].upper() == b"PING":
                    if writer in self.subscribers:
                        payload = args[1] if len(args) > 1 else b""
                        writer.write(
                            b"*2\r\n$4\r\npong\r\n"
                            + f"${len(payload)}\r\n".encode()
                            + payload
                            + b"\r\n"
                        )
                    else:
                        writer.write(b"+PONG\r\n")
                else:
                    writer.write(b"+OK\r\n")
                await writer.drain()
        finally:
            self.subscribers.discard(writer)
            writer.close()
            await writer.wait_closed()
            self.handlers.discard(task)
            if not self.handlers:
                self.connections_closed.set()

    async def close(self) -> None:
        tasks = tuple(self.handlers)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


@pytest_asyncio.fixture(params=[True, False], ids=["partial-response", "idle"])
async def redis_subscription(
    request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch
) -> AsyncIterator[RedisSubscriptionServer]:
    stub = RedisSubscriptionServer(partial_response=request.param)
    listener = await asyncio.start_server(stub.handle, "127.0.0.1", 0)
    port = listener.sockets[0].getsockname()[1]
    monkeypatch.setattr(
        socketio_core,
        "settings",
        SimpleNamespace(
            REDIS_URL=f"redis://127.0.0.1:{port}/0",
            SOCKETIO_REDIS_SOCKET_TIMEOUT=0.2,
            SOCKETIO_REDIS_CONNECT_TIMEOUT=1.0,
            SOCKETIO_REDIS_HEALTH_CHECK_INTERVAL=0.1,
        ),
    )
    try:
        yield stub
    finally:
        listener.close()
        await listener.wait_closed()
        await stub.close()


@pytest.mark.asyncio
async def test_stalled_subscription_resubscribes_and_receives_rpc_ack(
    redis_subscription: RedisSubscriptionServer,
) -> None:
    server = socketio_core.create_socketio_server()
    manager = server.manager
    ready = asyncio.Event()
    callback_id = manager._generate_ack_id("subscription-probe", ready.set)
    redis_subscription.ready_callback = {
        "method": "callback",
        "host_id": manager.host_id,
        "sid": "subscription-probe",
        "id": callback_id,
        "args": [],
    }
    manager.initialize()
    try:
        try:
            await asyncio.wait_for(ready.wait(), timeout=4)
        except TimeoutError:
            pytest.fail("Socket.IO Redis listener did not recover from a stalled read")

        result = await server.call(
            "runtime:rpc",
            {"method": "runtime.capacity.get", "payload": {}},
            to="remote-device-sid",
            namespace="/local-executor",
            timeout=4,
        )

        assert result == {"active": 0, "limit": 10, "queued": 0}
        assert redis_subscription.subscriptions >= 2
        transport_socket = manager.pubsub.connection._writer.get_extra_info("socket")
        assert transport_socket.getsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE) != 0
        assert not manager.thread.done()
    finally:
        manager.thread.cancel()
        await manager.thread
        if manager.pubsub is not None:
            await manager.pubsub.aclose()
        if manager.redis is not None:
            await manager.redis.aclose()
        await asyncio.wait_for(redis_subscription.connections_closed.wait(), timeout=2)
