# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for the bounded Milvus client layer (no server).

These cover ``MilvusDocumentStore``: client lifetimes, the RPC shape it sends,
and the index-contract state machine. The contract lives in the collection it
describes, so ``describe_collection`` is the only lookup involved. The row
layout and the filter vocabulary it works with are tested in
``test_milvus_native.py``.
"""

from typing import Any

import pytest

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
    index_contract_description,
    index_contract_from_description,
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
        assert store.read_contract(client, "wegent_kb_1") is None

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


class _IndexParams:
    """Stands in for the SDK index-param builder."""

    def add_index(self, **kwargs) -> None:
        pass


class _CollectionClient:
    """A collection that declares a contract, or none at all.

    ``create_raises`` models the losing side of a create race: the server
    rejects the duplicate name, and the collection that answers the read-back is
    the one the winner created.
    """

    def __init__(
        self,
        *,
        contract: MilvusIndexBinding | None = None,
        create_raises: bool = False,
    ) -> None:
        self.contract = contract
        self.create_raises = create_raises
        self.schemas: list[Any] = []
        self.descriptions = 0
        self.queries: list[dict] = []

    def has_collection(self, collection_name: str, **kwargs) -> bool:
        return self.contract is not None or bool(self.schemas)

    def create_collection(self, **kwargs) -> None:
        self.schemas.append(kwargs["schema"])
        if self.create_raises:
            raise RuntimeError("collection already exists")
        self.contract = index_contract_from_description(kwargs["schema"].description)

    def prepare_index_params(self):
        return _IndexParams()

    def describe_collection(self, collection_name: str, **kwargs) -> dict:
        self.descriptions += 1
        return {
            "description": (
                None
                if self.contract is None
                else index_contract_description(self.contract)
            ),
            "fields": [
                {
                    "name": DENSE_VECTOR_FIELD,
                    "params": {
                        "dim": (
                            None if self.contract is None else self.contract.dimension
                        )
                    },
                }
            ],
        }

    def query(self, **kwargs):
        self.queries.append(kwargs)
        return []


def test_confirming_a_read_contract_is_one_describe_and_no_registry_read():
    """One request reads the contract from the collection and reuses it."""
    store = MilvusDocumentStore(uri="http://milvus.test:19530")

    store.confirm_contract(
        "wegent_kb_1",
        _binding(),
        dimension=1536,
        embedding_space="sha256:abc",
    )


def test_confirming_a_read_contract_rejects_another_embedding_space():
    """A same-dimension model swap is an explicit failure, without an RPC."""
    store = MilvusDocumentStore(uri="http://milvus.test:19530")

    with pytest.raises(IndexContractIncompatibleError):
        store.confirm_contract(
            "wegent_kb_1",
            _binding(),
            dimension=1536,
            embedding_space="sha256:other",
        )


def test_ensure_index_creates_a_collection_that_declares_the_contract():
    """The creator owns the collection and the contract it carries."""
    binding = _binding()
    client = _CollectionClient()
    store = MilvusDocumentStore(uri="http://milvus.test:19530")

    declared = store.ensure_index(
        client,
        binding.collection_name,
        dimension=binding.dimension,
        embedding_space=binding.embedding_space,
    )

    assert declared == binding
    assert len(client.schemas) == 1
    # Creating reads the collection back once to confirm its own contract.
    assert client.descriptions == 1


def test_ensure_index_adopts_a_collection_that_declares_this_contract():
    """A compatible collection is used as it is; nothing is created."""
    binding = _binding()
    client = _CollectionClient(contract=binding)
    store = MilvusDocumentStore(uri="http://milvus.test:19530")

    declared = store.ensure_index(
        client,
        binding.collection_name,
        dimension=binding.dimension,
        embedding_space=binding.embedding_space,
    )

    assert declared == binding
    assert client.schemas == []
    assert client.descriptions == 1


def test_ensure_index_still_rejects_an_unknown_collection():
    """A collection that exists without a contract is never adopted."""
    binding = _binding()
    client = _CollectionClient(contract=None, create_raises=True)
    store = MilvusDocumentStore(uri="http://milvus.test:19530")

    with pytest.raises(IndexContractIncompatibleError):
        store.ensure_index(
            client,
            binding.collection_name,
            dimension=binding.dimension,
            embedding_space=binding.embedding_space,
        )


def test_ensure_index_confirms_the_contract_of_a_collection_it_did_not_create():
    """The loser of a create race uses the winner's contract, if it matches.

    Milvus rejects a duplicate name, so a create that lost the race raises. The
    read-back is what decides: the same contract serves the loser, any other
    contract fails it. Nothing waits for the winner.
    """
    binding = _binding()
    client = _CollectionClient(contract=binding, create_raises=True)
    store = MilvusDocumentStore(uri="http://milvus.test:19530")

    declared = store.ensure_index(
        client,
        binding.collection_name,
        dimension=binding.dimension,
        embedding_space=binding.embedding_space,
    )

    assert declared == binding
    assert client.descriptions == 1


def test_ensure_index_rejects_a_collection_created_by_another_contract():
    """The creation race cannot be confirmed by a different contract.

    Contract A owns the collection. Contract B must not be able to confirm that
    physical collection just because the dimension matches, and neither may a
    writer of A: the contract the collection declares is what decides.
    """
    binding = _binding()
    other = _binding(embedding_space="sha256:late-writer")
    client = _CollectionClient(contract=binding, create_raises=True)
    store = MilvusDocumentStore(uri="http://milvus.test:19530")

    with pytest.raises(IndexContractIncompatibleError):
        store.ensure_index(
            client,
            binding.collection_name,
            dimension=other.dimension,
            embedding_space=other.embedding_space,
        )

    assert client.schemas == []


def test_ensure_index_reports_a_collection_that_cannot_be_read_back():
    """A created collection that cannot be read back is a fault, not empty."""
    binding = _binding()
    store = MilvusDocumentStore(uri="http://milvus.test:19530")

    class _VanishingClient(_CollectionClient):
        def create_collection(self, **kwargs) -> None:
            # The create reports success and leaves nothing behind.
            pass

        def has_collection(self, collection_name: str, **kwargs) -> bool:
            return False

    with pytest.raises(IndexMissingError):
        store.ensure_index(
            _VanishingClient(),
            binding.collection_name,
            dimension=binding.dimension,
            embedding_space=binding.embedding_space,
        )
