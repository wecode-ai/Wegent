# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Local fault-injection peers for the storage deadline contracts.

Both peers are deterministic and local: nothing here depends on public routing,
an external service or a VPN. They exist because the two storage deadlines fail
at different points, and only a peer that completes the gRPC handshake can
exercise the second one.
"""

from __future__ import annotations

import socket
import threading
import time
from concurrent import futures
from dataclasses import dataclass
from typing import Any, Callable

import grpc
from pymilvus.grpc_gen import common_pb2, milvus_pb2, milvus_pb2_grpc


class SilentTcpTarget:
    """A local TCP endpoint that accepts connections and never speaks.

    Reachable, so nothing depends on routing, but no byte ever arrives. Used
    for the connection deadline: the client waits for the HTTP/2 handshake
    until its own timeout, which is the failure a refused connection skips.
    """

    def __init__(self, backlog: int = 8) -> None:
        self._listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._listener.bind(("127.0.0.1", 0))
        self._listener.listen(backlog)
        self._listener.settimeout(0.2)
        self._accepted: list[socket.socket] = []
        self._stopping = threading.Event()
        self._thread = threading.Thread(target=self._accept_forever, daemon=True)
        self._thread.start()

    @property
    def uri(self) -> str:
        host, port = self._listener.getsockname()
        return f"http://{host}:{port}"

    def _accept_forever(self) -> None:
        while not self._stopping.is_set():
            try:
                connection, _ = self._listener.accept()
            except (TimeoutError, OSError):
                continue
            self._accepted.append(connection)

    def close(self) -> None:
        self._stopping.set()
        self._thread.join(timeout=2)
        for connection in self._accepted:
            connection.close()
        self._listener.close()


@dataclass
class ServedRpc:
    """One RPC the fake peer actually received and handled."""

    method: str
    started_at: float
    # ``None`` while the handler is still running. A client that gives up on
    # the deadline cancels the RPC, which interrupts the handler's own sleep
    # and can leave the exit time unrecorded - so this is evidence that the RPC
    # arrived, not a duration measurement.
    finished_at: float | None = None

    @property
    def duration(self) -> float | None:
        if self.finished_at is None:
            return None
        return self.finished_at - self.started_at


class SlowRpcMilvusPeer:
    """A local gRPC peer that completes the handshake and delays RPCs.

    ``Connect`` always answers, so the PyMilvus client is constructed against a
    real channel; every other RPC sleeps for ``call_delay`` before answering.
    That reproduces the post-handshake deadline - a query RPC the server
    receives but does not answer in time - which a peer that only accepts TCP
    connections cannot reach, because the client fails during construction.

    ``call_delay`` is mutable so one peer can both prove the handshake works and
    then become slow. ``served`` records what really arrived, which is the
    evidence that the RPC ran rather than failing during setup.
    """

    def __init__(self, *, call_delay: float = 0.0) -> None:
        self.call_delay = call_delay
        self.served: list[ServedRpc] = []
        self._server = grpc.server(futures.ThreadPoolExecutor(max_workers=8))
        milvus_pb2_grpc.add_MilvusServiceServicer_to_server(
            _SlowMilvusServicer(self), self._server
        )
        self._port = self._server.add_insecure_port("127.0.0.1:0")
        self._server.start()

    @property
    def uri(self) -> str:
        return f"http://127.0.0.1:{self._port}"

    def record(self, method: str) -> Callable[[], None]:
        """Return the callable an RPC handler uses to enter and leave."""
        entry = ServedRpc(method=method, started_at=time.monotonic())
        self.served.append(entry)

        def finish() -> None:
            entry.finished_at = time.monotonic()

        return finish

    def close(self) -> None:
        self._server.stop(0)


class _SlowMilvusServicer(milvus_pb2_grpc.MilvusServiceServicer):
    def __init__(self, peer: SlowRpcMilvusPeer) -> None:
        self._peer = peer

    def Connect(self, request: Any, context: Any) -> Any:
        finish = self._peer.record("Connect")
        try:
            return milvus_pb2.ConnectResponse(
                status=common_pb2.Status(error_code=0, reason="OK"),
                identifier=1,
                server_info=common_pb2.ServerInfo(build_tags="contract-fake"),
            )
        finally:
            finish()

    def ShowCollections(self, request: Any, context: Any) -> Any:
        """The RPC ``MilvusClient.list_collections`` issues."""
        finish = self._peer.record("ShowCollections")
        try:
            time.sleep(self._peer.call_delay)
            return milvus_pb2.ShowCollectionsResponse(
                status=common_pb2.Status(error_code=0, reason="OK"),
                collection_names=[],
            )
        finally:
            finish()

    def DescribeCollection(self, request: Any, context: Any) -> Any:
        """The RPC the storage adapter issues to inspect one collection."""
        finish = self._peer.record("DescribeCollection")
        try:
            time.sleep(self._peer.call_delay)
            return milvus_pb2.DescribeCollectionResponse(
                status=common_pb2.Status(error_code=0, reason="OK"),
                schema=milvus_pb2.CollectionSchema(name="contract", fields=[]),
                collectionID=1,
                collection_name="contract",
                shards_num=1,
            )
        finally:
            finish()
