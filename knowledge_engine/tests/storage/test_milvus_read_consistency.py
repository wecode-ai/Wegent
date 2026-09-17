# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Read consistency contract for the native Milvus store (no server).

Retrieval answers from data the write path wrote in a single write, so the read
RPCs run at ``Bounded``. The delete verification and the collection creation
stay ``Strong``: they are the reads that decide whether the data and the schema
are really there before the write path reports success. The one read that
crosses over is the contract fallback, which re-reads a contract the snapshot
read missed before calling the collection incompatible.
"""

import pytest

from knowledge_engine.storage.errors import IndexContractIncompatibleError
from knowledge_engine.storage.milvus_native import (
    DENSE_VECTOR_FIELD,
    INDEX_BINDING_COLLECTION,
    MilvusDocumentStore,
)

CONTRACT_DIMENSION = 4
# Literals on purpose: these tests pin the level each RPC must send, so reading
# them from the module would let a wrong production constant pass unnoticed.
READ_CONSISTENCY = "Bounded"
WRITE_CONSISTENCY = "Strong"


class _IndexParams:
    """Stands in for the SDK index-param builder the store hands to the SDK."""

    def add_index(self, **kwargs) -> None:
        pass


class _RecordingClient:
    """Records the kwargs of every RPC so the consistency level is visible."""

    def __init__(
        self, *, collection_exists: bool = True, registry_exists: bool = True
    ) -> None:
        self.exists = {
            "wegent_kb_1": collection_exists,
            INDEX_BINDING_COLLECTION: registry_exists,
        }
        self.calls: list[tuple[str, dict]] = []

    def _record(self, name: str, kwargs: dict) -> None:
        self.calls.append((name, dict(kwargs)))

    def consistency_levels(self, name: str) -> list:
        """Return the recorded consistency level of every RPC of that name."""
        return [
            kwargs.get("consistency_level")
            for call_name, kwargs in self.calls
            if call_name == name
        ]

    def has_collection(self, collection_name: str, **kwargs) -> bool:
        self._record("has_collection", kwargs)
        return self.exists.get(collection_name, False)

    def describe_collection(self, collection_name: str, **kwargs) -> dict:
        self._record("describe_collection", kwargs)
        return {
            "fields": [
                {"name": DENSE_VECTOR_FIELD, "params": {"dim": CONTRACT_DIMENSION}}
            ]
        }

    def query(self, **kwargs) -> list:
        self._record("query", kwargs)
        return []

    def search(self, **kwargs) -> list:
        self._record("search", kwargs)
        return [[]]

    def prepare_index_params(self):
        self._record("prepare_index_params", {})
        return _IndexParams()

    def create_collection(self, **kwargs) -> None:
        self._record("create_collection", kwargs)

    def upsert(self, **kwargs) -> dict:
        self._record("upsert", kwargs)
        return {}

    def flush(self, *args, **kwargs) -> None:
        self._record("flush", kwargs)

    def close(self) -> None:
        pass


def _store(client: _RecordingClient) -> MilvusDocumentStore:
    return MilvusDocumentStore(
        uri="http://milvus.test:19530",
        client_factory=lambda **kwargs: client,
    )


def test_registry_read_uses_the_read_consistency_level():
    """Reading the stored index contract is a read, not a publication check."""
    client = _RecordingClient()

    _store(client).read_binding(client, "wegent_kb_1")

    assert client.consistency_levels("query") == [READ_CONSISTENCY]


def test_write_level_contract_re_read_uses_the_write_consistency_level():
    """The publication-window fallback reads the contract as the writer does.

    It exists to see a contract the snapshot read missed, so it must not be
    answered from that same snapshot.
    """
    client = _RecordingClient()

    _store(client).read_binding_strong(client, "wegent_kb_1")

    assert client.consistency_levels("query") == [WRITE_CONSISTENCY]


def test_paged_read_uses_the_read_consistency_level():
    client = _RecordingClient()

    _store(client).query_rows(client, "wegent_kb_1", 'knowledge_id == "1"', limit=10)

    assert client.consistency_levels("query") == [READ_CONSISTENCY]


def test_dense_search_uses_the_read_consistency_level():
    client = _RecordingClient()

    _store(client).search(
        client,
        "wegent_kb_1",
        query_vector=[0.0, 1.0],
        filter_expr="",
        limit=5,
    )

    assert client.consistency_levels("search") == [READ_CONSISTENCY]


def test_sparse_search_uses_the_read_consistency_level():
    client = _RecordingClient()

    _store(client).sparse_search(
        client,
        "wegent_kb_1",
        query_text="中文关键词",
        filter_expr="",
        limit=5,
    )

    assert client.consistency_levels("search") == [READ_CONSISTENCY]


def test_delete_verification_row_count_stays_strong():
    """Deleting proves the rows are gone through a Strong read."""
    client = _RecordingClient()

    _store(client).count_rows(client, "wegent_kb_1", 'knowledge_id == "1"')

    assert client.consistency_levels("query") == [WRITE_CONSISTENCY]


def test_write_visibility_read_stays_strong():
    """Making a write readable is a write-path read, not a retrieval read."""
    client = _RecordingClient()

    _store(client).advance_read_visibility(client, "wegent_kb_1", 'knowledge_id == "1"')

    assert client.consistency_levels("query") == [WRITE_CONSISTENCY]


def test_collection_creation_stays_strong():
    """Creating the owned collection is a write-path read of the schema."""
    client = _RecordingClient(collection_exists=False, registry_exists=True)

    _store(client).ensure_index(
        client,
        "wegent_kb_1",
        dimension=CONTRACT_DIMENSION,
        embedding_space="sha256:abc",
    )

    created = {
        kwargs["collection_name"]: kwargs.get("consistency_level")
        for name, kwargs in client.calls
        if name == "create_collection"
    }
    assert created["wegent_kb_1"] == WRITE_CONSISTENCY


def test_collection_ownership_read_stays_strong():
    """Rejecting an unclaimed collection reads the registry at the write level.

    The creation path decides ownership from this read, so it must see a
    contract another writer just wrote rather than the read level's snapshot.
    """
    client = _RecordingClient(collection_exists=True, registry_exists=True)

    with pytest.raises(IndexContractIncompatibleError):
        _store(client).ensure_index(
            client,
            "wegent_kb_1",
            dimension=CONTRACT_DIMENSION,
            embedding_space="sha256:abc",
        )

    assert client.consistency_levels("query") == [WRITE_CONSISTENCY]


def test_delete_path_contract_read_stays_strong():
    """Authorising a delete reads the contract at the write level too.

    The delete path mutates a collection only behind the contract it declares,
    so that read is a precondition of a write rather than a retrieval read.
    """
    client = _RecordingClient(collection_exists=True, registry_exists=True)

    with pytest.raises(IndexContractIncompatibleError):
        _store(client).require_bound(client, "wegent_kb_1")

    assert client.consistency_levels("query") == [WRITE_CONSISTENCY]
