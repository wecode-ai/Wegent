# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for the bounded Milvus client layer (no server).

These cover ``MilvusDocumentStore``: client lifetimes, the RPC shape it sends,
and the index-contract state machine. The row layout and the filter vocabulary
it works with are tested in ``test_milvus_native.py``.
"""

import pytest
from pymilvus import DataType, FunctionType

from knowledge_engine.storage.errors import (
    IndexContractIncompatibleError,
    IndexMissingError,
)
from knowledge_engine.storage.milvus_native import (
    ANALYZER_TYPE,
    DENSE_VECTOR_FIELD,
    METRIC_TYPE,
    SCHEMA_VERSION,
    SPARSE_VECTOR_FIELD,
    MilvusIndexBinding,
)
from knowledge_engine.storage.milvus_store import MilvusDocumentStore


def _binding(**overrides):
    payload = {
        "collection_name": "wegent_kb_1",
        "connection": "http://milvus.test:19530",
        "database": "default",
        "schema_version": SCHEMA_VERSION,
        "embedding_space": "sha256:abc",
        "dimension": 1536,
        "metric_type": METRIC_TYPE,
        "index_type": "AUTOINDEX",
        "analyzer": ANALYZER_TYPE,
    }
    payload.update(overrides)
    return MilvusIndexBinding(**payload)


def test_binding_pins_the_keyword_analyzer_and_schema_version():
    store = MilvusDocumentStore(uri="http://milvus.test:19530")

    binding = store.build_binding(
        "wegent_kb_1",
        dimension=1536,
        embedding_space="sha256:abc",
    )

    assert binding.analyzer == ANALYZER_TYPE
    assert binding.schema_version == SCHEMA_VERSION


class _FakeClient:
    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.closed = False

    def close(self):
        self.closed = True

    def has_collection(self, collection_name, **kwargs):
        return False


def test_read_only_verify_does_not_create_resources():
    """A missing index reports absence and touches nothing else."""
    created: list[_FakeClient] = []

    def factory(**kwargs):
        client = _FakeClient(**kwargs)
        created.append(client)
        return client

    store = MilvusDocumentStore(
        uri="http://milvus.test:19530",
        client_factory=factory,
    )

    with store.client() as client:
        assert store.require_bound(client, "wegent_kb_1") is None

    assert len(created) == 1
    assert created[0].closed is True
    assert created[0].kwargs["db_name"] == "default"


def test_client_is_closed_when_the_operation_raises():
    created: list[_FakeClient] = []

    def factory(**kwargs):
        client = _FakeClient(**kwargs)
        created.append(client)
        return client

    store = MilvusDocumentStore(uri="/tmp/milvus.db", client_factory=factory)

    with pytest.raises(RuntimeError):
        with store.client():
            raise RuntimeError("boom")

    assert created[0].closed is True


class _SparseSearchClient:
    """Records the search request the store sends for a keyword query."""

    def __init__(self, *, exists: bool = True) -> None:
        self.exists = exists
        self.searches: list[dict] = []

    def has_collection(self, collection_name: str, **kwargs) -> bool:
        return self.exists

    def search(self, **kwargs):
        self.searches.append(kwargs)
        return [
            [
                {
                    "entity": {"id": "row-1", "display_text": "展示正文"},
                    "distance": 2.5,
                }
            ]
        ]


def test_keyword_search_uses_the_sparse_bm25_field_not_a_query_vector():
    """A keyword query sends retrieval text; no dense vector is ever built."""
    client = _SparseSearchClient()
    store = MilvusDocumentStore(uri="http://milvus.test:19530")

    hits = store.sparse_search(
        client,
        "wegent_kb_1",
        query_text="中文 标识符",
        filter_expr='knowledge_id == "1"',
        limit=5,
    )

    [request] = client.searches
    assert request["data"] == ["中文 标识符"]
    assert request["anns_field"] == SPARSE_VECTOR_FIELD
    assert request["search_params"] == {"metric_type": "BM25", "params": {}}
    assert request["filter"] == 'knowledge_id == "1"'
    assert request["limit"] == 5
    assert hits == [{"id": "row-1", "display_text": "展示正文", "__score__": 2.5}]


def test_keyword_search_on_a_missing_collection_returns_nothing():
    client = _SparseSearchClient(exists=False)
    store = MilvusDocumentStore(uri="http://milvus.test:19530")

    hits = store.sparse_search(
        client,
        "wegent_kb_1",
        query_text="q",
        filter_expr="",
        limit=5,
    )

    assert hits == []
    assert client.searches == []


def test_keyword_capability_check_follows_the_stored_analyzer():
    """A contract without the keyword analyzer never answers keyword queries."""
    store = MilvusDocumentStore(uri="http://milvus.test:19530")

    assert store.verify_keyword_binding("wegent_kb_1", _binding()) is None

    with pytest.raises(IndexContractIncompatibleError):
        store.verify_keyword_binding("wegent_kb_1", _binding(analyzer=""))


class _ContractCheckClient:
    """Records the calls a contract verification makes on a live collection."""

    def __init__(self, *, dimension: int = 1536) -> None:
        self.dimension = dimension
        self.queries: list[dict] = []
        self.descriptions = 0

    def has_collection(self, collection_name: str, **kwargs) -> bool:
        return True

    def describe_collection(self, collection_name: str, **kwargs) -> dict:
        self.descriptions += 1
        return {
            "fields": [
                {
                    "name": DENSE_VECTOR_FIELD,
                    "params": {"dim": self.dimension},
                }
            ]
        }

    def query(self, **kwargs):
        self.queries.append(kwargs)
        return []


def test_verifying_a_read_contract_never_reads_the_registry_again():
    """One request reads the stored contract once and reuses it."""
    client = _ContractCheckClient()
    store = MilvusDocumentStore(uri="http://milvus.test:19530")

    store.verify_bound_contract(
        client,
        "wegent_kb_1",
        _binding(),
        dimension=1536,
        embedding_space="sha256:abc",
    )

    assert client.queries == []
    assert client.descriptions == 1


class _CollectionClient:
    """Minimal client stub for index-creation state transitions."""

    def __init__(self, *, collection_exists: bool) -> None:
        self.collection_exists = collection_exists

    def has_collection(self, collection_name: str, **kwargs) -> bool:
        return self.collection_exists


def _store_for_state(binding, *, collection_exists: bool):
    store = MilvusDocumentStore(uri="http://milvus.test:19530")
    store.read_binding = lambda client, name, *, consistency_level: binding
    store._assert_collection_dimension = lambda client, requested: None
    written: list[str] = []
    store.write_binding = lambda client, requested: written.append(
        requested.collection_name
    )
    created: list[str] = []
    store._create_collection = (
        lambda client, requested: created.append(requested.collection_name) or True
    )
    return store, written, created


def test_ensure_index_writes_the_binding_only_after_creating():
    """The creator owns the collection and is the only binding writer."""
    binding = _binding()
    store, written, created = _store_for_state(None, collection_exists=False)

    store.ensure_index(
        _CollectionClient(collection_exists=False),
        binding.collection_name,
        dimension=binding.dimension,
        embedding_space=binding.embedding_space,
    )

    assert written == [binding.collection_name]
    assert created == [binding.collection_name]


def test_ensure_index_still_rejects_an_unknown_collection():
    """A collection that exists without a contract is never adopted."""
    binding = _binding()
    store, written, _ = _store_for_state(None, collection_exists=True)

    with pytest.raises(IndexContractIncompatibleError):
        store.ensure_index(
            _CollectionClient(collection_exists=True),
            binding.collection_name,
            dimension=binding.dimension,
            embedding_space=binding.embedding_space,
        )

    assert written == []


def test_ensure_index_rejects_a_second_contract_inside_the_creation_window():
    """The creation window cannot be confirmed by a different contract.

    Contract A created the collection but has not written its binding yet.
    Contract B must not be able to confirm that physical collection just
    because the dimension matches, and neither may A: an interrupted creation
    fails loudly until an operator clears the empty collection.
    """
    binding = _binding()
    store, written, _ = _store_for_state(None, collection_exists=True)

    with pytest.raises(IndexContractIncompatibleError):
        store.ensure_index(
            _CollectionClient(collection_exists=True),
            binding.collection_name,
            dimension=binding.dimension,
            embedding_space="sha256:late-writer",
        )

    assert written == []

    # The original contract is rejected the same way: no silent adoption.
    with pytest.raises(IndexContractIncompatibleError):
        store.ensure_index(
            _CollectionClient(collection_exists=True),
            binding.collection_name,
            dimension=binding.dimension,
            embedding_space=binding.embedding_space,
        )

    assert written == []


def test_ensure_index_reports_a_missing_confirmed_index():
    """A ready contract whose collection disappeared must fail loudly."""
    binding = _binding()
    store, _, _ = _store_for_state(binding, collection_exists=False)

    with pytest.raises(IndexMissingError):
        store.ensure_index(
            _CollectionClient(collection_exists=False),
            binding.collection_name,
            dimension=binding.dimension,
            embedding_space=binding.embedding_space,
        )
