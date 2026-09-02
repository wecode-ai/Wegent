# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

import asyncio
import threading
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from redis.exceptions import RedisError

from app.core import socketio as socketio_module


def _local_manager(
    *,
    packet_class=None,
) -> socketio_module._TimeoutAsyncRedisManager:
    manager = socketio_module._TimeoutAsyncRedisManager()
    manager.rooms = {"/chat": {}}
    manager.server = SimpleNamespace(
        packet_class=packet_class or socketio_module.socketio_packet.Packet,
        _send_eio_packet=AsyncMock(),
        logger=MagicMock(),
    )
    manager.get_participants = MagicMock(
        side_effect=lambda namespace, room: iter(
            [("sid-1", "eio-1"), ("sid-2", "eio-2")]
        )
    )
    return manager


async def _wait_for_thread_signal(signal: threading.Event) -> None:
    for _ in range(100):
        if signal.is_set():
            return
        await asyncio.sleep(0.001)
    raise TimeoutError("codec worker did not start")


def test_socketio_server_uses_timeout_redis_manager() -> None:
    server = socketio_module.create_socketio_server()

    assert isinstance(server.manager, socketio_module._TimeoutAsyncRedisManager)
    assert isinstance(server, socketio_module._BoundedAsyncServer)
    assert server.async_handlers is True
    assert server.manager.redis_options == {
        "max_connections": socketio_module.SOCKETIO_REDIS_MAX_CONNECTIONS,
        "socket_connect_timeout": (
            socketio_module.SOCKETIO_REDIS_CONNECT_TIMEOUT_SECONDS
        ),
    }
    assert (
        server.eio.create_queue().maxsize
        == socketio_module.SOCKETIO_CLIENT_QUEUE_MAX_PACKETS
    )


@pytest.mark.asyncio
async def test_long_socketio_handler_does_not_block_next_event() -> None:
    server = socketio_module.create_socketio_server()
    first_started = asyncio.Event()
    release_first = asyncio.Event()
    second_completed = asyncio.Event()

    server.manager.sid_from_eio_sid = MagicMock(return_value="sid-1")
    server.manager.is_connected = MagicMock(return_value=True)

    async def handle_event(
        _server,
        _sid,
        _eio_sid,
        data,
        _namespace,
        _packet_id,
    ) -> None:
        if data[0] == "slow":
            first_started.set()
            await release_first.wait()
        else:
            second_completed.set()

    server._handle_event_internal = handle_event

    await server._handle_event("eio-1", "/wework-runtime", 1, ["slow", {}])
    await asyncio.wait_for(first_started.wait(), timeout=0.1)
    await server._handle_event("eio-1", "/wework-runtime", 2, ["probe", {}])

    await asyncio.wait_for(second_completed.wait(), timeout=0.1)
    release_first.set()
    await asyncio.gather(*server._event_handler_tasks)


@pytest.mark.asyncio
async def test_socketio_server_supports_runtime_rpc_call() -> None:
    server = socketio_module.create_socketio_server()

    async def acknowledge_emit(*_args, **kwargs) -> None:
        kwargs["callback"]({"success": True})

    server.emit = acknowledge_emit

    result = await server.call(
        "runtime_request",
        {"method": "runtime.capacity.get"},
        to="sid-1",
        timeout=0.1,
    )

    assert result == {"success": True}


@pytest.mark.asyncio
async def test_socketio_server_times_out_runtime_rpc_call() -> None:
    server = socketio_module.create_socketio_server()
    server.emit = AsyncMock()

    with pytest.raises(socketio_module.socketio.exceptions.TimeoutError):
        await server.call(
            "runtime_request",
            {"method": "runtime.capacity.get"},
            to="sid-1",
            timeout=0.001,
        )


@pytest.mark.asyncio
async def test_engineio_rejects_connections_at_process_capacity() -> None:
    engine = socketio_module._BoundedEngineIOServer(async_mode="asgi")
    engine.sockets.update(
        {
            f"sid-{index}": object()
            for index in range(socketio_module.SOCKETIO_MAX_CONNECTIONS)
        }
    )

    response = await engine._handle_connect({}, "websocket")

    assert response["status"] == "503 SERVICE UNAVAILABLE"
    assert ("Retry-After", "1") in response["headers"]
    assert len(engine.sockets) == socketio_module.SOCKETIO_MAX_CONNECTIONS


def test_long_lived_capacities_reserve_http_connection_headroom() -> None:
    assert (
        socketio_module.SOCKETIO_MAX_CONNECTIONS
        + socketio_module.settings.WEB_MAX_STREAM_CONNECTIONS
        + socketio_module.settings.WEB_HTTP_CONCURRENCY_RESERVE
        <= socketio_module.settings.WEB_MAX_CONCURRENCY
    )


def test_socketio_server_does_not_fall_back_to_unisolated_manager() -> None:
    with (
        patch.object(
            socketio_module,
            "_TimeoutAsyncRedisManager",
            side_effect=RuntimeError("invalid Redis configuration"),
        ),
        pytest.raises(RuntimeError, match="invalid Redis configuration"),
    ):
        socketio_module.create_socketio_server()


@pytest.mark.asyncio
async def test_redis_manager_preserves_normal_publish_result() -> None:
    manager = socketio_module._TimeoutAsyncRedisManager()
    publish = AsyncMock(return_value=3)
    manager.connected = True
    manager.redis = SimpleNamespace(publish=publish)

    result = await manager._publish({"method": "emit"})

    assert result == 3
    publish.assert_awaited_once()


@pytest.mark.asyncio
async def test_redis_manager_bounds_publish_and_keeps_loop_responsive(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        socketio_module,
        "SOCKETIO_REDIS_PUBLISH_TIMEOUT_SECONDS",
        0.01,
    )
    publish_started = asyncio.Event()
    publish_cancelled = asyncio.Event()
    publish_attempts = 0

    async def stalled_publish(*args, **kwargs) -> None:
        nonlocal publish_attempts
        publish_attempts += 1
        if publish_attempts == 1:
            raise RedisError("force manager retry")
        publish_started.set()
        try:
            await asyncio.Event().wait()
        finally:
            publish_cancelled.set()

    manager = socketio_module._TimeoutAsyncRedisManager()
    manager.connected = True
    manager.redis = SimpleNamespace(publish=stalled_publish)
    manager._redis_connect = lambda: setattr(manager, "connected", True)
    publish_task = asyncio.create_task(manager._publish({"method": "emit"}))
    await asyncio.wait_for(publish_started.wait(), timeout=0.1)

    loop_progressed = asyncio.Event()
    asyncio.get_running_loop().call_soon(loop_progressed.set)
    await asyncio.wait_for(loop_progressed.wait(), timeout=0.1)
    assert not publish_task.done()

    assert await asyncio.wait_for(publish_task, timeout=0.1) is None
    assert publish_cancelled.is_set()
    assert publish_attempts == 2
    assert manager.connected is False


@pytest.mark.asyncio
async def test_large_redis_json_encode_does_not_block_event_loop(
    monkeypatch,
) -> None:
    encode_started = threading.Event()
    release_encode = threading.Event()

    def blocking_dumps(data) -> str:
        del data
        encode_started.set()
        assert release_encode.wait(timeout=1)
        return '{"encoded": true}'

    monkeypatch.setattr(socketio_module.json, "dumps", blocking_dumps)
    manager = socketio_module._TimeoutAsyncRedisManager()
    manager.connected = True
    publish = AsyncMock(return_value=1)
    manager.redis = SimpleNamespace(publish=publish)

    publish_task = asyncio.create_task(manager._publish({"data": "x" * (64 * 1024)}))
    await _wait_for_thread_signal(encode_started)

    loop_progressed = asyncio.Event()
    asyncio.get_running_loop().call_soon(loop_progressed.set)
    await asyncio.wait_for(loop_progressed.wait(), timeout=0.1)
    assert not publish_task.done()

    release_encode.set()
    assert await publish_task == 1
    publish.assert_awaited_once_with("socketio", '{"encoded": true}')


@pytest.mark.asyncio
async def test_large_local_packet_encode_keeps_room_and_skip_semantics() -> None:
    encode_started = threading.Event()
    release_encode = threading.Event()

    class BlockingPacket:
        def __init__(self, packet_type, *, namespace, data, id=None):
            del packet_type, namespace, id
            self.data = data

        def encode(self) -> str:
            encode_started.set()
            assert release_encode.wait(timeout=1)
            return '2/chat,["event",{}]'

    manager = _local_manager(packet_class=BlockingPacket)
    emit_task = asyncio.create_task(
        manager._emit_local(
            "event",
            {"result": "x" * (64 * 1024)},
            "/chat",
            room="task:1",
            skip_sid="sid-2",
        )
    )
    await _wait_for_thread_signal(encode_started)

    loop_progressed = asyncio.Event()
    asyncio.get_running_loop().call_soon(loop_progressed.set)
    await asyncio.wait_for(loop_progressed.wait(), timeout=0.1)
    assert not emit_task.done()

    release_encode.set()
    await emit_task

    manager.get_participants.assert_called_once_with("/chat", "task:1")
    manager.server._send_eio_packet.assert_awaited_once()
    assert manager.server._send_eio_packet.await_args.args[0] == "eio-1"


@pytest.mark.asyncio
async def test_oversized_local_packet_is_rejected_before_client_queue() -> None:
    manager = _local_manager()

    with pytest.raises(socketio_module.SocketIOPacketTooLargeError):
        await manager._build_engineio_packets(
            "x" * (socketio_module.SOCKETIO_MAX_HTTP_BUFFER_SIZE + 1)
        )


@pytest.mark.asyncio
async def test_slow_client_queue_timeout_aborts_connection(monkeypatch) -> None:
    monkeypatch.setattr(
        socketio_module,
        "SOCKETIO_CLIENT_QUEUE_PUT_TIMEOUT_SECONDS",
        0.01,
    )
    server = socketio_module.create_socketio_server()
    socket = SimpleNamespace(queue=server.eio.create_queue(), closed=False)

    async def blocked_send(packet) -> None:
        await socket.queue.put(packet)

    socket.send = blocked_send
    for _ in range(socketio_module.SOCKETIO_CLIENT_QUEUE_MAX_PACKETS):
        socket.queue.put_nowait(object())
    server.eio.sockets["slow-eio"] = socket
    server.eio.abort_slow_client = AsyncMock()

    await server._send_eio_packet("slow-eio", object())

    server.eio.abort_slow_client.assert_awaited_once_with("slow-eio")


@pytest.mark.asyncio
async def test_small_inbound_socketio_packet_decode_does_not_block_loop() -> None:
    decode_started = threading.Event()
    release_decode = threading.Event()

    class BlockingPacket:
        def __init__(self, *, encoded_packet) -> None:
            del encoded_packet
            decode_started.set()
            assert release_decode.wait(timeout=1)
            self.packet_type = socketio_module.socketio_packet.EVENT
            self.namespace = "/chat"
            self.id = None
            self.data = ["event", {"value": "decoded"}]

    server = socketio_module.create_socketio_server()
    server.packet_class = BlockingPacket
    server._handle_event = AsyncMock()
    decode_task = asyncio.create_task(server._handle_eio_message("eio-1", "event"))
    await _wait_for_thread_signal(decode_started)

    loop_progressed = asyncio.Event()
    asyncio.get_running_loop().call_soon(loop_progressed.set)
    await asyncio.wait_for(loop_progressed.wait(), timeout=0.1)
    assert not decode_task.done()

    release_decode.set()
    await decode_task
    server._handle_event.assert_awaited_once()


@pytest.mark.asyncio
async def test_inbound_event_waits_for_process_rate_admission_before_decode() -> None:
    trace: list[str] = []

    class EventPacket:
        def __init__(self, *, encoded_packet) -> None:
            del encoded_packet
            trace.append("decode")
            self.packet_type = socketio_module.socketio_packet.EVENT
            self.namespace = "/chat"
            self.id = None
            self.data = ["event", {"value": "decoded"}]

    class RecordingAdmission:
        async def acquire(self) -> None:
            trace.append("admit")

    async def handle_event(*args) -> None:
        del args
        trace.append("handle")

    server = socketio_module.create_socketio_server()
    server.packet_class = EventPacket
    server._event_admission = RecordingAdmission()
    server._handle_event = handle_event

    await server._handle_eio_message("eio-1", "event")

    assert trace == ["admit", "decode", "handle"]


@pytest.mark.asyncio
async def test_binary_header_and_attachment_are_admitted_before_codec_work() -> None:
    trace: list[str] = []

    class BinaryEventPacket:
        def __init__(self, *, encoded_packet) -> None:
            del encoded_packet
            trace.append("decode")
            self.packet_type = socketio_module.socketio_packet.BINARY_EVENT
            self.namespace = "/chat"
            self.id = None
            self.data = ["event", {"value": "decoded"}]

        def add_attachment(self, data) -> bool:
            del data
            trace.append("assemble")
            return True

    class RecordingAdmission:
        async def acquire(self) -> None:
            trace.append("admit")

    async def handle_event(*args) -> None:
        del args
        trace.append("handle")

    server = socketio_module.create_socketio_server()
    server.packet_class = BinaryEventPacket
    server._event_admission = RecordingAdmission()
    server._handle_event = handle_event

    await server._handle_eio_message("eio-1", "binary-event")
    await server._handle_eio_message("eio-1", b"attachment")

    assert trace == ["admit", "decode", "admit", "assemble", "handle"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "packet_type",
    [
        socketio_module.socketio_packet.CONNECT,
        socketio_module.socketio_packet.DISCONNECT,
        socketio_module.socketio_packet.ACK,
    ],
)
async def test_control_packets_are_admitted_before_decode(
    packet_type: int,
) -> None:
    trace: list[str] = []

    class ControlPacket:
        def __init__(self, *, encoded_packet) -> None:
            del encoded_packet
            trace.append("decode")
            self.packet_type = packet_type
            self.namespace = "/chat"
            self.id = 1
            self.data = {}

    class RecordingAdmission:
        async def acquire(self) -> None:
            trace.append("admit")

    server = socketio_module.create_socketio_server()
    server.packet_class = ControlPacket
    server._event_admission = RecordingAdmission()
    server._handle_connect = AsyncMock()
    server._handle_disconnect = AsyncMock()
    server._handle_ack = AsyncMock()

    await server._handle_eio_message("eio-1", "control")

    assert trace == ["admit", "decode"]


def test_stream_and_socketio_share_one_process_event_budget() -> None:
    from app.services.execution import stream_client

    assert (
        socketio_module.web_realtime_event_admission
        is stream_client.web_realtime_event_admission
    )


@pytest.mark.asyncio
async def test_local_emit_preserves_broadcast_and_callback_packet_ids() -> None:
    packet_ids: list[int | None] = []

    class RecordingPacket:
        def __init__(self, packet_type, *, namespace, data, id=None):
            del packet_type, namespace
            self.data = data
            packet_ids.append(id)

        def encode(self) -> str:
            return '2["event",{}]'

    manager = _local_manager(packet_class=RecordingPacket)
    callback = MagicMock()
    manager._generate_ack_id = MagicMock(side_effect=[7, 8])

    await manager._emit_local(
        "event",
        {"value": "small"},
        "/chat",
        room=None,
        callback=callback,
    )

    manager.get_participants.assert_called_once_with("/chat", None)
    assert packet_ids == [7, 8]
    assert manager._generate_ack_id.call_args_list[0].args == ("sid-1", callback)
    assert manager._generate_ack_id.call_args_list[1].args == ("sid-2", callback)
    assert manager.server._send_eio_packet.await_count == 2


@pytest.mark.asyncio
async def test_local_emit_bounds_participant_send_tasks() -> None:
    active_sends = 0
    max_active_sends = 0
    send_count = 0
    window_full = asyncio.Event()
    release_sends = asyncio.Event()

    async def blocked_send(eio_sid, packet) -> None:
        nonlocal active_sends, max_active_sends, send_count
        del eio_sid, packet
        active_sends += 1
        max_active_sends = max(max_active_sends, active_sends)
        if active_sends == socketio_module.SOCKETIO_LOCAL_SEND_CONCURRENCY:
            window_full.set()
        try:
            await release_sends.wait()
        finally:
            active_sends -= 1
            send_count += 1

    manager = _local_manager()
    manager.get_participants = MagicMock(
        return_value=iter((f"sid-{index}", f"eio-{index}") for index in range(100))
    )
    manager.server._send_eio_packet = blocked_send

    emit_task = asyncio.create_task(
        manager._emit_local("event", {"value": "small"}, "/chat")
    )
    await asyncio.wait_for(window_full.wait(), timeout=0.1)

    loop_progressed = asyncio.Event()
    asyncio.get_running_loop().call_soon(loop_progressed.set)
    await asyncio.wait_for(loop_progressed.wait(), timeout=0.1)
    assert not emit_task.done()
    assert max_active_sends == socketio_module.SOCKETIO_LOCAL_SEND_CONCURRENCY

    release_sends.set()
    await emit_task

    assert send_count == 100
    assert max_active_sends <= socketio_module.SOCKETIO_LOCAL_SEND_CONCURRENCY


@pytest.mark.asyncio
async def test_local_emit_preserves_packet_order_per_participant() -> None:
    deliveries: dict[str, list[str]] = {"eio-1": [], "eio-2": []}

    class MultiPacket:
        def __init__(self, packet_type, *, namespace, data, id=None):
            del packet_type, namespace, id
            self.data = data

        def encode(self) -> list[str]:
            return ["first", "second"]

    async def record_send(eio_sid, packet) -> None:
        await asyncio.sleep(0)
        deliveries[eio_sid].append(packet.data)

    manager = _local_manager(packet_class=MultiPacket)
    manager.server._send_eio_packet = record_send

    await manager._emit_local("event", {"value": "small"}, "/chat")

    assert deliveries == {
        "eio-1": ["first", "second"],
        "eio-2": ["first", "second"],
    }


@pytest.mark.asyncio
async def test_pubsub_emit_preserves_tuple_room_skip_and_message_shape() -> None:
    packet_payloads: list[list[object]] = []

    class RecordingPacket:
        def __init__(self, packet_type, *, namespace, data, id=None):
            del packet_type, namespace, id
            self.data = data
            packet_payloads.append(data)

        def encode(self) -> str:
            return '2["event",1,2]'

    manager = _local_manager(packet_class=RecordingPacket)
    manager._publish = AsyncMock()

    await manager.emit(
        "event",
        (1, 2),
        namespace="/chat",
        room="task:1",
        skip_sid=["sid-2"],
    )

    assert packet_payloads == [["event", 1, 2]]
    manager.server._send_eio_packet.assert_awaited_once()
    assert manager.server._send_eio_packet.await_args.args[0] == "eio-1"
    published = manager._publish.await_args.args[0]
    assert published == {
        "method": "emit",
        "event": "event",
        "data": [1, 2],
        "binary": False,
        "namespace": "/chat",
        "room": "task:1",
        "skip_sid": ["sid-2"],
        "callback": None,
        "host_id": manager.host_id,
    }


@pytest.mark.asyncio
async def test_ignore_queue_emits_locally_without_redis_publish() -> None:
    manager = _local_manager()
    manager._publish = AsyncMock()

    await manager.emit(
        "event",
        {"value": "small"},
        namespace="/chat",
        to="task:1",
        ignore_queue=True,
    )

    manager.get_participants.assert_called_once_with("/chat", "task:1")
    assert manager.server._send_eio_packet.await_count == 2
    manager._publish.assert_not_awaited()


@pytest.mark.asyncio
async def test_small_remote_json_decode_does_not_block_event_loop(
    monkeypatch,
) -> None:
    decode_started = threading.Event()
    release_decode = threading.Event()

    def blocking_loads(data):
        del data
        decode_started.set()
        assert release_decode.wait(timeout=1)
        return {
            "method": "emit",
            "event": "event",
            "data": [{"value": "decoded"}],
            "namespace": "/chat",
            "host_id": "remote-host",
        }

    async def listen():
        yield "x"

    monkeypatch.setattr(socketio_module.json, "loads", blocking_loads)
    manager = _local_manager()
    manager._listen = listen
    manager._handle_emit = AsyncMock()

    listener_task = asyncio.create_task(manager._thread())
    await _wait_for_thread_signal(decode_started)

    loop_progressed = asyncio.Event()
    asyncio.get_running_loop().call_soon(loop_progressed.set)
    await asyncio.wait_for(loop_progressed.wait(), timeout=0.1)
    assert not listener_task.done()

    release_decode.set()
    await listener_task
    manager._handle_emit.assert_awaited_once()


@pytest.mark.asyncio
async def test_redis_pubsub_is_admitted_before_json_decode(monkeypatch) -> None:
    trace: list[str] = []

    class RecordingAdmission:
        async def acquire(self) -> None:
            trace.append("admit")

    def tracked_loads(data):
        del data
        trace.append("decode")
        return {
            "method": "emit",
            "event": "event",
            "data": [{"value": "decoded"}],
            "namespace": "/chat",
            "host_id": "remote-host",
        }

    async def listen():
        yield "small"

    monkeypatch.setattr(socketio_module.json, "loads", tracked_loads)
    manager = socketio_module._TimeoutAsyncRedisManager(
        event_admission=RecordingAdmission(),
    )
    manager.server = SimpleNamespace(logger=MagicMock())
    manager._listen = listen
    manager._handle_emit = AsyncMock()

    await manager._thread()

    assert trace == ["admit", "decode"]
    manager._handle_emit.assert_awaited_once()
