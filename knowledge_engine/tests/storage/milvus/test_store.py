# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for the bounded Milvus client layer (no server).

These cover ``MilvusDocumentStore``: the shared connection it reuses, the RPC
shape it sends, and the index-contract state machine. The contract lives in the
collection it describes, so ``describe_collection`` is the only lookup a reader
involved; a writer also reads the index metadata, because the structure it
validates is not a claim the contract can make. The row layout and the filter
vocabulary it works with are tested in ``test_native.py``.
"""

from typing import Any

import pytest

from knowledge_engine.storage.milvus.errors import (
    IndexContractIncompatibleError,
    IndexMissingError,
)
from knowledge_engine.storage.milvus.native import (
    DEFAULT_RPC_TIMEOUT_SECONDS,
    DENSE_VECTOR_FIELD,
    HEAVY_RPC_TIMEOUT_SECONDS,
    METRIC_TYPE,
    ROW_OUTPUT_FIELDS,
    SCHEMA_VERSION,
    SPARSE_VECTOR_FIELD,
    MilvusIndexBinding,
    index_contract_from_description,
)
from knowledge_engine.storage.milvus.store import MilvusDocumentStore
from tests.storage.milvus.recorded_collection import (
    recorded_description,
    recorded_fields,
    recorded_indexes,
)

# Literal on purpose: this test pins the level a complete read sends, so reading
# the constant from the module would let a wrong production value pass.
READ_CONSISTENCY = "Bounded"
COLLECTION_NAME = "wegent_kb_1"


def _binding(**overrides):
    payload = {
        "schema_version": SCHEMA_VERSION,
        "embedding_space_id": "sha256:abc",
        "dimension": 1536,
    }
    payload.update(overrides)
    return MilvusIndexBinding(**payload)


def test_build_binding_pins_the_minimal_contract():
    """A requested contract carries the three facts compatibility needs."""
    store = MilvusDocumentStore(uri="http://milvus.test:19530")

    binding = store.build_binding(
        dimension=1536,
        embedding_space_id="sha256:abc",
    )

    assert binding == MilvusIndexBinding(
        schema_version=SCHEMA_VERSION,
        dimension=1536,
        embedding_space_id="sha256:abc",
    )


class _FakeClient:
    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.closed = False

    def close(self):
        self.closed = True

    def has_collection(self, collection_name, **kwargs):
        return False


def _aliases_recorded_by_factory(aliases: list[str], created: list[_FakeClient]):
    """A client factory that records the alias and the client it built."""

    def factory(**kwargs):
        aliases.append(kwargs["alias"])
        client = _FakeClient(**kwargs)
        created.append(client)
        return client

    return factory


def _open_one_operation(store: MilvusDocumentStore) -> None:
    with store.client():
        pass


def test_one_connection_identity_shares_one_alias():
    """One service, database and credential is one reused connection.

    The alias is what PyMilvus registers a connection under, so spelling the
    same service differently - an uppercase host, a trailing slash - must land
    on the same alias instead of opening a second connection.
    """
    aliases: list[str] = []
    factory = _aliases_recorded_by_factory(aliases, [])

    for uri, db_name, token in (
        ("http://milvus.test:19530", "kb", "reader:secret"),
        ("http://MILVUS.test:19530/", "kb", "reader:secret"),
    ):
        _open_one_operation(
            MilvusDocumentStore(
                uri=uri,
                db_name=db_name,
                token=token,
                client_factory=factory,
            )
        )

    assert len(set(aliases)) == 1, aliases


def test_a_different_service_database_or_credential_is_not_one_alias():
    """Authentication identity is part of the connection, not a detail.

    PyMilvus answers a second ``MilvusClient`` of the same alias from the
    connection it already registered, and it does not compare the credential,
    so two identities must never be handed the same alias.
    """
    aliases: list[str] = []
    factory = _aliases_recorded_by_factory(aliases, [])

    for uri, db_name, token in (
        ("http://milvus.test:19530", "kb", "reader:secret"),
        ("http://milvus.test:19531", "kb", "reader:secret"),
        ("http://milvus.test:19530", "other", "reader:secret"),
        ("http://milvus.test:19530", "kb", "reader:another-secret"),
    ):
        _open_one_operation(
            MilvusDocumentStore(
                uri=uri,
                db_name=db_name,
                token=token,
                client_factory=factory,
            )
        )

    assert len(set(aliases)) == 4, aliases


def test_credentials_inside_the_uri_stay_distinct_while_the_host_folds():
    """Only the host is case-insensitive: userinfo is an identity.

    A URI may carry its own credentials, and lowercasing the whole authority
    would fold two different identities into one alias while case-folding a
    host name is what makes two spellings of the same service meet.
    """
    aliases: list[str] = []
    factory = _aliases_recorded_by_factory(aliases, [])

    for uri in (
        "http://MILVUS.test:19530",
        "http://milvus.test:19530",
        "http://Reader:pw@milvus.test:19530",
        "http://reader:pw@milvus.test:19530",
    ):
        _open_one_operation(MilvusDocumentStore(uri=uri, client_factory=factory))

    upper_host, lower_host, reader_credential, other_credential = aliases
    assert upper_host == lower_host, "one service spelled two ways is one alias"
    assert (
        reader_credential != upper_host
    ), "a URI that carries a credential is another connection identity"
    assert (
        reader_credential != other_credential
    ), "two credentials in the URI are two identities"


def test_the_alias_never_carries_the_credential():
    """The alias identifies the credential without containing it."""
    aliases: list[str] = []
    factory = _aliases_recorded_by_factory(aliases, [])

    _open_one_operation(
        MilvusDocumentStore(
            uri="http://milvus.test:19530",
            token="reader:super-secret",
            client_factory=factory,
        )
    )

    [alias] = aliases
    assert "super-secret" not in alias
    assert "reader" not in alias


def test_operations_reuse_one_connection_and_close_none():
    """A bounded operation joins the shared connection and leaves it open.

    PyMilvus owns the connection the alias registers; closing the client an
    operation borrowed would tear that connection down under every other
    operation that reused the alias, so no operation closes it.
    """
    aliases: list[str] = []
    created: list[_FakeClient] = []
    store = MilvusDocumentStore(
        uri="http://milvus.test:19530",
        client_factory=_aliases_recorded_by_factory(aliases, created),
    )

    with store.client() as first:
        pass
    with store.client() as second:
        pass

    assert first is not second, "each operation is handed its own client object"
    assert created[0].closed is False
    assert created[1].closed is False
    assert aliases[0] == aliases[1]


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
    assert created[0].closed is False
    assert created[0].kwargs["db_name"] == "default"


def test_a_failing_operation_does_not_close_the_shared_connection():
    created: list[_FakeClient] = []

    def factory(**kwargs):
        client = _FakeClient(**kwargs)
        created.append(client)
        return client

    store = MilvusDocumentStore(uri="/tmp/milvus.db", client_factory=factory)

    with pytest.raises(RuntimeError):
        with store.client():
            raise RuntimeError("boom")

    assert created[0].closed is False


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

    def __init__(self, *, answer: dict[str, Any]) -> None:
        self.answer = answer
        self.deletes: list[dict[str, Any]] = []
        self.flushes: list[dict[str, Any]] = []
        self.lookups: list[str] = []

    def has_collection(self, collection_name: str, **kwargs: Any) -> bool:
        self.lookups.append(collection_name)
        return True

    def delete(self, **kwargs: Any) -> dict[str, Any]:
        self.deletes.append(kwargs)
        return self.answer

    def flush(self, *args: Any, **kwargs: Any) -> None:
        self.flushes.append(kwargs)


def test_delete_rows_reports_the_delete_rpcs_own_count() -> None:
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


def test_delete_rows_can_skip_the_flush_and_reports_an_absent_count_as_zero() -> None:
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
        self.searches: list[dict[str, Any]] = []

    def has_collection(self, collection_name: str, **kwargs: Any) -> bool:
        self.lookups.append(collection_name)
        return True

    def search(self, **kwargs: Any) -> list[list[dict[str, Any]]]:
        self.searches.append(kwargs)
        return [
            [
                {
                    "entity": {"id": "row-1", "display_text": "展示正文"},
                    "distance": 2.5,
                }
            ]
        ]


def test_keyword_search_uses_the_sparse_bm25_field_not_a_query_vector() -> None:
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


class _HybridSearchClient:
    """Records the hybrid request the store sends to the server."""

    def __init__(self) -> None:
        self.lookups: list[str] = []
        self.hybrid_requests: list[dict[str, Any]] = []

    def has_collection(self, collection_name: str, **kwargs: Any) -> bool:
        self.lookups.append(collection_name)
        return True

    def hybrid_search(self, **kwargs: Any) -> list[list[dict[str, Any]]]:
        self.hybrid_requests.append(kwargs)
        return [
            [
                {
                    "entity": {"id": "row-1", "display_text": "融合分数"},
                    "distance": 0.42,
                }
            ]
        ]


def test_hybrid_search_sends_both_branches_and_the_native_ranker() -> None:
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
    contract). ``create_fails`` models the losing side of a create race: this
    writer's create is rejected because another writer took the name first, so
    the name answers with ``winner_contract`` from then on.

    Everything else the stub answers was recorded from the pinned 2.5.4 server
    for the schema this code writes, so a test can replace one part of it - a
    dropped field, a missing index - and watch the writer refuse the rest.
    """

    def __init__(
        self,
        *,
        exists: bool = False,
        contract: MilvusIndexBinding | None = None,
        create_fails: bool = False,
        winner_contract: MilvusIndexBinding | None = None,
        fields: list[dict] | None = None,
        functions: list[dict] | None = None,
        indexes: dict[str, dict] | None = None,
        index_names: list[str] | None = None,
    ) -> None:
        self.exists = exists
        self.contract = contract
        self.create_fails = create_fails
        self.winner_contract = winner_contract
        self.fields = fields
        self.functions = functions
        self.indexes = indexes
        self.index_names = index_names
        self.schemas: list[Any] = []
        self.create_timeouts: list[Any] = []
        self.descriptions = 0
        self.index_lookups = 0
        self.queries: list[dict] = []

    def has_collection(self, collection_name: str, **kwargs) -> bool:
        return self.exists or bool(self.schemas)

    def create_collection(self, **kwargs) -> None:
        self.schemas.append(kwargs["schema"])
        self.create_timeouts.append(kwargs.get("timeout"))
        if self.create_fails:
            # Another writer took the name first; this collection is theirs.
            self.exists = True
            self.contract = self.winner_contract
            raise RuntimeError("create duplicate collection with different parameters")
        self.exists = True
        self.contract = index_contract_from_description(kwargs["schema"].description)

    def prepare_index_params(self):
        return _IndexParams()

    def describe_collection(self, collection_name: str, **kwargs) -> dict:
        self.descriptions += 1
        if not self.has_collection(collection_name):
            raise RuntimeError(f"collection {collection_name} does not exist")
        return recorded_description(
            self.contract,
            fields=self.fields,
            functions=self.functions,
        )

    def list_indexes(self, collection_name: str, **kwargs) -> list[str]:
        self.index_lookups += 1
        return list(self.index_names or self._indexes())

    def describe_index(self, collection_name: str, index_name: str, **kwargs) -> dict:
        return self._indexes()[index_name]

    def _indexes(self) -> dict[str, dict]:
        return dict(self.indexes if self.indexes is not None else recorded_indexes())

    def query(self, **kwargs):
        self.queries.append(kwargs)
        return []


def test_confirming_a_read_contract_compares_in_memory_without_an_rpc():
    """The contract was read from the collection, so confirming it costs no RPC."""
    client = _CollectionClient(exists=True, contract=_binding())

    def factory(**kwargs: Any) -> _CollectionClient:
        # The store is handed the one stub this test watches: confirming a
        # contract must not open a client at all, so no other is ever built.
        return client

    store = MilvusDocumentStore(
        uri="http://milvus.test:19530",
        client_factory=factory,
    )

    store.confirm_contract(
        "wegent_kb_1",
        _binding(),
        dimension=1536,
        embedding_space_id="sha256:abc",
    )

    assert client.descriptions == 0
    assert client.queries == []


def test_confirming_a_read_contract_rejects_another_embedding_space():
    """A same-dimension model swap is an explicit failure, without an RPC."""
    store = MilvusDocumentStore(uri="http://milvus.test:19530")

    with pytest.raises(IndexContractIncompatibleError):
        store.confirm_contract(
            "wegent_kb_1",
            _binding(),
            dimension=1536,
            embedding_space_id="sha256:other",
        )


def _ensure(store: MilvusDocumentStore, client: _CollectionClient, binding):
    return store.ensure_index(
        client,
        COLLECTION_NAME,
        dimension=binding.dimension,
        embedding_space_id=binding.embedding_space_id,
    )


def test_ensure_index_creates_a_collection_and_confirms_its_real_structure():
    """The creator reads its own collection back and checks what it is.

    A declaration is not a structure: the creator confirms the fields, the BM25
    function and the state of both indexes before it reports the index usable.
    """
    binding = _binding()
    client = _CollectionClient()
    store = MilvusDocumentStore(uri="http://milvus.test:19530")

    declared = _ensure(store, client, binding)

    assert declared == binding
    assert len(client.schemas) == 1
    assert client.descriptions == 1, "the created collection is read back once"
    assert client.index_lookups == 1, "the created indexes are read back"


def test_creating_a_collection_hands_the_sdk_an_integer_timeout():
    """The create budget is an int because the SDK only bounds int timeouts.

    ``MilvusClient.create_collection`` builds the index and waits for it in the
    same call, and PyMilvus enforces that wait loop's own total budget only
    when the timeout is an int. A float budget would leave the loop bounded by
    its per-RPC deadline alone, so the type is part of the contract.
    """
    binding = _binding()
    client = _CollectionClient()
    store = MilvusDocumentStore(uri="http://milvus.test:19530")

    _ensure(store, client, binding)

    [timeout] = client.create_timeouts
    assert timeout == HEAVY_RPC_TIMEOUT_SECONDS
    assert isinstance(timeout, int), "the wait loop is bounded only for an int"


def test_ensure_index_adopts_a_collection_that_declares_this_contract():
    """An existing collection is confirmed against its real structure."""
    binding = _binding()
    client = _CollectionClient(exists=True, contract=binding)
    store = MilvusDocumentStore(uri="http://milvus.test:19530")

    declared = _ensure(store, client, binding)

    assert declared == binding
    assert client.schemas == []
    assert client.descriptions == 1
    assert client.index_lookups == 1


def test_a_failed_create_is_reported_as_it_is():
    """A create that fails is the failure the caller sees.

    Milvus rejects a create that duplicates a name with different parameters.
    This writer does not read the name back to guess whether it won anyway: the
    rejection is raised, nothing is described, and no row can follow it.
    """
    binding = _binding()
    client = _CollectionClient(create_fails=True, winner_contract=binding)
    store = MilvusDocumentStore(uri="http://milvus.test:19530")

    with pytest.raises(RuntimeError, match="create duplicate collection"):
        _ensure(store, client, binding)

    assert len(client.schemas) == 1, "the create really was attempted"
    assert client.descriptions == 0, "the failure was not guessed into success"
    assert client.index_lookups == 0


def test_a_retry_adopts_the_collection_the_winner_created():
    """The loser of a create race is served by the next complete attempt.

    The collection the winner created declares the requested contract, so the
    retry reads it, validates its real structure and proceeds. Nothing about
    the failure is remembered: the retry is the ordinary adoption path.
    """
    binding = _binding()
    store = MilvusDocumentStore(uri="http://milvus.test:19530")
    with pytest.raises(RuntimeError):
        _ensure(
            store,
            _CollectionClient(create_fails=True, winner_contract=binding),
            binding,
        )
    retry_client = _CollectionClient(exists=True, contract=binding)

    declared = _ensure(store, retry_client, binding)

    assert declared == binding
    assert retry_client.schemas == [], "the retry creates nothing"
    assert retry_client.descriptions == 1
    assert retry_client.index_lookups == 1


def test_a_retry_refuses_the_collection_the_winner_created_otherwise():
    """The retry confirms the real collection, not the fact that it exists."""
    binding = _binding()
    winner = _binding(embedding_space_id="sha256:the-winner")
    store = MilvusDocumentStore(uri="http://milvus.test:19530")
    with pytest.raises(RuntimeError):
        _ensure(
            store,
            _CollectionClient(create_fails=True, winner_contract=winner),
            binding,
        )

    with pytest.raises(IndexContractIncompatibleError):
        _ensure(
            store,
            _CollectionClient(exists=True, contract=winner),
            binding,
        )


def test_ensure_index_still_rejects_an_unknown_collection():
    """A collection that exists without a contract is never adopted."""
    binding = _binding()
    client = _CollectionClient(exists=True)
    store = MilvusDocumentStore(uri="http://milvus.test:19530")

    with pytest.raises(IndexContractIncompatibleError):
        _ensure(store, client, binding)

    assert client.schemas == [], "a foreign collection is never re-created"
    assert client.index_lookups == 0, "a refused contract needs no index lookup"


def test_a_half_built_collection_missing_an_index_is_refused():
    """A create that registered the collection but not both indexes fails here.

    The contract can only say which schema version a collection claims to be,
    so an index that never finished is caught by reading the index metadata,
    not by trusting the claim.
    """
    binding = _binding()
    indexes = recorded_indexes()
    del indexes["sparse_vector"]
    client = _CollectionClient(exists=True, contract=binding, indexes=indexes)
    store = MilvusDocumentStore(uri="http://milvus.test:19530")

    with pytest.raises(IndexContractIncompatibleError) as failure:
        _ensure(store, client, binding)

    assert failure.value.retryable is False
    assert any(
        "sparse_vector" in mismatch and "no index" in mismatch
        for mismatch in failure.value.details["mismatches"]
    ), failure.value.details


def test_a_collection_whose_index_is_not_finished_is_refused():
    """An index still building cannot answer a search, so it is not usable."""
    binding = _binding()
    indexes = recorded_indexes()
    indexes["sparse_vector"]["state"] = "InProgress"
    client = _CollectionClient(exists=True, contract=binding, indexes=indexes)
    store = MilvusDocumentStore(uri="http://milvus.test:19530")

    with pytest.raises(IndexContractIncompatibleError) as failure:
        _ensure(store, client, binding)

    assert any(
        "sparse_vector" in mismatch and "InProgress" in mismatch
        for mismatch in failure.value.details["mismatches"]
    ), failure.value.details


def test_a_collection_whose_index_measures_differently_is_refused():
    """The metric decides what a score means, so a drifted one is not this index."""
    binding = _binding()
    indexes = recorded_indexes()
    indexes["dense_vector"]["metric_type"] = "L2"
    client = _CollectionClient(exists=True, contract=binding, indexes=indexes)
    store = MilvusDocumentStore(uri="http://milvus.test:19530")

    with pytest.raises(IndexContractIncompatibleError) as failure:
        _ensure(store, client, binding)

    assert any(
        "dense_vector" in mismatch and "L2" in mismatch
        for mismatch in failure.value.details["mismatches"]
    ), failure.value.details


def test_a_collection_holding_one_index_name_twice_is_refused():
    """More than one index under one name cannot be described, so it is refused.

    Two identical creates racing on the server can leave each index recorded
    twice, and the server then refuses to describe that name at all. Nothing
    here guesses which of the two answers would have been the right one: the
    index state of such a collection cannot be confirmed, so a writer fails
    instead of writing rows into it.
    """
    binding = _binding()
    client = _CollectionClient(
        exists=True,
        contract=binding,
        index_names=["dense_vector", "dense_vector", "sparse_vector"],
    )
    store = MilvusDocumentStore(uri="http://milvus.test:19530")

    with pytest.raises(IndexContractIncompatibleError) as failure:
        _ensure(store, client, binding)

    assert any(
        "dense_vector" in mismatch and "more than one" in mismatch
        for mismatch in failure.value.details["mismatches"]
    ), failure.value.details


def test_a_collection_whose_row_layout_differs_is_refused():
    """A column this schema writes is missing from the real collection."""
    binding = _binding()
    fields = [
        field
        for field in recorded_fields(binding.dimension)
        if field["name"] != "metadata"
    ]
    client = _CollectionClient(exists=True, contract=binding, fields=fields)
    store = MilvusDocumentStore(uri="http://milvus.test:19530")

    with pytest.raises(IndexContractIncompatibleError) as failure:
        _ensure(store, client, binding)

    assert any(
        "missing" in mismatch and "metadata" in mismatch
        for mismatch in failure.value.details["mismatches"]
    ), failure.value.details


@pytest.mark.parametrize(
    ("field_name", "property_name", "value"),
    [
        # The identity column carries the primary key rows are replaced by.
        ("id", "is_primary", False),
        # A shorter id column cannot hold the ids this schema writes into it.
        ("id", "max_length", 64),
        # The metadata column is written with a null value it must accept.
        ("metadata", "nullable", False),
    ],
)
def test_a_collection_whose_column_declares_another_property_is_refused(
    field_name: str, property_name: str, value: Any
) -> None:
    """A named column is this schema's column only with the properties it writes."""
    binding = _binding()
    fields = recorded_fields(binding.dimension)
    field = next(entry for entry in fields if entry["name"] == field_name)
    # The server answers the length among the field's parameters, the flags at
    # the field itself, so the difference is recorded where the server keeps it.
    location = field["params"] if property_name == "max_length" else field
    location[property_name] = value

    client = _CollectionClient(exists=True, contract=binding, fields=fields)
    store = MilvusDocumentStore(uri="http://milvus.test:19530")

    with pytest.raises(IndexContractIncompatibleError) as failure:
        _ensure(store, client, binding)

    assert any(
        f"field {field_name} has {property_name} {value}" in mismatch
        for mismatch in failure.value.details["mismatches"]
    ), failure.value.details


def test_a_collection_without_the_bm25_function_is_refused():
    """Keyword retrieval is a function of the collection, not of a reader."""
    binding = _binding()
    client = _CollectionClient(exists=True, contract=binding, functions=[])
    store = MilvusDocumentStore(uri="http://milvus.test:19530")

    with pytest.raises(IndexContractIncompatibleError) as failure:
        _ensure(store, client, binding)

    assert any(
        "retrieval_text_bm25" in mismatch
        for mismatch in failure.value.details["mismatches"]
    ), failure.value.details


def test_a_collection_that_analyzes_its_retrieval_text_differently_is_refused():
    """The analyzer decides which terms BM25 indexes, so it is checked."""
    binding = _binding()
    fields = recorded_fields(binding.dimension)
    retrieval_text = next(
        field for field in fields if field["name"] == "retrieval_text"
    )
    retrieval_text["params"]["analyzer_params"] = '{"type":"standard"}'
    client = _CollectionClient(exists=True, contract=binding, fields=fields)
    store = MilvusDocumentStore(uri="http://milvus.test:19530")

    with pytest.raises(IndexContractIncompatibleError) as failure:
        _ensure(store, client, binding)

    assert any(
        "retrieval_text" in mismatch and "standard" in mismatch
        for mismatch in failure.value.details["mismatches"]
    ), failure.value.details


def test_a_read_path_reads_the_contract_without_the_index_state():
    """A reader checks the capability it needs, not the physical structure."""
    binding = _binding()
    client = _CollectionClient(exists=True, contract=binding)
    store = MilvusDocumentStore(uri="http://milvus.test:19530")

    assert store.read_contract(client, COLLECTION_NAME) == binding

    assert client.descriptions == 1
    assert client.index_lookups == 0


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
        _ensure(store, _VanishingClient(), binding)
