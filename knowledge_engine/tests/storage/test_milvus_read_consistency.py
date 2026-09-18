# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Read consistency contract for the native Milvus store (no server).

Retrieval answers from data the write path wrote in a single write, so the read
RPCs run at ``Bounded``. The collection creation stays ``Strong``: it is the
read that decides whether the schema is really there before the write path
reports success. The index contract is no longer a row of its own: it travels
in the collection's description, so reading it is one ``describe_collection``
and no consistency level.
"""

import pytest

from knowledge_engine.storage.errors import IndexContractIncompatibleError
from knowledge_engine.storage.milvus_native import (
    ANALYZER_TYPE,
    DENSE_VECTOR_FIELD,
    INDEX_TYPE,
    METRIC_TYPE,
    SCHEMA_VERSION,
    MilvusIndexBinding,
    index_contract_description,
)
from knowledge_engine.storage.milvus_store import MilvusDocumentStore

CONTRACT_DIMENSION = 4
COLLECTION_NAME = "wegent_kb_1"
# Literals on purpose: these tests pin the level each RPC must send, so reading
# them from the module would let a wrong production constant pass unnoticed.
READ_CONSISTENCY = "Bounded"
WRITE_CONSISTENCY = "Strong"


def _contract(
    *,
    embedding_space: str = "sha256:abc",
) -> MilvusIndexBinding:
    return MilvusIndexBinding(
        collection_name=COLLECTION_NAME,
        connection="http://milvus.test:19530",
        database="default",
        schema_version=SCHEMA_VERSION,
        embedding_space=embedding_space,
        dimension=CONTRACT_DIMENSION,
        metric_type=METRIC_TYPE,
        index_type=INDEX_TYPE,
        analyzer=ANALYZER_TYPE,
    )


class _IndexParams:
    """Stands in for the SDK index-param builder the store hands to the SDK."""

    def add_index(self, **kwargs) -> None:
        pass


class _RecordingClient:
    """Records the kwargs of every RPC so the consistency level is visible."""

    def __init__(
        self,
        *,
        collection_exists: bool = True,
        contract: MilvusIndexBinding | None = None,
    ) -> None:
        self.exists = {COLLECTION_NAME: collection_exists}
        self.contract = contract or _contract()
        self.description: str | None = None
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
            "description": (
                self.description
                if self.description is not None
                else index_contract_description(self.contract)
            ),
            "fields": [
                {
                    "name": DENSE_VECTOR_FIELD,
                    "params": {"dim": self.contract.dimension},
                }
            ],
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
        """Keep the contract the name already carries when the name is taken."""
        self._record("create_collection", kwargs)
        self.exists[kwargs["collection_name"]] = True

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


def test_the_contract_read_is_one_describe_and_no_row_read():
    """The contract travels with the collection, without a consistency level."""
    client = _RecordingClient()

    binding = _store(client).read_contract(client, COLLECTION_NAME)

    assert binding == client.contract
    assert [name for name, _ in client.calls].count("describe_collection") == 1
    assert client.consistency_levels("describe_collection") == [None]
    assert client.consistency_levels("query") == []


def test_a_foreign_collection_is_refused_without_reading_its_rows():
    """A collection that declares no contract of ours is never adopted."""
    client = _RecordingClient()
    client.description = "wegent knowledge index"

    with pytest.raises(IndexContractIncompatibleError):
        _store(client).read_contract(client, COLLECTION_NAME)

    assert client.consistency_levels("query") == []


def test_paged_read_uses_the_read_consistency_level():
    client = _RecordingClient()

    _store(client).query_rows(client, COLLECTION_NAME, 'knowledge_id == "1"', limit=10)

    assert client.consistency_levels("query") == [READ_CONSISTENCY]


def test_dense_search_uses_the_read_consistency_level():
    client = _RecordingClient()

    _store(client).search(
        client,
        COLLECTION_NAME,
        query_vector=[0.0, 1.0],
        filter_expr="",
        limit=5,
    )

    assert client.consistency_levels("search") == [READ_CONSISTENCY]


def test_sparse_search_uses_the_read_consistency_level():
    client = _RecordingClient()

    _store(client).sparse_search(
        client,
        COLLECTION_NAME,
        query_text="中文关键词",
        filter_expr="",
        limit=5,
    )

    assert client.consistency_levels("search") == [READ_CONSISTENCY]


def test_collection_creation_stays_strong():
    """Creating the owned collection is a write-path read of the schema."""
    client = _RecordingClient(collection_exists=False)

    _store(client).ensure_index(
        client,
        COLLECTION_NAME,
        dimension=CONTRACT_DIMENSION,
        embedding_space="sha256:abc",
    )

    created = {
        kwargs["collection_name"]: kwargs.get("consistency_level")
        for name, kwargs in client.calls
        if name == "create_collection"
    }
    assert created[COLLECTION_NAME] == WRITE_CONSISTENCY


def test_the_creation_race_is_settled_by_the_collection_own_contract():
    """A concurrent writer of another contract is refused, not adopted.

    The create itself is not a compare-and-swap: this writer asks for a
    collection name another writer has already created with a different
    embedding space, so the contract read back from that collection is what
    fails. The losing writer never reads or writes a row.
    """
    client = _RecordingClient(
        collection_exists=False,
        contract=_contract(embedding_space="sha256:the-winner"),
    )

    with pytest.raises(IndexContractIncompatibleError):
        _store(client).ensure_index(
            client,
            COLLECTION_NAME,
            dimension=CONTRACT_DIMENSION,
            embedding_space="sha256:abc",
        )

    assert client.consistency_levels("query") == []
    assert client.consistency_levels("upsert") == []
