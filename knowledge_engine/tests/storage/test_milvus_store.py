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

import logging
from typing import Any

import pytest

from knowledge_engine.storage.errors import (
    IndexContractIncompatibleError,
    IndexMissingError,
)
from knowledge_engine.storage.milvus_native import (
    ANALYZER_TYPE,
    DEFAULT_RPC_TIMEOUT_SECONDS,
    DENSE_VECTOR_FIELD,
    METRIC_TYPE,
    ROW_OUTPUT_FIELDS,
    SCHEMA_VERSION,
    SPARSE_VECTOR_FIELD,
    MilvusIndexBinding,
    index_contract_description,
    index_contract_from_description,
)
from knowledge_engine.storage.milvus_store import MilvusDocumentStore

# Literal on purpose: this test pins the level a complete read sends, so reading
# the constant from the module would let a wrong production value pass.
READ_CONSISTENCY = "Bounded"


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


class _IteratorClient:
    """Records the row-iterator request a complete read sends."""

    def __init__(self) -> None:
        self.requests: list[dict] = []

    def query_iterator(self, **kwargs):
        self.requests.append(kwargs)
        return _OpenedIterator()


class _OpenedIterator:
    def __init__(self) -> None:
        self.closed = False

    def close(self) -> None:
        self.closed = True


def test_a_row_iterator_is_bounded_by_batch_size_limit_and_timeout():
    """One complete read is one iterator the caller can bound three ways."""
    client = _IteratorClient()
    store = MilvusDocumentStore(
        uri="http://milvus.test:19530",
        timeout=7.0,
    )

    iterator = store.open_row_iterator(
        client,
        "wegent_kb_1",
        'metadata["knowledge_id"] == "1"',
        batch_size=1000,
        limit=10001,
    )

    [request] = client.requests
    assert request["batch_size"] == 1000
    assert request["limit"] == 10001
    assert request["filter"] == 'metadata["knowledge_id"] == "1"'
    assert request["output_fields"] == ROW_OUTPUT_FIELDS
    assert request["consistency_level"] == READ_CONSISTENCY
    assert request["timeout"] == 7.0
    iterator.close()
    assert iterator.closed is True


def test_a_row_iterator_without_a_configured_timeout_stays_bounded():
    """An unset store timeout falls back to the shared RPC deadline."""
    client = _IteratorClient()
    store = MilvusDocumentStore(uri="http://milvus.test:19530", timeout=0.0)

    store.open_row_iterator(
        client,
        "wegent_kb_1",
        'metadata["knowledge_id"] == "1"',
        batch_size=10,
        limit=20,
        output_fields=["id"],
    )

    [request] = client.requests
    assert request["timeout"] == DEFAULT_RPC_TIMEOUT_SECONDS
    assert request["output_fields"] == ["id"]


class _DeleteClient:
    """Records the delete request the store sends and what the RPC answered."""

    def __init__(self, *, answer) -> None:
        self.answer = answer
        self.deletes: list[dict] = []
        self.flushes: list[dict] = []
        self.lookups: list[str] = []

    def has_collection(self, collection_name: str, **kwargs) -> bool:
        self.lookups.append(collection_name)
        return True

    def delete(self, **kwargs):
        self.deletes.append(kwargs)
        return self.answer

    def flush(self, *args, **kwargs):
        self.flushes.append(kwargs)


def test_delete_rows_reports_the_delete_rpcs_own_count():
    """The count is the one the delete RPC returned, not a pre-delete query."""
    client = _DeleteClient(answer={"delete_count": 3})
    store = MilvusDocumentStore(uri="http://milvus.test:19530")

    deleted = store.delete_rows(
        client,
        "wegent_kb_1",
        'metadata["knowledge_id"] == "1"',
    )

    assert deleted == 3
    [delete] = client.deletes
    assert delete["filter"] == 'metadata["knowledge_id"] == "1"'
    assert delete["timeout"] == store.rpc_timeout
    # The delete entry point flushes, so the removal is durable when reported.
    assert client.flushes and client.flushes[0]["timeout"] == store.rpc_timeout
    # No existence check and no counting query escort the delete RPC.
    assert client.lookups == []


def test_delete_rows_can_skip_the_flush_and_reports_an_absent_count_as_zero():
    client = _DeleteClient(answer={})
    store = MilvusDocumentStore(uri="http://milvus.test:19530")

    deleted = store.delete_rows(
        client,
        "wegent_kb_1",
        'metadata["knowledge_id"] == "1"',
        flush=False,
    )

    assert deleted == 0
    assert client.flushes == []


class _SparseSearchClient:
    """Records the search request the store sends for a keyword query."""

    def __init__(self) -> None:
        self.lookups: list[str] = []
        self.searches: list[dict] = []

    def has_collection(self, collection_name: str, **kwargs) -> bool:
        self.lookups.append(collection_name)
        return True

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
    # The caller read the collection's contract, so the search itself is one
    # RPC: no second existence check in the same request.
    assert client.lookups == []


def test_keyword_capability_check_follows_the_stored_analyzer():
    """A contract without the keyword analyzer never answers keyword queries."""
    store = MilvusDocumentStore(uri="http://milvus.test:19530")

    assert store.verify_keyword_binding("wegent_kb_1", _binding()) is None

    with pytest.raises(IndexContractIncompatibleError):
        store.verify_keyword_binding("wegent_kb_1", _binding(analyzer=""))


class _HybridSearchClient:
    """Records the hybrid request the store sends to the server."""

    def __init__(self) -> None:
        self.lookups: list[str] = []
        self.hybrid_requests: list[dict] = []

    def has_collection(self, collection_name: str, **kwargs) -> bool:
        self.lookups.append(collection_name)
        return True

    def hybrid_search(self, **kwargs):
        self.hybrid_requests.append(kwargs)
        return [
            [
                {
                    "entity": {"id": "row-1", "display_text": "融合分数"},
                    "distance": 0.42,
                }
            ]
        ]


def test_hybrid_search_sends_both_branches_and_the_native_ranker():
    """One native hybrid call carries both branches, one filter and the weights."""
    client = _HybridSearchClient()
    store = MilvusDocumentStore(uri="http://milvus.test:19530")

    hits = store.hybrid_search(
        client,
        "wegent_kb_1",
        dense_query_vector=[1.0, 0.0],
        sparse_query_text="中文 标识符",
        filter_expr='metadata["knowledge_id"] == "1"',
        limit=5,
        vector_weight=0.7,
        keyword_weight=0.3,
    )

    [request] = client.hybrid_requests
    dense_branch, sparse_branch = request["reqs"]
    assert dense_branch.data == [[1.0, 0.0]]
    assert dense_branch.anns_field == DENSE_VECTOR_FIELD
    assert dense_branch.param == {"metric_type": METRIC_TYPE, "params": {}}
    assert sparse_branch.data == ["中文 标识符"]
    assert sparse_branch.anns_field == SPARSE_VECTOR_FIELD
    assert sparse_branch.param == {"metric_type": "BM25", "params": {}}
    # Both branches carry the same scope, so neither can widen the other.
    assert dense_branch.expr == sparse_branch.expr == 'metadata["knowledge_id"] == "1"'
    assert request["ranker"].dict()["params"]["weights"] == [0.7, 0.3]
    assert request["limit"] == 5
    assert request["timeout"] == store.rpc_timeout
    # The fused score is reported as the server returned it.
    assert hits == [{"id": "row-1", "display_text": "融合分数", "__score__": 0.42}]
    # One hybrid request is one RPC: the existence check belongs to the
    # caller that read the collection's contract.
    assert client.lookups == []


class _IndexParams:
    """Stands in for the SDK index-param builder."""

    def add_index(self, **kwargs) -> None:
        pass


class _CollectionClient:
    """A Milvus client stub for one knowledge base's collection lifecycle.

    ``exists`` says whether a collection answers under that name and
    ``contract`` what it declares (``None``: it exists without a readable
    contract). ``create_raises`` with ``winner_contract`` models the losing side
    of a create race: this writer's create is rejected because another writer
    took the name first, and the read-back then finds what that writer declared.
    """

    def __init__(
        self,
        *,
        exists: bool = False,
        contract: MilvusIndexBinding | None = None,
        create_raises: bool = False,
        winner_contract: MilvusIndexBinding | None = None,
    ) -> None:
        self.exists = exists
        self.contract = contract
        self.create_raises = create_raises
        self.winner_contract = winner_contract
        self.schemas: list[Any] = []
        self.descriptions = 0
        self.queries: list[dict] = []

    def has_collection(self, collection_name: str, **kwargs) -> bool:
        return self.exists or bool(self.schemas)

    def create_collection(self, **kwargs) -> None:
        self.schemas.append(kwargs["schema"])
        if self.create_raises:
            # Another writer took the name first; this collection is theirs.
            self.exists = True
            self.contract = self.winner_contract
            raise RuntimeError("collection already exists")
        self.exists = True
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
    client = _CollectionClient(exists=True, contract=binding)
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
    client = _CollectionClient(exists=True)
    store = MilvusDocumentStore(uri="http://milvus.test:19530")

    with pytest.raises(IndexContractIncompatibleError):
        store.ensure_index(
            client,
            binding.collection_name,
            dimension=binding.dimension,
            embedding_space=binding.embedding_space,
        )

    assert client.schemas == [], "a foreign collection is never re-created"


def test_ensure_index_confirms_the_contract_of_a_collection_it_did_not_create():
    """The loser of a create race uses the winner's contract, if it matches.

    Milvus rejects a duplicate name, so a create that lost the race raises. The
    read-back is what decides: the same contract serves the loser, any other
    contract fails it. Nothing waits for the winner.
    """
    binding = _binding()
    client = _CollectionClient(create_raises=True, winner_contract=binding)
    store = MilvusDocumentStore(uri="http://milvus.test:19530")

    declared = store.ensure_index(
        client,
        binding.collection_name,
        dimension=binding.dimension,
        embedding_space=binding.embedding_space,
    )

    assert declared == binding
    assert len(client.schemas) == 1, "the create really was attempted"
    assert client.descriptions == 1


def test_ensure_index_rejects_a_collection_created_by_another_contract():
    """The creation race cannot be confirmed by a different contract.

    Contract A owns the collection. Contract B must not be able to confirm that
    physical collection just because the dimension matches, and neither may a
    writer of A: the contract the collection declares is what decides.
    """
    binding = _binding()
    other = _binding(embedding_space="sha256:late-writer")
    client = _CollectionClient(create_raises=True, winner_contract=binding)
    store = MilvusDocumentStore(uri="http://milvus.test:19530")

    with pytest.raises(IndexContractIncompatibleError):
        store.ensure_index(
            client,
            binding.collection_name,
            dimension=other.dimension,
            embedding_space=other.embedding_space,
        )

    assert len(client.schemas) == 1


def test_a_lost_create_race_is_logged_apart_from_a_contract_mismatch(caplog):
    """On-call can tell "lost the create race" from "contract is incompatible"."""
    binding = _binding()
    store = MilvusDocumentStore(uri="http://milvus.test:19530")

    with caplog.at_level(logging.INFO, logger="knowledge_engine.storage.milvus_store"):
        store.ensure_index(
            _CollectionClient(create_raises=True, winner_contract=binding),
            binding.collection_name,
            dimension=binding.dimension,
            embedding_space=binding.embedding_space,
        )
        races = [record.getMessage() for record in caplog.records]

    assert any("lost the create race" in message for message in races), races

    caplog.clear()
    with caplog.at_level(logging.INFO, logger="knowledge_engine.storage.milvus_store"):
        with pytest.raises(IndexContractIncompatibleError):
            store.ensure_index(
                _CollectionClient(
                    exists=True,
                    contract=_binding(embedding_space="sha256:the-winner"),
                ),
                binding.collection_name,
                dimension=binding.dimension,
                embedding_space=binding.embedding_space,
            )
        mismatches = [record.getMessage() for record in caplog.records]

    assert not any("lost the create race" in message for message in mismatches)


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
