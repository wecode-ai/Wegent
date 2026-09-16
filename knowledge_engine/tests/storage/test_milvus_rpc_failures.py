# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Milvus RPCs stay bounded and their failures keep a stable classification.

The PyMilvus client constructor timeout only bounds the initial connection: a
per-call ``timeout`` is what limits the RPC itself, and without it the SDK
keeps retrying a dead server. These tests assert the kwarg that actually
bounds the call, not the constructor argument.
"""

from __future__ import annotations

import pytest
from grpc import StatusCode
from pymilvus import MilvusException

from knowledge_engine.storage.errors import StorageBackendError
from knowledge_engine.storage.milvus_errors import is_transient_rpc_failure
from knowledge_engine.storage.milvus_native import MilvusDocumentStore

TIMEOUT_SECONDS = 3.0


class _RecordingClient:
    """A Milvus client that records the kwargs of every RPC it receives."""

    def __init__(self, *, exists: bool = True) -> None:
        self.exists = exists
        self.calls: list[tuple[str, dict]] = []
        self.closed = False

    def _record(self, name: str, kwargs: dict) -> None:
        self.calls.append((name, dict(kwargs)))

    def has_collection(self, collection_name: str, **kwargs) -> bool:
        self._record("has_collection", kwargs)
        return self.exists

    def describe_collection(self, collection_name: str, **kwargs) -> dict:
        self._record("describe_collection", kwargs)
        return {"fields": [{"name": "dense_vector", "params": {"dim": 4}}]}

    def query(self, **kwargs) -> list:
        self._record("query", kwargs)
        return []

    def search(self, **kwargs) -> list:
        self._record("search", kwargs)
        return [[]]

    def upsert(self, **kwargs) -> dict:
        self._record("upsert", kwargs)
        return {}

    def insert(self, **kwargs) -> dict:
        self._record("insert", kwargs)
        return {}

    def delete(self, **kwargs) -> dict:
        self._record("delete", kwargs)
        return {}

    def flush(self, *args, **kwargs) -> None:
        self._record("flush", kwargs)

    def drop_collection(self, **kwargs) -> None:
        self._record("drop_collection", kwargs)

    def list_collections(self, **kwargs) -> list:
        self._record("list_collections", kwargs)
        return []

    def prepare_index_params(self):
        raise AssertionError("this test never creates a collection")

    def close(self) -> None:
        self.closed = True

    def timeout_of(self, name: str):
        """Return the timeout of the last recorded RPC of that name."""
        for call_name, kwargs in reversed(self.calls):
            if call_name == name:
                return kwargs.get("timeout")
        raise AssertionError(f"the client never received a {name} call")


def _store(client: _RecordingClient) -> MilvusDocumentStore:
    return MilvusDocumentStore(
        uri="http://milvus.test:19530",
        timeout=TIMEOUT_SECONDS,
        client_factory=lambda **kwargs: client,
    )


def test_query_rows_bounds_the_rpc_with_the_configured_timeout():
    client = _RecordingClient()

    _store(client).query_rows(
        client,
        "wegent_kb_1",
        'knowledge_id == "1"',
        limit=10,
    )

    assert client.timeout_of("has_collection") == TIMEOUT_SECONDS
    assert client.timeout_of("query") == TIMEOUT_SECONDS


def test_dense_and_sparse_search_bound_the_rpc():
    client = _RecordingClient()
    store = _store(client)

    store.search(
        client,
        "wegent_kb_1",
        query_vector=[0.0, 1.0],
        filter_expr="",
        limit=5,
    )
    store.sparse_search(
        client,
        "wegent_kb_1",
        query_text="中文",
        filter_expr="",
        limit=5,
    )

    assert client.timeout_of("search") == TIMEOUT_SECONDS


def test_write_and_delete_bound_their_rpcs():
    client = _RecordingClient()
    store = _store(client)

    store.upsert_rows(client, "wegent_kb_1", [{"id": "row-1"}])
    store.delete_rows(client, "wegent_kb_1", 'knowledge_id == "1"')

    assert client.timeout_of("upsert") == TIMEOUT_SECONDS
    assert client.timeout_of("delete") == TIMEOUT_SECONDS
    assert client.timeout_of("flush") == TIMEOUT_SECONDS


def test_collection_lookup_bounds_the_rpc():
    client = _RecordingClient()

    _store(client).has_collection(client, "wegent_kb_1")

    assert client.timeout_of("has_collection") == TIMEOUT_SECONDS


def test_an_unresponsive_rpc_reports_the_sdk_failure():
    """A bounded RPC that still fails reports a retryable storage failure."""

    class _DeadClient(_RecordingClient):
        def query(self, **kwargs):
            self._record("query", kwargs)
            raise MilvusException(
                code=StatusCode.DEADLINE_EXCEEDED,
                message="deadline exceeded",
            )

    client = _DeadClient()
    store = _store(client)

    with pytest.raises(StorageBackendError) as failure:
        with store.client() as used:
            store.query_rows(used, "wegent_kb_1", "", limit=10)

    assert failure.value.retryable is True
    assert "DEADLINE_EXCEEDED" in str(failure.value)
    assert client.closed is True


def test_a_disconnected_service_reports_a_retryable_failure():
    class _DisconnectedClient(_RecordingClient):
        def query(self, **kwargs):
            raise MilvusException(
                code=StatusCode.UNAVAILABLE,
                message="server unavailable",
            )

    client = _DisconnectedClient()
    store = _store(client)

    with pytest.raises(StorageBackendError) as failure:
        with store.client() as used:
            store.query_rows(used, "wegent_kb_1", "", limit=10)

    assert failure.value.retryable is True
    assert "UNAVAILABLE" in str(failure.value)
    assert client.closed is True


def test_a_deterministic_sdk_rejection_keeps_its_own_code():
    class _RejectingClient(_RecordingClient):
        def query(self, **kwargs):
            raise MilvusException(code=1100, message="invalid filter")

    client = _RejectingClient()
    store = _store(client)

    with pytest.raises(StorageBackendError) as failure:
        with store.client() as used:
            store.query_rows(used, "wegent_kb_1", "", limit=10)

    assert failure.value.retryable is False
    assert failure.value.details["sdk_code"] == "1100"


def test_the_classification_separates_transient_from_deterministic():
    assert (
        is_transient_rpc_failure(
            MilvusException(code=StatusCode.DEADLINE_EXCEEDED, message="late")
        )
        is True
    )
    assert (
        is_transient_rpc_failure(
            MilvusException(code=StatusCode.UNAVAILABLE, message="down")
        )
        is True
    )
    assert (
        is_transient_rpc_failure(MilvusException(code=1100, message="invalid filter"))
        is False
    )


def test_a_connection_failure_is_classified_as_retryable():
    """An unreachable service is transient.

    The elapsed-time budget is proven against a real unroutable target in
    ``tests/contract/test_milvus_network_timeout.py``; a fake client cannot
    show it.
    """
    from pymilvus.exceptions import ConnectError

    class _UnreachableClient(_RecordingClient):
        def query(self, **kwargs):
            raise ConnectError("Fail connecting to server")

    client = _UnreachableClient()
    store = _store(client)

    with pytest.raises(StorageBackendError) as failure:
        with store.client() as used:
            store.query_rows(used, "wegent_kb_1", "", limit=10)

    assert failure.value.retryable is True


def test_each_operation_closes_only_its_own_client():
    """Concurrent operations hold independent clients and aliases."""
    aliases: list[str] = []
    clients: list[_RecordingClient] = []

    def factory(**kwargs):
        aliases.append(kwargs["alias"])
        client = _RecordingClient()
        clients.append(client)
        return client

    store = MilvusDocumentStore(
        uri="http://milvus.test:19530",
        timeout=TIMEOUT_SECONDS,
        client_factory=factory,
    )

    with store.client() as first:
        with store.client() as second:
            assert first is not second
            assert clients[0].closed is False
        assert clients[0].closed is False
        assert clients[1].closed is True

    assert clients[0].closed is True
    assert aliases == list(dict.fromkeys(aliases))
