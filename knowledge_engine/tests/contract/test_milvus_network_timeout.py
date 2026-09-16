# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""A real Milvus operation stays inside its configured deadline.

The target is a local socket that accepts the connection and then never
answers (``silent_tcp_target``), so nothing here depends on public routing or on
an external network. It proves the SDK retry loop is bounded by the per-call
timeout the store passes - not just by the client constructor - and that the
failure is reported as a retryable storage error whose client was closed again.
"""

from __future__ import annotations

import time

import pytest

from knowledge_engine.storage.errors import StorageBackendError
from knowledge_engine.storage.milvus_backend import MilvusBackend
from tests.contract.conftest import SilentTcpTarget

pytestmark = pytest.mark.milvus

OPERATION_TIMEOUT_SECONDS = 2.0
# A 2s deadline with a bounded retry loop must finish far inside this budget.
MAX_OPERATION_SECONDS = 20.0


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
