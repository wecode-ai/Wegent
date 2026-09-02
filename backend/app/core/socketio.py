# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Socket.IO server configuration and initialization.

This module provides the Socket.IO server instance with Redis adapter
for multi-worker deployments.
"""

import asyncio
import base64
import json
import logging
from functools import partial
from typing import Any

import socketio
from engineio import AsyncServer as EngineIOAsyncServer
from engineio import packet as eio_packet
from socketio import packet as socketio_packet

from app.core.bounded_executor import BoundedExecutor
from app.core.config import settings
from app.core.loop_rate_admission import (
    LoopLocalTokenBucket,
    web_realtime_event_admission,
)
from app.core.payload_codec import run_payload_codec

logger = logging.getLogger(__name__)

# Socket.IO server configuration
SOCKETIO_PATH = "/socket.io"
SOCKETIO_CORS_ORIGINS = "*"
SOCKETIO_PING_INTERVAL = 25  # seconds
SOCKETIO_PING_TIMEOUT = 20  # seconds
SOCKETIO_MAX_HTTP_BUFFER_SIZE = 1000000  # 1MB
SOCKETIO_REDIS_PUBLISH_TIMEOUT_SECONDS = 5.0
SOCKETIO_REDIS_CONNECT_TIMEOUT_SECONDS = 2.0
SOCKETIO_LOCAL_SEND_CONCURRENCY = 32
SOCKETIO_EVENT_HANDLER_CONCURRENCY = 64
SOCKETIO_CLIENT_QUEUE_MAX_PACKETS = 8
SOCKETIO_CLIENT_QUEUE_PUT_TIMEOUT_SECONDS = 1.0
SOCKETIO_REDIS_MESSAGE_MAX_BYTES = 2 * 1024 * 1024
SOCKETIO_REDIS_MAX_CONNECTIONS = SOCKETIO_LOCAL_SEND_CONCURRENCY + 1
SOCKETIO_MAX_CONNECTIONS = settings.WEB_MAX_WEBSOCKET_CONNECTIONS
_SOCKETIO_INBOUND_CODEC_EXECUTOR = BoundedExecutor(
    max_workers=4,
    max_in_flight=16,
    max_waiters=SOCKETIO_MAX_CONNECTIONS,
    thread_name_prefix="wegent-socketio-codec",
)


class SocketIOPacketTooLargeError(ValueError):
    """Raised before an oversized Socket.IO packet reaches a client queue."""


class _BoundedEngineIOServer(EngineIOAsyncServer):
    """Give every Engine.IO client a finite outbound packet queue."""

    async def _handle_connect(
        self,
        environ: dict[str, Any],
        transport: str,
        jsonp_index: int | None = None,
    ) -> dict[str, Any]:
        """Reject new sessions before they consume unbounded Web capacity."""
        if len(self.sockets) >= SOCKETIO_MAX_CONNECTIONS:
            logger.warning(
                "Rejecting Socket.IO connection at process capacity: %d",
                SOCKETIO_MAX_CONNECTIONS,
            )
            return {
                "status": "503 SERVICE UNAVAILABLE",
                "headers": [
                    ("Content-Type", "application/json"),
                    ("Retry-After", "1"),
                ],
                "response": b'{"detail":"Socket.IO connection capacity exhausted"}',
            }
        return await super()._handle_connect(environ, transport, jsonp_index)

    def create_queue(self, *args: Any, **kwargs: Any) -> asyncio.Queue[Any]:
        if args or kwargs:
            raise TypeError("Engine.IO client queues use fixed Backend limits")
        return asyncio.Queue(maxsize=SOCKETIO_CLIENT_QUEUE_MAX_PACKETS)

    async def abort_slow_client(self, sid: str) -> None:
        """Close a client without trying to enqueue another packet."""
        socket = self.sockets.pop(sid, None)
        if socket is None:
            return
        await socket.close(
            wait=False,
            abort=True,
            reason=self.reason.TRANSPORT_ERROR,
        )
        while True:
            try:
                socket.queue.get_nowait()
                socket.queue.task_done()
            except asyncio.QueueEmpty:
                return


class _BoundedAsyncServer(socketio.AsyncServer):
    """Bound Socket.IO decoding, handler creation, and client delivery."""

    def __init__(
        self,
        *args: Any,
        event_admission: LoopLocalTokenBucket | None = None,
        **kwargs: Any,
    ) -> None:
        self._event_admission = event_admission or web_realtime_event_admission
        self._event_handler_slots = asyncio.Semaphore(
            SOCKETIO_EVENT_HANDLER_CONCURRENCY
        )
        self._event_handler_tasks: set[asyncio.Task[Any]] = set()
        super().__init__(*args, **kwargs)

    def _engineio_server_class(self) -> type[EngineIOAsyncServer]:
        return _BoundedEngineIOServer

    async def _send_eio_packet(self, eio_sid: str, eio_pkt: Any) -> None:
        try:
            await asyncio.wait_for(
                super()._send_eio_packet(eio_sid, eio_pkt),
                timeout=SOCKETIO_CLIENT_QUEUE_PUT_TIMEOUT_SECONDS,
            )
        except TimeoutError:
            logger.warning(
                "Disconnecting slow Socket.IO client after outbound queue timeout: %s",
                eio_sid,
            )
            await self.eio.abort_slow_client(eio_sid)

    async def _handle_eio_message(self, eio_sid: str, data: Any) -> None:
        """Admit every inbound packet before bounded off-loop decoding."""
        # Admission must precede parsing. Otherwise a flood of small control,
        # event, invalid, or binary-attachment packets can consume the sole Web
        # event loop before the decoded packet type is known.
        await self._event_admission.acquire()
        if eio_sid in self._binary_packet:
            packet = self._binary_packet[eio_sid]
            complete = await _SOCKETIO_INBOUND_CODEC_EXECUTOR.run(
                packet.add_attachment,
                data,
            )
            if not complete:
                return
            del self._binary_packet[eio_sid]
        else:
            packet = await _SOCKETIO_INBOUND_CODEC_EXECUTOR.run(
                partial(self.packet_class, encoded_packet=data),
            )
            if packet.packet_type in {
                socketio_packet.BINARY_EVENT,
                socketio_packet.BINARY_ACK,
            }:
                self._binary_packet[eio_sid] = packet
                return

        if packet.packet_type == socketio_packet.CONNECT:
            await self._handle_connect(eio_sid, packet.namespace, packet.data)
        elif packet.packet_type == socketio_packet.DISCONNECT:
            await self._handle_disconnect(
                eio_sid,
                packet.namespace,
                self.reason.CLIENT_DISCONNECT,
            )
        elif packet.packet_type in {
            socketio_packet.EVENT,
            socketio_packet.BINARY_EVENT,
        }:
            await self._handle_event(
                eio_sid,
                packet.namespace,
                packet.id,
                packet.data,
            )
        elif packet.packet_type in {
            socketio_packet.ACK,
            socketio_packet.BINARY_ACK,
        }:
            await self._handle_ack(
                eio_sid,
                packet.namespace,
                packet.id,
                packet.data,
            )
        elif packet.packet_type == socketio_packet.CONNECT_ERROR:
            raise ValueError("Unexpected CONNECT_ERROR packet")
        else:
            raise ValueError("Unknown Socket.IO packet type")

    async def _handle_event(
        self,
        eio_sid: str,
        namespace: str | None,
        packet_id: int | None,
        data: list[Any],
    ) -> None:
        """Run client handlers concurrently without creating unbounded tasks."""
        normalized_namespace = namespace or "/"
        sid = self.manager.sid_from_eio_sid(eio_sid, normalized_namespace)
        self.logger.info(
            'received event "%s" from %s [%s]',
            data[0],
            sid,
            normalized_namespace,
        )
        if not self.manager.is_connected(sid, normalized_namespace):
            self.logger.warning(
                "%s is not connected to namespace %s",
                sid,
                normalized_namespace,
            )
            return

        await self._event_handler_slots.acquire()
        task = self.start_background_task(
            self._run_event_handler,
            sid,
            eio_sid,
            data,
            normalized_namespace,
            packet_id,
        )
        self._event_handler_tasks.add(task)
        task.add_done_callback(self._event_handler_tasks.discard)

    async def _run_event_handler(
        self,
        sid: str,
        eio_sid: str,
        data: list[Any],
        namespace: str,
        packet_id: int | None,
    ) -> None:
        try:
            await self._handle_event_internal(
                self,
                sid,
                eio_sid,
                data,
                namespace,
                packet_id,
            )
        finally:
            self._event_handler_slots.release()


class _TimeoutAsyncRedisManager(socketio.AsyncRedisManager):
    """Bound Socket.IO payload CPU and Redis network waits."""

    def __init__(
        self,
        *args: Any,
        event_admission: LoopLocalTokenBucket | None = None,
        **kwargs: Any,
    ) -> None:
        self._event_admission = event_admission or web_realtime_event_admission
        super().__init__(*args, **kwargs)

    @staticmethod
    def _prepare_pubsub_data(data: Any) -> tuple[list[Any], bool]:
        if isinstance(data, tuple):
            normalized_data = list(data)
        else:
            normalized_data = [data]
        binary = socketio_packet.Packet.data_is_binary(normalized_data)
        if binary:
            deconstructed, attachments = socketio_packet.Packet.deconstruct_binary(
                normalized_data
            )
            normalized_data = [
                deconstructed,
                *[base64.b64encode(item).decode() for item in attachments],
            ]
        return normalized_data, binary

    async def emit(
        self,
        event: str,
        data: Any,
        namespace: str | None = None,
        room: str | None = None,
        skip_sid: str | list[str] | None = None,
        callback: Any = None,
        to: str | None = None,
        **kwargs: Any,
    ) -> None:
        """Preserve pub/sub semantics while isolating large payload projection."""
        room = to or room
        namespace = namespace or "/"
        if kwargs.get("ignore_queue"):
            await self._emit_local(
                event,
                data,
                namespace,
                room=room,
                skip_sid=skip_sid,
                callback=callback,
            )
            return

        if callback is not None:
            if self.server is None:
                raise RuntimeError(
                    "Callbacks can only be issued from the context of a server."
                )
            if room is None:
                raise ValueError("Cannot use callback without a room set.")
            callback_id = self._generate_ack_id(room, callback)
            remote_callback = (room, namespace, callback_id)
        else:
            remote_callback = None

        normalized_data, binary = await run_payload_codec(
            self._prepare_pubsub_data,
            data,
            payload_hint=data,
        )
        message = {
            "method": "emit",
            "event": event,
            "data": normalized_data,
            "binary": binary,
            "namespace": namespace,
            "room": room,
            "skip_sid": skip_sid,
            "callback": remote_callback,
            "host_id": self.host_id,
        }
        await self._handle_emit(message)
        await self._publish(message)

    async def _encode_socketio_packet(self, packet: Any) -> Any:
        return await run_payload_codec(
            packet.encode,
            payload_hint=packet.data,
        )

    async def _build_engineio_packets(self, encoded_packet: Any) -> list[Any]:
        if not isinstance(encoded_packet, list):
            encoded_packet = [encoded_packet]
        for payload in encoded_packet:
            payload_size = await run_payload_codec(
                self._encoded_payload_size,
                payload,
                payload_hint=payload,
            )
            if payload_size > SOCKETIO_MAX_HTTP_BUFFER_SIZE:
                raise SocketIOPacketTooLargeError(
                    "Socket.IO packet exceeds " f"{SOCKETIO_MAX_HTTP_BUFFER_SIZE} bytes"
                )
        packets = [
            eio_packet.Packet(eio_packet.MESSAGE, payload) for payload in encoded_packet
        ]
        for packet in packets:
            if isinstance(packet.data, (bytes, bytearray)):
                # HTTP polling applies transport-specific base64 encoding.
                # Caching the WebSocket representation here would corrupt it.
                continue
            # Engine.IO encodes queued packets later in its WebSocket/polling
            # writer. Populate its cache here so that second encoding is O(1).
            await run_payload_codec(
                packet.encode,
                payload_hint=packet.data,
            )
        return packets

    @staticmethod
    def _encoded_payload_size(payload: Any) -> int:
        if isinstance(payload, str):
            return len(payload.encode("utf-8"))
        if isinstance(payload, (bytes, bytearray)):
            return len(payload)
        raise TypeError(f"Unsupported Socket.IO packet payload: {type(payload)!r}")

    async def _emit_local(
        self,
        event: str,
        data: Any,
        namespace: str | None,
        room: str | None = None,
        skip_sid: str | list[str] | None = None,
        callback: Any = None,
        to: str | None = None,
    ) -> None:
        """Emit locally with Socket.IO and Engine.IO encoding off the loop."""
        room = to or room
        if namespace not in self.rooms:
            return
        if isinstance(data, tuple):
            normalized_data = list(data)
        elif data is not None:
            normalized_data = [data]
        else:
            normalized_data = []
        skipped = skip_sid if isinstance(skip_sid, list) else [skip_sid]
        pending_sends: set[asyncio.Task[None]] = set()

        try:
            if not callback:
                packet = self.server.packet_class(
                    socketio_packet.EVENT,
                    namespace=namespace,
                    data=[event] + normalized_data,
                )
                encoded_packet = await self._encode_socketio_packet(packet)
                engineio_packets = await self._build_engineio_packets(encoded_packet)
                for sid, eio_sid in self.get_participants(namespace, room):
                    if sid not in skipped:
                        pending_sends = await self._queue_local_send(
                            pending_sends,
                            eio_sid,
                            engineio_packets,
                        )
            else:
                for sid, eio_sid in self.get_participants(namespace, room):
                    if sid not in skipped:
                        callback_id = self._generate_ack_id(sid, callback)
                        packet = self.server.packet_class(
                            socketio_packet.EVENT,
                            namespace=namespace,
                            data=[event] + normalized_data,
                            id=callback_id,
                        )
                        encoded_packet = await self._encode_socketio_packet(packet)
                        engineio_packets = await self._build_engineio_packets(
                            encoded_packet
                        )
                        pending_sends = await self._queue_local_send(
                            pending_sends,
                            eio_sid,
                            engineio_packets,
                        )
            if pending_sends:
                await asyncio.gather(*pending_sends)
        except BaseException:
            for send_task in pending_sends:
                send_task.cancel()
            if pending_sends:
                await asyncio.gather(*pending_sends, return_exceptions=True)
            raise

    async def _queue_local_send(
        self,
        pending: set[asyncio.Task[None]],
        eio_sid: str,
        packets: list[Any],
    ) -> set[asyncio.Task[None]]:
        """Queue one ordered client delivery within a fixed task window."""
        pending.add(
            asyncio.create_task(self._send_participant_packets(eio_sid, packets))
        )
        if len(pending) < SOCKETIO_LOCAL_SEND_CONCURRENCY:
            return pending
        done, still_pending = await asyncio.wait(
            pending,
            return_when=asyncio.FIRST_COMPLETED,
        )
        for send_task in done:
            send_task.result()
        return still_pending

    async def _send_participant_packets(
        self,
        eio_sid: str,
        packets: list[Any],
    ) -> None:
        """Preserve Engine.IO packet ordering for one participant."""
        for packet in packets:
            await self.server._send_eio_packet(eio_sid, packet)

    async def _handle_emit(self, message: dict[str, Any]) -> None:
        remote_callback = message.get("callback")
        remote_host_id = message.get("host_id")
        if remote_callback is not None and len(remote_callback) == 3:
            callback = partial(
                self._return_callback,
                remote_host_id,
                *remote_callback,
            )
        else:
            callback = None

        data = message["data"]
        if message.get("binary"):
            data = await run_payload_codec(
                self._reconstruct_binary_data,
                data,
                payload_hint=data,
            )
        if isinstance(data, list):
            data = data[0] if len(data) == 1 else tuple(data)
        await self._emit_local(
            message["event"],
            data,
            namespace=message.get("namespace"),
            room=message.get("room"),
            skip_sid=message.get("skip_sid"),
            callback=callback,
        )

    @staticmethod
    def _reconstruct_binary_data(data: list[Any]) -> Any:
        attachments = [base64.b64decode(item) for item in data[1:]]
        return socketio_packet.Packet.reconstruct_binary(data[0], attachments)

    async def _publish_with_retry(self, data: Any) -> Any:
        encoded = await run_payload_codec(
            json.dumps,
            data,
            payload_hint=data,
        )
        encoded_size = await run_payload_codec(
            self._encoded_payload_size,
            encoded,
            payload_hint=encoded,
        )
        if encoded_size > SOCKETIO_REDIS_MESSAGE_MAX_BYTES:
            raise SocketIOPacketTooLargeError(
                "Socket.IO Redis message exceeds "
                f"{SOCKETIO_REDIS_MESSAGE_MAX_BYTES} bytes"
            )
        _, redis_error = self._get_redis_module_and_error()
        for retries_left in range(1, -1, -1):
            try:
                if not self.connected:
                    self._redis_connect()
                return await self.redis.publish(self.channel, encoded)
            except redis_error as exc:
                if retries_left > 0:
                    self._get_logger().error(
                        "Cannot publish to redis... retrying",
                        extra={"redis_exception": str(exc)},
                    )
                    self.connected = False
                else:
                    self._get_logger().error(
                        "Cannot publish to redis... giving up",
                        extra={"redis_exception": str(exc)},
                    )
        return None

    async def _publish(self, data: Any) -> Any:
        try:
            return await asyncio.wait_for(
                self._publish_with_retry(data),
                timeout=SOCKETIO_REDIS_PUBLISH_TIMEOUT_SECONDS,
            )
        except TimeoutError:
            # Match AsyncRedisManager's best-effort failure semantics. Marking
            # the connection stale makes its existing reconnect path run on the
            # next publish instead of reusing the timed-out connection.
            self.connected = False
            logger.error(
                "Socket.IO Redis publish timed out after %.1fs",
                SOCKETIO_REDIS_PUBLISH_TIMEOUT_SECONDS,
            )
            return None

    async def _decode_pubsub_message(self, message: Any) -> Any:
        if isinstance(message, dict):
            return message
        if isinstance(message, (str, bytes, bytearray)) and (
            len(message) > SOCKETIO_REDIS_MESSAGE_MAX_BYTES
        ):
            logger.error(
                "Discarding oversized Socket.IO Redis message: %d bytes",
                len(message),
            )
            return None
        try:
            return await _SOCKETIO_INBOUND_CODEC_EXECUTOR.run(
                json.loads,
                message,
            )
        except Exception:
            return None

    async def _thread(self) -> None:
        """Consume Redis messages without decoding large JSON on the loop."""
        while True:
            try:
                async for message in self._listen():
                    # Redis fan-in can be larger than local client ingress. It
                    # shares the same process budget and must be admitted before
                    # even a small JSON envelope is decoded on behalf of Web.
                    await self._event_admission.acquire()
                    data = await self._decode_pubsub_message(message)
                    if data and "method" in data:
                        self._get_logger().debug(
                            "pubsub message: %s",
                            data["method"],
                        )
                        try:
                            if data["method"] == "callback":
                                await self._handle_callback(data)
                            elif data.get("host_id") != self.host_id:
                                if data["method"] == "emit":
                                    await self._handle_emit(data)
                                elif data["method"] == "disconnect":
                                    await self._handle_disconnect(data)
                                elif data["method"] == "enter_room":
                                    await self._handle_enter_room(data)
                                elif data["method"] == "leave_room":
                                    await self._handle_leave_room(data)
                                elif data["method"] == "close_room":
                                    await self._handle_close_room(data)
                        except asyncio.CancelledError:
                            raise
                        except Exception:
                            self.server.logger.exception(
                                "Handler error in pubsub listening thread"
                            )
                self.server.logger.error("pubsub listen() exited unexpectedly")
                break
            except asyncio.CancelledError:
                break
            except Exception:
                self.server.logger.exception(
                    "Unexpected Error in pubsub listening thread"
                )


def create_socketio_server() -> socketio.AsyncServer:
    """
    Create and configure the Socket.IO server instance.

    Uses Redis adapter for cross-worker communication in multi-instance deployments.

    Returns:
        socketio.AsyncServer: Configured Socket.IO server
    """
    # Create Redis manager for cross-worker communication
    redis_url = settings.REDIS_URL

    mgr = _TimeoutAsyncRedisManager(
        redis_url,
        redis_options={
            # One connection is reserved by pub/sub; all remaining connections
            # cover the finite local delivery window without allowing Redis
            # pressure to grow with request count.
            "max_connections": SOCKETIO_REDIS_MAX_CONNECTIONS,
            "socket_connect_timeout": SOCKETIO_REDIS_CONNECT_TIMEOUT_SECONDS,
        },
    )
    logger.info("Socket.IO Redis manager initialized")

    # Create Socket.IO server
    sio = _BoundedAsyncServer(
        async_mode="asgi",
        async_handlers=True,
        cors_allowed_origins=SOCKETIO_CORS_ORIGINS,
        ping_interval=SOCKETIO_PING_INTERVAL,
        ping_timeout=SOCKETIO_PING_TIMEOUT,
        max_http_buffer_size=SOCKETIO_MAX_HTTP_BUFFER_SIZE,
        logger=False,  # Use our own logger
        engineio_logger=False,
        client_manager=mgr,
    )

    return sio


def create_socketio_app(sio: socketio.AsyncServer) -> socketio.ASGIApp:
    """
    Create ASGI app for Socket.IO.

    Args:
        sio: The Socket.IO server instance

    Returns:
        socketio.ASGIApp: ASGI application for mounting
    """
    return socketio.ASGIApp(
        sio,
        socketio_path=SOCKETIO_PATH,
    )


# Global Socket.IO server instance (lazy initialized)
_sio_instance: socketio.AsyncServer | None = None


def get_sio() -> socketio.AsyncServer:
    """
    Get or create the global Socket.IO server instance.

    Returns:
        socketio.AsyncServer: The Socket.IO server instance
    """
    global _sio_instance
    if _sio_instance is None:
        _sio_instance = create_socketio_server()
    return _sio_instance
