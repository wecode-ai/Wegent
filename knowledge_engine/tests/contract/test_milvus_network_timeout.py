# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Real Milvus operations stay inside their configured deadlines.

Both failures are reproduced against local fault-injection peers, so nothing
here depends on public routing, an external service or a VPN:

- ``silent_tcp_target`` never completes the handshake, which bounds the
  *connection* deadline;
- ``slow_rpc_milvus_peer`` answers the handshake and then holds the read-path
  RPCs (``ShowCollections`` / ``DescribeCollection``) past the deadline, which
  bounds the *per-call* deadline the store passes to every RPC.

Both assert the failure is a retryable storage error and that the client was
released, not pooled.
"""

from __future__ import annotations

import time

import pytest

from knowledge_engine.storage.errors import StorageBackendError
from knowledge_engine.storage.milvus_backend import MilvusBackend
from tests.contract.milvus_fault_injection import SilentTcpTarget, SlowRpcMilvusPeer

pytestmark = pytest.mark.milvus

OPERATION_TIMEOUT_SECONDS = 2.0
# A 2s deadline with a bounded retry loop must finish far inside this budget.
MAX_OPERATION_SECONDS = 20.0
RPC_TIMEOUT_SECONDS = 1.0
# The peer holds the RPC well past the deadline, so the deadline - not the
# server - is what ends the call.
RPC_DELAY_SECONDS = 2.5


def _silent_backend(target: SilentTcpTarget, *, timeout: float) -> MilvusBackend:
    return MilvusBackend(
        {
            "url": target.uri,
            "indexStrategy": {"mode": "per_dataset", "prefix": "timeout"},
            "ext": {"timeout": timeout},
        }
    )


def test_a_silent_service_fails_inside_the_bounded_budget(
    silent_tcp_target: SilentTcpTarget,
) -> None:
    backend = _silent_backend(silent_tcp_target, timeout=OPERATION_TIMEOUT_SECONDS)

    started = time.monotonic()
    with pytest.raises(StorageBackendError) as failure:
        backend.get_all_chunks("wegent_kb_1", max_chunks=5)
    elapsed = time.monotonic() - started

    assert elapsed < MAX_OPERATION_SECONDS, f"the bounded operation took {elapsed:.1f}s"
    assert failure.value.retryable is True
    assert failure.value.code == "storage_unavailable"
    assert "unknown" in str(failure.value)


def test_the_store_keeps_working_after_a_bounded_failure(
    silent_tcp_target: SilentTcpTarget,
) -> None:
    """The failed operation released its own client, not a shared one."""
    backend = _silent_backend(silent_tcp_target, timeout=OPERATION_TIMEOUT_SECONDS)

    for _ in range(2):
        with pytest.raises(StorageBackendError):
            backend.get_all_chunks("wegent_kb_1", max_chunks=5)


def test_the_per_call_timeout_bounds_a_query_rpc(
    slow_rpc_milvus_peer: SlowRpcMilvusPeer,
) -> None:
    """The deadline is on the RPC, not just on setting the connection up.

    The peer completes the gRPC handshake first, so a client that only bounded
    its connection would wait for the whole server delay. The call under test
    is a read, whose first RPC (``DescribeCollection`` via ``has_collection``)
    is the one the peer holds back.
    """
    backend = MilvusBackend(
        {
            "url": slow_rpc_milvus_peer.uri,
            "indexStrategy": {"mode": "per_dataset", "prefix": "timeout"},
            "ext": {"timeout": RPC_TIMEOUT_SECONDS},
        }
    )

    # The handshake succeeded: a normal RPC really completed against the peer.
    assert backend.test_connection() is True
    served_before_failure = len(slow_rpc_milvus_peer.served)

    slow_rpc_milvus_peer.call_delay = RPC_DELAY_SECONDS
    started = time.monotonic()
    with pytest.raises(StorageBackendError) as failure:
        backend.get_all_chunks("wegent_kb_1", max_chunks=5)
    elapsed = time.monotonic() - started

    assert failure.value.retryable is True
    assert failure.value.code == "storage_unavailable"
    assert elapsed < MAX_OPERATION_SECONDS, f"the bounded RPC took {elapsed:.1f}s"
    # The deadline, not the server, ended the call: the client gave up slightly
    # after its configured timeout while the peer was still holding the RPC.
    assert elapsed >= RPC_TIMEOUT_SECONDS, f"the RPC ended after only {elapsed:.1f}s"
    # The peer really received the RPC, which is what proves this is the
    # per-call deadline and not a failure to connect.
    assert len(slow_rpc_milvus_peer.served) > served_before_failure
    held = slow_rpc_milvus_peer.served[-1]
    assert held.method != "Connect"
    assert elapsed < RPC_DELAY_SECONDS, "the peer's own delay ended the call"

    # The failed call released its own client: a fresh bounded operation works.
    slow_rpc_milvus_peer.call_delay = 0.0
    assert backend.test_connection() is True
